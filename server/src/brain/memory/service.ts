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
import type { RetrievedEvidence, SourceExcerpt, SourceRegistration, SyncJob } from './types.js';

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
        this.store.saveSource({ ...source, status: 'pending' });
      }
    }
    if (this.options.schedule !== false) {
      this.timer = setInterval(() => {
        this.queueAll();
      }, this.syncInterval());
      this.timer.unref();
      this.pump();
    }
  }

  private syncInterval() {
    return this.options.syncMode === 'webhook'
      ? brainConfig.synchronization.reconcileIntervalMs
      : brainConfig.synchronization.pollIntervalMs;
  }

  async registerProjects() {
    const projects = await readProjects(this.options.projectsPath);
    const active = new Set<string>();
    for (const project of projects) {
      for (const specification of project.specs.filter((spec) => spec.kind === 'git')) {
        const id = `git:${sourceHash(`${project.id}:${specification.path}`)}`;
        active.add(id);
        const existing = this.store.source(id);
        if (!existing) {
          this.store.saveSource({
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
        this.store.saveSource({ ...source, approval: 'withdrawn', status: 'withdrawn' });
      }
    }
    return projects;
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

  private validatePolicy(
    value: Pick<SourceRegistration, 'projectIds' | 'shared' | 'mandatory' | 'approval'>,
    projects: Project[],
  ) {
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
  }

  async register(
    input: { pageId: string; title?: string } & Pick<
      SourceRegistration,
      'projectIds' | 'shared' | 'mandatory' | 'approval'
    >,
  ) {
    const projects = await this.registerProjects();
    this.validatePolicy(input, projects);
    const normalized = normalizePageId(
      requireText(input.pageId, brainConfig.projects.maxLocalPathCharacters),
    );
    const id = `notion:${normalized}`;
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
      status: input.approval === 'withdrawn' ? 'withdrawn' : 'pending',
    };
    this.store.saveSource(source);
    if (source.approval !== 'withdrawn') {
      this.queue(source.id);
    }
    return source;
  }

  async update(
    id: string,
    input: Pick<SourceRegistration, 'projectIds' | 'shared' | 'mandatory' | 'approval'>,
  ) {
    const source = this.store.source(id);
    if (!source) {
      fail('Memory source not found.', 404);
    }
    this.validatePolicy(input, await readProjects(this.options.projectsPath));
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
      status: input.approval === 'withdrawn' ? 'withdrawn' : 'pending',
    };
    this.store.saveSource(updated);
    if (updated.approval !== 'withdrawn') {
      this.queue(id);
    }
    return updated;
  }

  queue(sourceId: string) {
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
      this.pump();
      return queued;
    }
    const job: SyncJob = {
      id: randomUUID(),
      sourceId,
      status: 'queued',
      requestedAt: new Date().toISOString(),
      attempts: 0,
    };
    this.store.saveJob(job);
    this.pump();
    return job;
  }

  queueAll() {
    return this.store
      .sources()
      .filter((source) => source.approval !== 'withdrawn')
      .map((source) => this.queue(source.id))
      .filter(Boolean);
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
    while (
      this.store
        .jobs()
        .some((job) => sourceIds.has(job.sourceId) && ['queued', 'running'].includes(job.status))
    ) {
      if (this.stopped) {
        fail('Memory synchronization is stopping.');
      }
      await once(this.synchronization, 'progress');
    }
  }

  private async readSource(source: SourceRegistration) {
    if (source.kind === 'notion') {
      const page = await this.options.notion.fetchPage(source.pageId!);
      source.title = page.title;
      source.url = page.url;
      source.properties = page.properties;
      return makeCapture(source, page.content, page.properties, page.editedAt, page.raw);
    }
    if (source.kind === 'review') {
      return makeCapture(source, source.reviewContent!);
    }
    const projects = await readProjects(this.options.projectsPath);
    const project = projects.find((value) => value.id === source.git?.projectId);
    if (!project) {
      fail('The source project is no longer registered.');
    }
    const document = await captureGitDocument(project, source.git!.path);
    return makeCapture(source, document.content, {}, document.commit);
  }

  private async synchronize(job: SyncJob) {
    let source = this.store.source(job.sourceId);
    if (!source || source.approval === 'withdrawn') {
      this.store.saveJob({ ...job, status: 'succeeded', finishedAt: new Date().toISOString() });
      return;
    }
    const policy = JSON.stringify([
      source.projectIds,
      source.shared,
      source.approval,
      source.mandatory,
    ]);
    job = {
      ...job,
      status: 'running',
      startedAt: new Date().toISOString(),
      attempts: job.attempts + 1,
      error: undefined,
    };
    this.store.saveJob(job);
    this.store.saveSource({ ...source, status: 'syncing', error: undefined });
    try {
      const capture = await this.readSource(source);
      this.store.saveCapture(capture);
      const datasetId =
        source.approval === 'approved' ? await this.indexCapture(capture, source.id) : undefined;
      const latest = this.store.source(source.id)!;
      if (
        policy !==
        JSON.stringify([latest.projectIds, latest.shared, latest.approval, latest.mandatory])
      ) {
        fail('Source scope or approval changed during indexing. Synchronize the updated source.');
      }
      this.store.saveSource({
        ...latest,
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
      this.store.saveJob({ ...job, status: 'succeeded', finishedAt: new Date().toISOString() });
    } catch (error) {
      const message =
        error instanceof Error && 'statusCode' in error
          ? error.message
          : 'Synchronization failed. Check the source connection and Cognee service.';
      source = this.store.source(source.id)!;
      if (source.approval !== 'withdrawn') {
        this.store.saveSource({ ...source, status: 'failed', error: message });
      }
      this.store.saveJob({
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
      this.store.saveDataset(bindingId, legacy);
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
      this.store.saveDataset(bindingId, datasetId);
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
    if (!applicable.length) {
      fail('No approved sources are configured for this project.', 409);
    }
    const pendingSources = new Set(
      this.store
        .jobs()
        .filter((job) => ['queued', 'running'].includes(job.status))
        .map((job) => job.sourceId),
    );
    for (const source of applicable.filter((entry) => entry.kind !== 'git')) {
      const stale =
        !source.lastSyncedAt ||
        Date.now() - Date.parse(source.lastSyncedAt) > brainConfig.synchronization.maxFreshnessMs;
      if ((stale || source.status !== 'ready') && !pendingSources.has(source.id)) {
        this.queue(source.id);
      }
    }
    await this.waitForSources(
      new Set(applicable.filter((source) => source.kind !== 'git').map((source) => source.id)),
    );
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
      this.store.saveCapture(capture);
      const datasetId = await this.indexCapture(capture, registration.id);
      ready.push({ ...registration, currentSourceId: capture.id, datasetId, status: 'ready' });
    }
    const datasets = ready.map((source) => source.datasetId!);
    const hits = await this.options.cognee.search(query, datasets);
    const selected = new Map<string, { source: Source; excerpts: SourceExcerpt[] }>();
    function include(source: Source, startLine: number, endLine: number) {
      const entry = selected.get(source.id) ?? { source, excerpts: [] };
      entry.excerpts.push({ sourceId: source.id, startLine, endLine });
      selected.set(source.id, entry);
    }
    for (const registration of ready.filter((source) => source.mandatory)) {
      const source = this.store.capture(registration.currentSourceId!)!;
      include(source, 1, source.lines);
    }
    for (const hit of hits) {
      const registration = ready.find((source) => source.datasetId === hit.datasetId);
      const capture = registration && this.store.capture(registration.currentSourceId!);
      const position = capture?.content.indexOf(hit.text) ?? -1;
      if (!capture || !hit.text.trim() || position < 0) {
        fail('Retrieved evidence could not be verified against its captured source.');
      }
      const startLine = capture.content.slice(0, position).split('\n').length;
      const endLine =
        capture.content.slice(0, position + hit.text.length).split('\n').length -
        (hit.text.endsWith('\n') ? 1 : 0);
      include(capture, startLine, endLine);
    }
    const sources = [...selected.values()].map((entry) => entry.source);
    const excerpts: SourceExcerpt[] = [];
    let selectedBytes = 0;
    for (const entry of selected.values()) {
      const merged: SourceExcerpt[] = [];
      for (const excerpt of entry.excerpts.sort(
        (left, right) => left.startLine - right.startLine,
      )) {
        const previous = merged.at(-1);
        if (previous && excerpt.startLine <= previous.endLine + 1) {
          previous.endLine = Math.max(previous.endLine, excerpt.endLine);
        } else {
          merged.push({ ...excerpt });
        }
      }
      const lines = entry.source.content.split('\n');
      for (const excerpt of merged) {
        selectedBytes += Buffer.byteLength(
          lines.slice(excerpt.startLine - 1, excerpt.endLine).join('\n'),
        );
      }
      excerpts.push(...merged);
    }
    if (!sources.length) {
      fail('No applicable evidence was retrieved. This change has not been validated.', 409);
    }
    if (contextVersion !== this.contextVersion(project.id)) {
      fail('Source approval or scope changed during retrieval. Restart the analysis.', 409);
    }
    if (
      sources.length > brainConfig.analysis.maxSources ||
      selectedBytes > brainConfig.analysis.maxSourceBytes
    ) {
      fail(
        'Retrieved context exceeds the analysis budget. Narrow the project scope or mandatory sources.',
      );
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
      reviewContent: `# Human review\n\nProject: ${run.projectName}\nAnalysis: ${run.id}\nCommit: ${run.commit}\nDecision: ${review.decision}\nRecorded at: ${review.at}\nReviewer: ${review.actor}\n\n${review.note}\n\nApplies to the cited analysis and commit. This record does not modify the authoritative specification.\nSource: ${finding.decision.sourceId}, line ${finding.decision.line}\n`,
    };
    this.store.saveSource(source);
    this.queue(id);
  }

  async close() {
    this.stopped = true;
    this.synchronization.emit('progress');
    clearInterval(this.timer);
    await this.working;
    await this.indexing;
    this.store.close();
  }
}
