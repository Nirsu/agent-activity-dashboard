import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AccessStore, accessError } from '../access/store.js';
import {
  normalizeRepositoryRemote,
  type AuthorizedRepository,
  type BrainProjectStatus,
} from '../access/repositories.js';
import { brainConfig } from './config.js';
import { checkGithubAccess, githubRepositoryUrl } from './analysis/github.js';
import { readProjects, requireRepoPath, runGit } from './analysis/projects.js';
import { requireList, requireText } from './analysis/validation.js';
import type { Project } from './analysis/types.js';

type RepositoryInput = Omit<AuthorizedRepository, 'id' | 'createdAt'>;
type ReferenceStatus = { ready: boolean; message: string };
type CodeCheck = { fingerprint: string; ready: boolean; message: string; checkedAt: string };

const fingerprint = (project: Project) =>
  createHash('sha256').update(JSON.stringify(project)).digest('hex');
function isGithub(remote: string) {
  try {
    githubRepositoryUrl(remote);
    return true;
  } catch {
    return false;
  }
}

/** Projects owns repository identity and Brain scope; the JSON file is a one-time legacy import. */
export class ProjectRegistry {
  private referenceStatus?: (projectId: string) => ReferenceStatus;

  constructor(
    readonly access: AccessStore,
    readonly projectsPath: string,
    readonly cachePath: string,
    private readonly checkRemote = checkGithubAccess,
  ) {}

  async init() {
    const imported = this.access.storage.get('access_settings', 'brain-projects-imported-v1');
    const legacy = imported ? [] : await readProjects(this.projectsPath);
    await this.access.storage.transaction(async () => {
      if (!this.access.storage.get('access_settings', 'brain-projects-imported-v1')) {
        for (const project of legacy) {
          await this.access.storage.put('access_brain_projects', project.id, project, true);
        }
        await this.access.storage.put('access_settings', 'brain-projects-imported-v1', {
          importedAt: new Date().toISOString(),
        });
      }
      for (const repository of this.access.repositories()) {
        if (repository.brainProjectId && this.project(repository.brainProjectId)) {
          continue;
        }
        const project = this.newProject(repository, repository.brainProjectId);
        await this.access.storage.put('access_brain_projects', project.id, project);
        await this.access.saveRepository(
          { ...repository, brainProjectId: project.id },
          'project-registry-migration',
          repository.id,
        );
      }
    });
  }

  setReferenceStatus(read: (projectId: string) => ReferenceStatus) {
    this.referenceStatus = read;
  }

  private project(id: string) {
    return this.access.storage.get<Project>('access_brain_projects', id);
  }

  private cacheFor(remote: string) {
    return resolve(this.cachePath, createHash('sha256').update(remote).digest('hex'));
  }

  private newProject(input: RepositoryInput, id = `project-${randomUUID()}`): Project {
    return {
      id,
      name: input.name,
      scope:
        input.brainScope ||
        `Review changes to ${input.name} against its approved project and shared references.`,
      repoPath: this.cacheFor(input.remote),
      codePaths: input.brainCodePaths ?? ['**'],
      specs: [],
      repositoryRemote: input.remote,
    };
  }

  async projects(): Promise<Project[]> {
    const repositories = this.access.repositories();
    return this.access.storage
      .entries<Project>('access_brain_projects')
      .reverse()
      .map(({ data: project }) => {
        const linked = repositories.filter(
          (repository) => repository.brainProjectId === project.id,
        );
        return linked.length && linked.every((repository) => !repository.enabled)
          ? { ...project, enabled: false }
          : project;
      });
  }

  private status(repository: AuthorizedRepository, project?: Project): BrainProjectStatus {
    if (!repository.enabled) {
      return {
        state: 'disabled',
        message: 'Enable this project to accept activity and Brain analyses.',
      };
    }
    if (!project) {
      return {
        state: 'unverified',
        message: 'Brain registration is unavailable. Restart the server to complete migration.',
      };
    }
    if (project.repositoryRemote && !isGithub(project.repositoryRemote)) {
      return {
        state: 'unsupported',
        message:
          'Automatic code access supports GitHub repositories. The existing activity registration is preserved.',
      };
    }
    const check = this.access.storage.get<CodeCheck>(
      'access_settings',
      `brain-code-check:${project.id}`,
    );
    if (!check || check.fingerprint !== fingerprint(project)) {
      return {
        state: 'unverified',
        message:
          'Registered in Brain. Check code access; the first analysis will also retrieve its Git revision.',
      };
    }
    if (!check.ready) {
      return { state: 'needs_access', message: check.message, checkedAt: check.checkedAt };
    }
    const references = this.referenceStatus?.(project.id);
    if (!references?.ready) {
      return {
        state: 'needs_references',
        message:
          references?.message ??
          'Code access verified. Add and synchronize approved references in Brain Memory.',
        checkedAt: check.checkedAt,
      };
    }
    return {
      state: 'ready',
      message:
        'Code access verified and approved references available. Brain reads code on demand for each analysis.',
      checkedAt: check.checkedAt,
    };
  }

  repositoryView(repository: AuthorizedRepository) {
    const project = repository.brainProjectId ? this.project(repository.brainProjectId) : undefined;
    return {
      ...repository,
      brainScope: project?.scope,
      brainCodePaths: project?.codePaths,
      brainStatus: this.status(repository, project),
    };
  }

  repositories() {
    return this.access.repositories().map((repository) => this.repositoryView(repository));
  }

  projectStatus(projectId: string) {
    const linked = this.access.repositories().filter((entry) => entry.brainProjectId === projectId);
    const repository = linked.find((entry) => entry.enabled) ?? linked[0];
    return repository ? this.status(repository, this.project(projectId)) : undefined;
  }

  async save(input: RepositoryInput, actor: string, id?: string) {
    const remote = normalizeRepositoryRemote(input.remote);
    if (!remote) {
      accessError(
        'Enter a Git HTTPS or SSH repository URL without credentials, query or fragment.',
      );
    }
    const name = requireText(input.name.trim(), brainConfig.projects.maxNameCharacters);
    const scope = input.brainScope?.trim() ? requireText(input.brainScope.trim()) : undefined;
    const codePaths =
      input.brainCodePaths === undefined
        ? undefined
        : requireList(input.brainCodePaths, brainConfig.projects.maxCodePaths).map((path) => {
            if (path === '**') {
              return path;
            }
            const allowed = requireRepoPath(path);
            if (/[?*\[\]]/.test(allowed)) {
              accessError(
                'Use an exact file, a directory ending in /, or ** for all allowed code.',
              );
            }
            return allowed;
          });
    if (codePaths?.length === 0) {
      accessError('Select at least one allowed code path.');
    }
    return this.access.storage.transaction(async () => {
      const existing = id
        ? this.access.repositories().find((repository) => repository.id === id)
        : undefined;
      if (id && !existing) {
        accessError('Repository not found.', 404);
      }
      if (
        existing?.brainProjectId &&
        input.brainProjectId &&
        input.brainProjectId !== existing.brainProjectId
      ) {
        accessError(
          'A project keeps its Brain identity. Add a separate project to use another identity.',
        );
      }
      const projectId = existing?.brainProjectId || input.brainProjectId;
      let project = projectId ? this.project(projectId) : undefined;
      if (projectId && !project) {
        accessError('Select a registered Brain project.');
      }
      if (
        projectId &&
        existing?.brainProjectId !== projectId &&
        this.access
          .repositories()
          .some((repository) => repository.id !== id && repository.brainProjectId === projectId)
      ) {
        accessError('This Brain project is already linked to a repository.', 409);
      }
      if (
        !isGithub(remote) &&
        (!existing || existing.remote !== remote) &&
        (!project || project.repositoryRemote)
      ) {
        accessError('Use a GitHub repository for automatic Brain code access.');
      }
      if (!project) {
        if ((await this.projects()).length >= brainConfig.projects.maxProjects) {
          accessError('Brain project limit reached.');
        }
        project = this.newProject({
          ...input,
          name,
          remote,
          brainScope: scope,
          brainCodePaths: codePaths,
        });
      } else {
        if (!project.repositoryRemote && existing && existing.remote !== remote) {
          accessError(
            'This historical Brain project uses its configured local checkout. Add a separate project for a different repository.',
          );
        }
        // Preserve imported identity, specification approvals and code scope unless explicitly edited.
        project = {
          ...project,
          ...(project.repositoryRemote
            ? { name, repositoryRemote: remote, repoPath: this.cacheFor(remote) }
            : {}),
          ...(scope === undefined ? {} : { scope }),
          ...(codePaths === undefined ? {} : { codePaths }),
        };
      }
      await this.access.storage.put('access_brain_projects', project.id, project);
      const repository = await this.access.saveRepository(
        { name, remote, enabled: input.enabled, brainProjectId: project.id },
        actor,
        id,
      );
      return this.repositoryView(repository);
    });
  }

  async check(id: string) {
    const repository = this.access.repositories().find((entry) => entry.id === id);
    const project = repository?.brainProjectId
      ? this.project(repository.brainProjectId)
      : undefined;
    if (!repository || !project) {
      accessError('Project not found.', 404);
    }
    if (!repository.enabled || (project.repositoryRemote && !isGithub(project.repositoryRemote))) {
      return this.repositoryView(repository);
    }
    let ready = false;
    let message = '';
    try {
      if (project.repositoryRemote) {
        await this.checkRemote(project.repositoryRemote);
      } else {
        await runGit(project, ['rev-parse', '--verify', 'HEAD^{commit}']);
      }
      ready = true;
    } catch {
      message = project.repositoryRemote
        ? 'GitHub code access failed. Check the repository and the server BRAIN_GITHUB_TOKEN read permission, then retry.'
        : 'The preserved local checkout is unavailable on the Brain server. Restore its Git repository and retry.';
    }
    await this.access.storage.put('access_settings', `brain-code-check:${project.id}`, {
      fingerprint: fingerprint(project),
      ready,
      message,
      checkedAt: new Date().toISOString(),
    } satisfies CodeCheck);
    const current = this.access.repositories().find((entry) => entry.id === id)!;
    return this.repositoryView(current);
  }
}
