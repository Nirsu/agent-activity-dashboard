import { brainConfig } from '../config.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { makeSource } from '../sources.js';
import type { AnalysisRun, Project } from './types.js';
import { fail, requireList, requireObject, requireText } from './validation.js';

const executeFile = promisify(execFile);
const sensitivePath =
  /(^|\/)(\.git|\.env[^/]*|[^/]*(?:secret|credential|private[-_]?key)[^/]*|node_modules|dist|build)(\/|$)|\.(pem|key|p12|pfx)$/i;

function requireRepoPath(value: unknown): string {
  const path = requireText(value, brainConfig.projects.maxGitPathCharacters);
  const containsTraversal = path.split('/').some((segment) => segment === '..' || segment === '.');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    containsTraversal ||
    sensitivePath.test(path)
  ) {
    fail('Git path is not allowed in the configured scope.');
  }
  return path;
}

export async function readProjects(projectsPath: string): Promise<Project[]> {
  let raw: string;
  try {
    raw = await readFile(projectsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const entries = requireList(JSON.parse(raw), brainConfig.projects.maxProjects);
  const root = dirname(projectsPath);
  const projects = entries.map((value) => {
    const project = requireObject(value);
    const id = requireText(project.id, brainConfig.projects.maxIdCharacters);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      fail('Invalid project ID.');
    }

    const specs = requireList(project.specs, brainConfig.projects.maxSpecifications).map(
      (value) => {
        const specification = requireObject(value);
        if (specification.kind !== 'notion' && specification.kind !== 'git') {
          fail('Invalid specification type.');
        }
        return {
          kind: specification.kind as 'notion' | 'git',
          path:
            specification.kind === 'git'
              ? requireRepoPath(specification.path)
              : resolve(
                  root,
                  requireText(specification.path, brainConfig.projects.maxLocalPathCharacters),
                ),
        };
      },
    );

    const codePaths = requireList(project.codePaths, brainConfig.projects.maxCodePaths).map(
      requireRepoPath,
    );
    if (specs.length === 0 || codePaths.length === 0) {
      fail('Each project must define its specifications and code paths.');
    }

    // Keep this field order stable: the serialized configuration versions saved runs.
    return {
      id,
      name: requireText(project.name, brainConfig.projects.maxNameCharacters),
      scope: requireText(project.scope),
      repoPath: resolve(
        root,
        requireText(project.repoPath, brainConfig.projects.maxLocalPathCharacters),
      ),
      codePaths,
      specs,
    };
  });

  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    fail('Duplicate project IDs.');
  }
  return projects;
}

async function runGit(project: Project, args: string[]): Promise<string> {
  const { stdout } = await executeFile(
    process.env.BRAIN_GIT_BINARY ?? 'git',
    ['-C', project.repoPath, ...args],
    {
      encoding: 'utf8',
      timeout: brainConfig.git.timeoutMs,
      maxBuffer: brainConfig.git.maxBufferBytes,
      windowsHide: true,
    },
  );
  return stdout;
}

export async function captureProjectSources(
  run: AnalysisRun,
  project: Project,
  projectsPath: string,
) {
  run.commit = (
    await runGit(project, ['rev-parse', '--verify', `${run.commit ?? 'HEAD'}^{commit}`])
  ).trim();

  const tree = await runGit(project, ['ls-tree', '-rz', '--full-tree', run.commit]);
  const entries = tree
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\t');
      return {
        metadata: entry.slice(0, separator),
        path: entry.slice(separator + 1),
      };
    });
  const files = entries
    .filter((entry) => /^100(?:644|755) blob /.test(entry.metadata))
    .map((entry) => entry.path);

  if (run.baseCommit) {
    await runGit(project, ['merge-base', '--is-ancestor', run.baseCommit, run.commit]);
    const changedFiles = await runGit(project, [
      'diff',
      '--name-only',
      '-z',
      run.baseCommit,
      run.commit,
      '--',
    ]);
    run.changedFiles = changedFiles.split('\0').filter(Boolean);
  }

  let capturedBytes = 0;
  function addSource(kind: 'notion' | 'code', path: string, raw: string, isSpecification: boolean) {
    capturedBytes += Buffer.byteLength(raw);
    if (
      capturedBytes > brainConfig.analysis.maxSourceBytes ||
      raw.includes('\0') ||
      run.sources.length >= brainConfig.analysis.maxSources
    ) {
      fail('Scope is too large or contains a binary file: narrow the paths before analysis.');
    }

    const source = makeSource(kind, path, raw, kind === 'code' ? run.commit : undefined);
    if (isSpecification && kind === 'notion' && source.status !== 'published') {
      fail('A Notion specification is not marked “Statut: Publié” in its export.');
    }

    source.id = createHash('sha256')
      .update(`${project.id}:${isSpecification ? 'spec' : 'code'}:${source.id}`)
      .digest('hex');
    source.status = isSpecification ? 'published' : 'observed';
    source.topic = project.name;
    run.sources.push(source);
  }

  for (const specification of project.specs) {
    if (specification.kind === 'git') {
      if (!files.includes(specification.path)) {
        fail('Git specification is missing from the commit or is a symbolic link.');
      }
      const content = await runGit(project, ['show', `${run.commit}:${specification.path}`]);
      addSource('code', specification.path, content, true);
    } else {
      const info = await lstat(specification.path);
      if (info.size > brainConfig.analysis.maxSourceBytes || !info.isFile()) {
        fail('Notion export is too large or is a symbolic link.');
      }
      const path = relative(dirname(projectsPath), specification.path).replace(/\\/g, '/');
      const content = await readFile(specification.path, 'utf8');
      addSource('notion', path, content, true);
    }
  }

  const selectedFiles = files.filter((path) => {
    const isAllowed = project.codePaths.some((prefix) =>
      prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
    );
    const isSpecification = project.specs.some(
      (specification) => specification.kind === 'git' && specification.path === path,
    );
    const isWithinRevisionScope = !run.baseCommit || run.changedFiles.includes(path);
    return isAllowed && !sensitivePath.test(path) && !isSpecification && isWithinRevisionScope;
  });

  if (selectedFiles.length === 0 && !run.baseCommit) {
    fail('No code files in the configured scope.');
  }
  for (const path of selectedFiles) {
    const content = await runGit(project, ['show', `${run.commit}:${path}`]);
    addSource('code', path, content, false);
  }
}
