import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { brainConfig } from '../config.js';
import { readProjects } from '../analysis/projects.js';
import { fail, requireText } from '../analysis/validation.js';
import type { AnalysisRun, Finding, HumanReview, Project } from '../analysis/types.js';
import type { NotionConnection } from '../notion/service.js';
import type { CogneeClient } from '../cognee/client.js';
import { minimizeSourceContent, type Source } from '../sources.js';
import { normalizePageId } from '../notion/page.js';
import { captureGitDocument, makeCapture, sourceHash } from './capture.js';
import { MemoryStore } from './store.js';
import { selectCapturedEvidence } from './evidence.js';
import { inheritSubpagePolicy, reconcileSubpages, subpagesOf } from './subpages.js';
import type { RetrievedEvidence, SourceRegistration, SourcePolicy, SyncJob } from './types.js';

function policyVersion(source: SourceRegistration) {
  return JSON.stringify([
    source.projectIds,
    source.shared,
    source.approval,
    source.mandatory,
    source.includeSubpages,
    source.autoApproveSubpages,
    source.parentSourceId,
    source.approvalBeforeRemoval,
  ]);
}

type Options = {
  dbPath: string;
  projectsPath: string;
  notion: Pick<NotionConnection, 'state' | 'fetchPage'>;
  cognee: Pick<CogneeClient, 'status' | 'index' | 'search' | 'graph'>;
  schedule?: boolean;
  syncMode?: 'poll' | 'webhook';
};

export class MemoryService {
  readonly store: MemoryStore;
  readonly indexVersion = sourceHash(
    JSON.stringify({
      pipeline: brainConfig.cognee.indexRevision,
      model: process.env.COGNEE_LLM_MODEL ?? `openai/${process.env.BRAIN_MODEL || 'gpt-5.6-luna'}`,
      embeddings: process.env.COGNEE_EMBEDDING_MODEL ?? 'openai/text-embedding-3-small',
      dimensions: process.env.COGNEE_EMBEDDING_DIMENSIONS ?? '1536',
    }),
  );
  private working: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private indexing: Promise<unknown> = Promise.resolve();
  private readonly synchronization = new EventEmitter();
  private cogneeState = {
    configured: false,
    available: false,
    reason: 'Connection has not been checked.',
  };

  constructor(readonly options: Options) {
    this.store = new MemoryStore(options.dbPath);
  }

  async init() {
    await this.store.init();
    await this.registerProjects();
    for (const source of this.store.sources()) {
      const capture =
        source.kind === 'git' && source.currentSourceId
          ? this.store.capture(source.currentSourceId)
          : undefined;
      const needsMinimization =
        capture && minimizeSourceContent(capture.content) !== capture.content;
      if (
        source.approval === 'approved' &&
        source.datasetId &&
        (source.indexVersion !== this.indexVersion || needsMinimization)
      ) {
        await this.store.saveSource({ ...source, status: 'pending' });
      }
    }
    if (this.options.schedule !== false) {
      this.timer = setInterval(() => {
        void this.queueAll().catch(() => {
          this.stopped = true;
        });
      }, this.syncInterval());
      this.timer.unref();
      this.store.afterCommit(() => this.pump());
    }
  }

  private syncInterval() {
    return this.options.syncMode === 'webhook'
      ? brainConfig.synchronization.reconcileIntervalMs
      : brainConfig.synchronization.pollIntervalMs;
  }

  async registerProjects() {
    const projects = await readProjects(this.options.projectsPath);
    return this.store.transaction(async () => {
      const active = new Set<string>();
      for (const project of projects) {
        for (const specification of project.specs.filter((spec) => spec.kind === 'git')) {
          const id = `git:${sourceHash(`${project.id}:${specification.path}`)}`;
          active.add(id);
          const existing = this.store.source(id);
          if (!existing) {
            await this.store.saveSource({
              id,
              kind: 'git',
              title: specification.path,
              git: { projectId: project.id, path: specification.path },
              projectIds: [project.id],
              shared: false,
              mandatory: true,
              approval: 'approved',
              status: 'pending',
            });
          }
        }
      }
      for (const source of this.store.sources()) {
        if (source.kind === 'git' && !active.has(source.id) && source.approval !== 'withdrawn') {
          await this.store.saveSource({ ...source, approval: 'withdrawn', status: 'withdrawn' });
        }
      }
      return projects;
    });
  }

  async state() {
    const projects = await this.registerProjects();
    return {
      sources: this.store.sources().map(({ reviewContent, ...source }) => source),
      jobs: this.store.jobs().slice(0, brainConfig.synchronization.maxRecentJobs),
      cognee: this.cogneeState,
      notion: await this.options.notion.state(),
      projects: projects.map(({ id, name }) => ({ id, name })),
      syncIntervalMs: this.syncInterval(),
    };
  }

  async checkConnection() {
    const result = await this.options.cognee.status();
    this.cogneeState = { ...result, reason: result.reason ?? '' };
    return this.cogneeState;
  }

  private validatePolicy(value: SourcePolicy, projects: Project[]) {
    if (
      !Array.isArray(value.projectIds) ||
      value.projectIds.length > brainConfig.projects.maxProjects ||
      value.projectIds.some(
        (id) => typeof id !== 'string' || !projects.some((project) => project.id === id),
      )
    ) {
      fail('Every source project must be registered.');
    }
    if (
      typeof value.shared !== 'boolean' ||
      typeof value.mandatory !== 'boolean' ||
      !['draft', 'approved', 'withdrawn'].includes(value.approval)
    ) {
      fail('Invalid source approval or scope.');
    }
    if (!value.shared && value.projectIds.length === 0) {
      fail('Select a project or explicitly share this source.');
    }
    if (
      (value.includeSubpages !== undefined && typeof value.includeSubpages !== 'boolean') ||
      (value.autoApproveSubpages !== undefined && typeof value.autoApproveSubpages !== 'boolean') ||
      (value.autoApproveSubpages && !value.includeSubpages)
    ) {
      fail('Automatic subpage approval requires subpage discovery.');
    }
  }

  async register(input: { pageId: string; title?: string } & SourcePolicy) {
    const projects = await this.registerProjects();
    this.validatePolicy(input, projects);
    const normalized = normalizePageId(
      requireText(input.pageId, brainConfig.projects.maxLocalPathCharacters),
    );
    const id = `notion:${normalized}`;
    return this.store.transaction(async () => {
      if (this.store.source(id)) {
        fail('This page is already registered. Edit its project scope instead.', 409);
      }
      if (this.store.sources().length >= brainConfig.synchronization.maxSources) {
        fail('Source limit reached.');
      }
      const source: SourceRegistration = {
        id,
        kind: 'notion',
        pageId: normalized,
        title: input.title
          ? requireText(input.title, brainConfig.analysis.maxTitleCharacters)
          : 'Notion page',
        url: `https://www.notion.so/${normalized}`,
        projectIds: [...new Set(input.projectIds)],
        shared: input.shared,
        mandatory: input.mandatory,
        approval: input.approval,
        includeSubpages: input.includeSubpages ?? false,
        autoApproveSubpages: input.autoApproveSubpages ?? false,
        status: input.approval === 'withdrawn' ? 'withdrawn' : 'pending',
      };
      await this.store.saveSource(source);
      if (source.approval !== 'withdrawn') {
        await this.queue(source.id);
      }
      return source;
    });
  }

  async update(id: string, input: SourcePolicy) {
    const projects = await readProjects(this.options.projectsPath);
    return this.store.transaction(async () => {
      const source = this.store.source(id);
      if (!source) {
        fail('Memory source not found.', 404);
      }
      const policy = {
        ...input,
        includeSubpages: input.includeSubpages ?? source.includeSubpages ?? false,
        autoApproveSubpages: input.autoApproveSubpages ?? source.autoApproveSubpages ?? false,
      };
      this.validatePolicy(policy, projects);
      if (source.kind !== 'notion' && (policy.includeSubpages || policy.autoApproveSubpages)) {
        fail('Subpage settings only apply to Notion sources.');
      }
      if (source.parentSourceId) {
        if (source.approvalBeforeRemoval) {
          fail(
            'This subpage is outside the selected branch. Synchronize its parent before approving it.',
          );
        }
        if (
          policy.shared !== source.shared ||
          [...policy.projectIds].sort().join(',') !== [...source.projectIds].sort().join(',') ||
          policy.includeSubpages !== source.includeSubpages ||
          policy.autoApproveSubpages !== source.autoApproveSubpages
        ) {
          fail(
            'Subpages inherit their project and discovery settings. Edit the root page instead.',
          );
        }
      }
      if (
        source.kind === 'git' &&
        (input.shared ||
          input.projectIds.length !== 1 ||
          input.projectIds[0] !== source.git?.projectId)
      ) {
        fail('Git specifications stay scoped to their registered repository project.');
      }
      const updated: SourceRegistration = {
        ...source,
        projectIds: [...new Set(input.projectIds)],
        shared: input.shared,
        mandatory: input.mandatory,
        approval: input.approval,
        includeSubpages: policy.includeSubpages,
        autoApproveSubpages: policy.autoApproveSubpages,
        status: input.approval === 'withdrawn' ? 'withdrawn' : 'pending',
      };
      await this.store.saveSource(updated);
      if (updated.kind === 'notion') {
        await inheritSubpagePolicy(this.store, updated);
      }
      if (updated.approval !== 'withdrawn') {
        await this.queue(id);
      }
      return updated;
    });
  }

  async approveSubpages(id: string) {
    return this.store.transaction(async () => {
      const parent = this.store.source(id);
      if (
        !parent ||
        parent.kind !== 'notion' ||
        !parent.includeSubpages ||
        parent.approval === 'withdrawn'
      ) {
        fail('Select an active Notion branch with subpages enabled.');
      }
      const drafts = subpagesOf(this.store.sources(), id).filter(
        (source) => source.approval === 'draft',
      );
      for (const source of drafts) {
        await this.store.saveSource({ ...source, approval: 'approved', status: 'pending' });
        await this.queue(source.id);
      }
      return { approved: drafts.length };
    });
  }

  async queue(sourceId: string) {
    return this.store.transaction(() => this.queueJob(sourceId));
  }

  private async queueJob(sourceId: string) {
    const source = this.store.source(sourceId);
    if (!source) {
      fail('Memory source not found.', 404);
    }
    if (source.approval === 'withdrawn') {
      return undefined;
    }
    const queued = this.store
      .jobs()
      .find((job) => job.sourceId === sourceId && job.status === 'queued');
    if (queued) {
      this.store.afterCommit(() => this.pump());
      return queued;
    }
    const job: SyncJob = {
      id: randomUUID(),
      sourceId,
      status: 'queued',
      requestedAt: new Date().toISOString(),
      attempts: 0,
    };
    await this.store.saveJob(job);
    this.store.afterCommit(() => this.pump());
    return job;
  }

  async queueAll() {
    const jobs: SyncJob[] = [];
    for (const source of this.store
      .sources()
      .filter((source) => source.approval !== 'withdrawn' && !source.parentSourceId)) {
      const job = await this.queue(source.id);
      if (job) {
        jobs.push(job);
      }
    }
    return jobs;
  }

  private pump() {
    if (!this.working && !this.stopped) {
      // One durable queue and one writer for the embedded pilot storage.
      this.working = Promise.resolve()
        .then(() => this.drain())
        .finally(() => {
          this.working = null;
          if (!this.stopped && this.store.jobs().some((job) => job.status === 'queued')) {
            this.pump();
          }
        });
    }
  }

  private async drain() {
    while (!this.stopped) {
      const job = this.store
        .jobs()
        .reverse()
        .find((candidate) => candidate.status === 'queued');
      if (!job) {
        return;
      }
      await this.synchronize(job);
      this.synchronization.emit('progress');
    }
  }

  async wait() {
    while (this.working) {
      await this.working;
    }
  }

  private async waitForSources(sourceIds: Set<string>) {
    while (true) {
      const pendingScope = new Set(sourceIds);
      const registrations = this.store.sources();
      for (const id of sourceIds) {
        for (const child of subpagesOf(registrations, id)) {
          pendingScope.add(child.id);
        }
      }
      if (
        !this.store
          .jobs()
          .some(
            (job) => pendingScope.has(job.sourceId) && ['queued', 'running'].includes(job.status),
          )
      ) {
        return;
      }
      if (this.stopped) {
        fail('Memory synchronization is stopping.');
      }
      await once(this.synchronization, 'progress');
    }
  }

  private async readSource(source: SourceRegistration) {
    if (source.kind === 'notion') {
      const page = await this.options.notion.fetchPage(source.pageId!);
      if (source.parentSourceId) {
        const parent = this.store.source(source.parentSourceId);
        if (
          !parent?.includeSubpages ||
          parent.approval === 'withdrawn' ||
          page.parentPageId !== parent.pageId
        ) {
          fail(
            'The page is no longer a verified child of its registered parent. Synchronize the parent branch.',
          );
        }
      }
      source.title = page.title;
      source.url = page.url;
      source.properties = page.properties;
      return {
        capture: makeCapture(source, page.content, page.properties, page.editedAt, page.raw),
        page,
      };
    }
    if (source.kind === 'review') {
      return { capture: makeCapture(source, source.reviewContent!) };
    }
    const projects = await readProjects(this.options.projectsPath);
    const project = projects.find((value) => value.id === source.git?.projectId);
    if (!project) {
      fail('The source project is no longer registered.');
    }
    const document = await captureGitDocument(project, source.git!.path);
    return { capture: makeCapture(source, document.content, {}, document.commit) };
  }

  private async synchronize(job: SyncJob) {
    let source = this.store.source(job.sourceId);
    if (!source || source.approval === 'withdrawn') {
      await this.store.saveJob({
        ...job,
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
      });
      return;
    }
    const policy = policyVersion(source);
    job = {
      ...job,
      status: 'running',
      startedAt: new Date().toISOString(),
      attempts: job.attempts + 1,
      error: undefined,
    };
    try {
      await this.store.saveJob(job);
      await this.store.transaction(async () => {
        const current = this.store.source(source.id)!;
        if (policy !== policyVersion(current)) {
          fail('Source settings changed before capture. Synchronize the updated source.');
        }
        await this.store.saveSource({ ...current, status: 'syncing', error: undefined });
      });
      const { capture, page } = await this.readSource(source);
      await this.store.saveCapture(capture);
      if (policy !== policyVersion(this.store.source(source.id)!)) {
        fail('Source settings changed during capture. Synchronize the updated source.');
      }
      const datasetId =
        source.approval === 'approved' ? await this.indexCapture(capture, source.id) : undefined;
      const latest = this.store.source(source.id)!;
      if (policy !== policyVersion(latest)) {
        fail('Source scope or approval changed during indexing. Synchronize the updated source.');
      }
      const children = page
        ? await reconcileSubpages(this.store, latest, page, (id) =>
            this.options.notion.fetchPage(id),
          )
        : [];
      await this.store.transaction(async () => {
        const completed = this.store.source(source.id)!;
        if (policy !== policyVersion(completed)) {
          fail('Source settings changed during subpage discovery. Synchronize the updated source.');
        }
        await this.store.saveSource({
          ...completed,
          title: source.title,
          url: source.url,
          properties: source.properties,
          currentSourceId: capture.id,
          datasetId,
          indexVersion: this.indexVersion,
          revision: capture.revision,
          lastSyncedAt: new Date().toISOString(),
          status: source.approval === 'approved' ? 'ready' : 'pending',
          error: undefined,
        });
      });
      await this.store.saveJob({
        ...job,
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
      });
      for (const childId of children) {
        await this.queue(childId);
      }
    } catch (error) {
      const message =
        error instanceof Error && 'statusCode' in error
          ? error.message
          : 'Synchronization failed. Check the source connection and Cognee service.';
      await this.store.transaction(async () => {
        const current = this.store.source(source.id)!;
        if (policy === policyVersion(current) && current.approval !== 'withdrawn') {
          await this.store.saveSource({ ...current, status: 'failed', error: message });
        }
      });
      await this.store.saveJob({
        ...job,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
    }
  }

  applicable(projectId: string) {
    return this.store
      .sources()
      .filter(
        (source) =>
          source.approval === 'approved' &&
          (source.shared || source.projectIds.includes(projectId)),
      );
  }

  private async indexCapture(capture: Source, registrationId: string) {
    const bindingId = sourceHash(
      JSON.stringify([registrationId, capture.content, this.indexVersion]),
    );
    const cached = this.store.dataset(bindingId);
    if (cached) {
      return cached;
    }
    const legacy = this.store.dataset(`${capture.id}:${this.indexVersion}`);
    if (legacy) {
      await this.store.saveDataset(bindingId, legacy);
      return legacy;
    }
    const operation = this.indexing.then(async () => {
      const existing = this.store.dataset(bindingId);
      if (existing) {
        return existing;
      }
      if (this.stopped) {
        fail('Memory synchronization is stopping.');
      }
      const { datasetId } = await this.options.cognee.index(capture, `brain_${bindingId}`);
      await this.store.saveDataset(bindingId, datasetId);
      this.cogneeState = { configured: true, available: true, reason: '' };
      return datasetId;
    });
    this.indexing = operation.catch(() => undefined);
    return operation;
  }

  version(projectId: string) {
    // Reviews are context. Adding one must not make its own analysis obsolete.
    return sourceHash(
      this.indexVersion +
        JSON.stringify(
          this.applicable(projectId)
            .filter((source) => source.kind !== 'review')
            .map((source) => ({
              id: source.id,
              shared: source.shared,
              projectIds: source.projectIds,
              mandatory: source.mandatory,
              capture: source.kind === 'git' ? source.git?.path : source.currentSourceId,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        ),
    );
  }

  contextVersion(projectId: string) {
    return sourceHash(
      this.indexVersion +
        JSON.stringify(
          this.applicable(projectId)
            .map((source) => ({
              id: source.id,
              shared: source.shared,
              projectIds: source.projectIds,
              mandatory: source.mandatory,
              capture: source.kind === 'git' ? source.git?.path : source.currentSourceId,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        ),
    );
  }

  async retrieve(
    project: Project,
    query: string,
    gitSpecifications: Source[] = [],
  ): Promise<RetrievedEvidence> {
    await this.registerProjects();
    const applicable = this.applicable(project.id);
    const branches = this.store
      .sources()
      .filter(
        (source) =>
          source.kind === 'notion' &&
          !source.parentSourceId &&
          source.includeSubpages &&
          source.approval !== 'withdrawn' &&
          (source.shared || source.projectIds.includes(project.id)),
      );
    if (!applicable.length && !branches.some((source) => source.autoApproveSubpages)) {
      fail('No approved sources are configured for this project.', 409);
    }
    const pendingSources = new Set(
      this.store
        .jobs()
        .filter((job) => ['queued', 'running'].includes(job.status))
        .map((job) => job.sourceId),
    );
    const synchronized = new Map(
      [...applicable, ...branches]
        .filter((entry) => entry.kind !== 'git' && !entry.parentSourceId)
        .map((source) => [source.id, source]),
    );
    for (const source of synchronized.values()) {
      const stale =
        !source.lastSyncedAt ||
        Date.now() - Date.parse(source.lastSyncedAt) > brainConfig.synchronization.maxFreshnessMs;
      const needsSync =
        stale ||
        !source.currentSourceId ||
        source.status === 'failed' ||
        (source.approval === 'approved' && source.status !== 'ready');
      if (needsSync && !pendingSources.has(source.id)) {
        await this.queue(source.id);
      }
    }
    await this.waitForSources(new Set(synchronized.keys()));
    if (branches.some((source) => this.store.source(source.id)?.status === 'failed')) {
      fail(
        'Subpage discovery is incomplete. Check the branch synchronization before analysis.',
        409,
      );
    }
    const memoryVersion = this.version(project.id);
    const contextVersion = this.contextVersion(project.id);
    const ready = this.applicable(project.id).filter((entry) => entry.kind !== 'git');
    if (
      ready.some(
        (source) => source.status !== 'ready' || !source.datasetId || !source.currentSourceId,
      )
    ) {
      fail(
        'Project memory is not fully synchronized. Check failed or pending sources before analysis.',
        409,
      );
    }
    // Git specifications belong to the analyzed commit, never silently to current HEAD.
    for (const registration of this.applicable(project.id).filter(
      (entry) => entry.kind === 'git',
    )) {
      const supplied = gitSpecifications.find((source) => source.path === registration.git?.path);
      if (!supplied) {
        fail('The analysis did not capture a required Git specification at its commit.');
      }
      const capture = makeCapture(registration, supplied.content, {}, supplied.revision);
      await this.store.saveCapture(capture);
      const datasetId = await this.indexCapture(capture, registration.id);
      ready.push({ ...registration, currentSourceId: capture.id, datasetId, status: 'ready' });
    }
    const datasets = ready.map((source) => source.datasetId!);
    const hits = await this.options.cognee.search(query, datasets);
    const { sources, excerpts } = selectCapturedEvidence(
      ready.map((registration) => ({
        source: this.store.capture(registration.currentSourceId!)!,
        datasetId: registration.datasetId!,
        mandatory: registration.mandatory,
      })),
      hits,
    );
    if (contextVersion !== this.contextVersion(project.id)) {
      fail('Source approval or scope changed during retrieval. Restart the analysis.', 409);
    }
    return {
      sources,
      excerpts,
      datasets,
      sourceIds: sources.map((source) => source.id),
      retrievedAt: new Date().toISOString(),
      query,
      memoryVersion,
      contextVersion,
    };
  }

  async recordReview(run: AnalysisRun, finding: Finding, review: HumanReview) {
    const id = `review:${run.projectId}:${finding.id}`;
    const previous = this.store.source(id);
    const source: SourceRegistration = {
      ...previous,
      id,
      kind: 'review',
      title: `Human review: ${finding.title}`,
      projectIds: [run.projectId],
      shared: false,
      mandatory: false,
      approval: review.decision === 'investigate' ? 'draft' : 'approved',
      status: 'pending',
      reviewContent: `# Human review\n\nProject: ${run.projectName}\nAnalysis: ${run.id}\nCommit: ${run.commit}\n${run.submission ? `Submitted snapshot: ${run.submission.id}\nThe commit is its baseline, not the submitted code revision.\n` : ''}Decision: ${review.decision}\nRecorded at: ${review.at}\nReviewer: ${review.actor}\n\n${review.note}\n\nApplies to the cited analysis and captured code only. This record does not modify the authoritative specification.\nSource: ${finding.decision.sourceId}, line ${finding.decision.line}\n`,
    };
    await this.store.saveSource(source);
    await this.queue(id);
  }

  close() {
    this.stopped = true;
    this.synchronization.emit('progress');
    clearInterval(this.timer);
    this.closing ??= (async () => {
      try {
        await this.working;
      } finally {
        try {
          await this.indexing;
        } finally {
          await this.store.close();
        }
      }
    })();
    return this.closing;
  }
}
