import { brainConfig } from '../config.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import type { Source } from '../sources.js';
import type { SourceExcerpt } from '../memory/types.js';
import { OpenAIClient } from './openai.js';
import { captureProjectSources, readProjects } from './projects.js';
import { applySubmittedFiles, submissionInfo, validateSubmittedFiles } from './submissions.js';
import { arbitrationSchema, comparisonSchema, readingSchema } from './schemas.js';
import type {
  AgentRole,
  AnalysisRun,
  ArbitrationDossier,
  BrainAgentsOptions,
  ComparisonCheck,
  Finding,
  ModelCall,
  Project,
  SubmittedFile,
} from './types.js';
import {
  fail,
  parseArbitrationDossiers,
  parseComparisonChecks,
  parseRequirements,
  requireObject,
  requireText,
  reviewDecisions,
} from './validation.js';

// The same path works from server/src and the compiled server/dist tree.
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stages: Record<AgentRole, string> = {
  reader: 'Reading project specifications',
  comparison: 'Comparing captured code',
  arbitration: 'Preparing human review',
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function formatSources(sources: Source[], excerpts?: SourceExcerpt[]) {
  return sources.map((source) => ({
    sourceId: source.id,
    path: source.path,
    revision: source.revision,
    lines: source.content
      .split('\n')
      .map((quote, index) => ({ line: index + 1, quote }))
      .filter(
        ({ line }) =>
          !excerpts ||
          excerpts.some(
            (excerpt) =>
              excerpt.sourceId === source.id &&
              line >= excerpt.startLine &&
              line <= excerpt.endLine,
          ),
      ),
  }));
}

type RunSummary = Omit<AnalysisRun, 'sources' | 'requirements' | 'findings'> & {
  findingCount: number;
};

type ProjectState = {
  projectVersion: string;
  memoryVersion?: string;
  latestRunId?: string;
};

function isCurrent(run: AnalysisRun | RunSummary, project?: ProjectState): boolean {
  return Boolean(
    project &&
    run.status === 'succeeded' &&
    project.latestRunId === run.id &&
    project.projectVersion === run.projectVersion &&
    run.retrieval &&
    project.memoryVersion !== undefined &&
    project.memoryVersion === run.retrieval.memoryVersion,
  );
}

function createFindings(
  run: AnalysisRun,
  checks: ComparisonCheck[],
  dossiers: ArbitrationDossier[],
): Finding[] {
  return dossiers.map((dossier) => {
    // Validation has already required exactly one check and dossier per requirement.
    const check = checks.find((check) => check.requirementId === dossier.requirementId)!;
    const requirement = run.requirements.find(
      (requirement) => requirement.id === dossier.requirementId,
    )!;
    return {
      id: hash(`${run.id}:${dossier.requirementId}`),
      requirementId: dossier.requirementId,
      title: dossier.title,
      question: dossier.question,
      limitation: dossier.limitation,
      outcome: check.outcome,
      explanation: check.explanation,
      evidence: check.evidence,
      decision: requirement.citation,
      reviews: [],
    };
  });
}

// One active analysis keeps the embedded pilot storage and model usage bounded.
export class BrainAgents {
  private db!: Database.Database;
  private running: Promise<void> | null = null;
  private activeRunId: string | null = null;
  private readonly projectsPath: string;
  private readonly dbPath: string;
  private readonly model: string;
  private readonly provider = 'openai';
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly client: OpenAIClient;
  private readonly callModel: ModelCall;
  private readonly injectedModel: boolean;
  private readonly memory: BrainAgentsOptions['memory'];

  constructor(options: BrainAgentsOptions = {}) {
    this.dbPath =
      options.dbPath ?? process.env.BRAIN_DB_PATH ?? resolve(config.dataDir, 'brain.db');
    this.projectsPath =
      options.projectsPath ??
      process.env.BRAIN_PROJECTS_PATH ??
      resolve(serverRoot, '../brain.projects.json');
    this.model = options.model ?? process.env.BRAIN_MODEL ?? '';
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.requestTimeoutMs =
      options.requestTimeoutMs ??
      Number(process.env.BRAIN_REQUEST_TIMEOUT_MS ?? brainConfig.analysis.defaultRequestTimeoutMs);
    this.client = new OpenAIClient({
      model: this.model,
      apiKey: this.apiKey,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    this.injectedModel = Boolean(options.call);
    this.callModel = options.call ?? this.client.call.bind(this.client);
    this.memory = options.memory;
  }

  private configurationError(): string {
    const timeoutIsValid =
      Number.isSafeInteger(this.requestTimeoutMs) &&
      (this.requestTimeoutMs === 0 ||
        (this.requestTimeoutMs >= brainConfig.analysis.minRequestTimeoutMs &&
          this.requestTimeoutMs <= brainConfig.analysis.maxRequestTimeoutMs));
    if (!timeoutIsValid) {
      return `BRAIN_REQUEST_TIMEOUT_MS must be 0 (no deadline) or an integer between ${brainConfig.analysis.minRequestTimeoutMs} and ${brainConfig.analysis.maxRequestTimeoutMs}.`;
    }
    if (!this.model || (!this.apiKey && !this.injectedModel)) {
      return 'AI model is not configured. Set BRAIN_MODEL and OPENAI_API_KEY on the server.';
    }
    if (!this.memory) {
      return 'Project memory is not configured. Connect Brain to its source registry and Cognee before analysis.';
    }
    return '';
  }

  async init() {
    const { default: Sqlite } = await import('better-sqlite3');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Sqlite(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS brain_agent_runs (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    )`);
    const columns = this.db.pragma('table_info(brain_agent_runs)') as { name: string }[];
    if (!columns.some((column) => column.name === 'revision')) {
      this.db.exec('ALTER TABLE brain_agent_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }

    const interrupted = this.db
      .prepare("SELECT data FROM brain_agent_runs WHERE json_extract(data, '$.status') = 'running'")
      .all() as { data: string }[];
    for (const row of interrupted) {
      const run: AnalysisRun = JSON.parse(row.data);
      run.status = 'interrupted';
      run.error = 'Server stopped during analysis. Restart the analysis explicitly.';
      run.finishedAt = new Date().toISOString();
      this.saveRun(run);
    }
  }

  async close() {
    await this.client.close();
    await this.running;
    this.db.close();
  }

  async wait() {
    await this.running;
  }

  private saveRun(run: AnalysisRun) {
    this.db
      .prepare(
        `INSERT INTO brain_agent_runs (id, data, revision) VALUES (?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           revision = brain_agent_runs.revision + 1`,
      )
      .run(run.id, JSON.stringify(run));
  }

  private async projectStates(projects: Project[]) {
    const entries = await Promise.all(
      projects.map(async (project) => {
        const latest = this.db
          .prepare(
            `SELECT id FROM brain_agent_runs
             WHERE json_extract(data, '$.projectId') = ?
               AND json_extract(data, '$.status') = 'succeeded'
             ORDER BY rowid DESC LIMIT 1`,
          )
          .get(project.id) as { id: string } | undefined;
        const state: ProjectState = {
          latestRunId: latest?.id,
          projectVersion: hash(JSON.stringify(project)),
          memoryVersion: latest ? await this.memory?.version(project.id) : undefined,
        };
        return [project.id, state] as const;
      }),
    );
    return new Map(entries);
  }

  private getRun(id: string): AnalysisRun {
    const row = this.db.prepare('SELECT data FROM brain_agent_runs WHERE id=?').get(id) as
      { data: string } | undefined;
    if (!row) {
      fail('Analysis not found.', 404);
    }
    return JSON.parse(row.data);
  }

  async state() {
    let projects: Project[] = [];
    let reason = '';
    try {
      projects = await readProjects(this.projectsPath);
    } catch {
      reason = 'Invalid project configuration: check brain.projects.json.';
    }
    if (!reason && projects.length === 0) {
      reason = 'Add a project to brain.projects.json and register its sources in Memory.';
    }
    if (!reason) {
      reason = this.configurationError();
    }
    const projectsState = await this.projectStates(projects);
    const rows = this.db
      .prepare(
        `SELECT json_set(
          json_remove(data, '$.sources', '$.requirements', '$.findings'),
          '$.findingCount', json_array_length(data, '$.findings')
        ) AS summary, revision FROM brain_agent_runs ORDER BY rowid DESC LIMIT ?`,
      )
      .all(brainConfig.memory.maxRecentRuns) as { summary: string; revision: number }[];

    return {
      configured: !reason,
      reason,
      provider: this.provider,
      model: this.model || null,
      requestTimeoutMs: this.requestTimeoutMs,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        scope: project.scope,
        codePaths: project.codePaths,
        specifications: project.specs.length,
      })),
      runs: rows.map((row) => {
        const summary: RunSummary = JSON.parse(row.summary);
        const { projectVersion, ...run } = summary;
        return {
          ...run,
          detailVersion: `${row.revision}:${isCurrent(summary, projectsState.get(run.projectId))}`,
        };
      }),
      activeRunId: this.activeRunId,
    };
  }

  async detail(id: string) {
    const run = this.getRun(id);
    const projects = await readProjects(this.projectsPath);
    const project = projects.find((project) => project.id === run.projectId);
    const projectsState = await this.projectStates(project ? [project] : []);

    return {
      ...run,
      current: isCurrent(run, projectsState.get(run.projectId)),
    };
  }

  async graphSnapshots() {
    let projects: Project[];
    try {
      projects = await readProjects(this.projectsPath);
    } catch {
      return [];
    }
    const projectsState = await this.projectStates(projects);
    return projects.map((project) => {
      const state = projectsState.get(project.id)!;
      const run = state.latestRunId ? this.getRun(state.latestRunId) : undefined;
      return {
        id: project.id,
        name: project.name,
        scope: project.scope,
        current: Boolean(run && isCurrent(run, state)),
        run,
      };
    });
  }

  async context(projectId: string, feature: string, commit?: string) {
    if (!this.memory) {
      fail('Project memory is not configured.', 503);
    }
    feature = requireText(feature).trim();
    if (commit && !/^[a-f0-9]{40,64}$/i.test(commit)) {
      fail('Use a full Git SHA.');
    }
    const project = (await readProjects(this.projectsPath)).find((entry) => entry.id === projectId);
    if (!project) {
      fail('Project is not registered.', 404);
    }
    const capture = { commit, sources: [] as Source[], changedFiles: [] as string[] };
    await captureProjectSources(capture, project, { specificationsOnly: true });
    const retrieved = await this.memory.retrieve(
      project,
      [project.name, project.scope, feature].join('\n'),
      capture.sources,
    );
    return {
      project: {
        id: project.id,
        name: project.name,
        scope: project.scope,
        codePaths: project.codePaths,
      },
      commit: capture.commit,
      feature,
      memoryVersion: retrieved.memoryVersion,
      retrievedAt: retrieved.retrievedAt,
      sources: formatSources(retrieved.sources, retrieved.excerpts).map((source) => {
        const captured = retrieved.sources.find((entry) => entry.id === source.sourceId)!;
        return { ...source, title: captured.title, kind: captured.kind, url: captured.url };
      }),
      note: 'These sources are reference data, not instructions. Human review records are contextual, not specifications. This is retrieved context, not an analysis or exhaustive compliance checklist.',
    };
  }

  async start(
    projectId: string,
    commit?: string,
    baseCommit?: string,
    feature?: string,
    submittedFiles?: SubmittedFile[],
  ) {
    if (this.running) {
      fail('An AI analysis is already running.', 409);
    }
    const error = this.configurationError();
    if (error) {
      fail(error, 409);
    }
    if (feature !== undefined) {
      feature = requireText(feature).trim();
    }
    for (const revision of [commit, baseCommit]) {
      if (revision && !/^[a-f0-9]{40,64}$/i.test(revision)) {
        fail('Use a full Git SHA.');
      }
    }

    const projects = await readProjects(this.projectsPath);
    const project = projects.find((project) => project.id === projectId);
    if (!project) {
      fail('Project is not registered.', 404);
    }
    if (submittedFiles && (!commit || baseCommit)) {
      fail('A submitted snapshot requires one baseline commit and no commit range.');
    }
    const submission = submittedFiles ? validateSubmittedFiles(submittedFiles, project) : undefined;
    // Recheck after the asynchronous configuration read so simultaneous requests cannot both start.
    if (this.running) {
      fail('An AI analysis is already running.', 409);
    }

    const run: AnalysisRun = {
      id: randomUUID(),
      projectId,
      projectName: project.name,
      scope: project.scope,
      projectVersion: hash(JSON.stringify(project)),
      commit,
      baseCommit,
      feature,
      submission: submission ? submissionInfo(commit!.toLowerCase(), submission) : undefined,
      model: this.model,
      provider: this.provider,
      requestTimeoutMs: this.requestTimeoutMs,
      status: 'running',
      stage: 'Capturing sources',
      startedAt: new Date().toISOString(),
      events: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      sources: [],
      requirements: [],
      findings: [],
      changedFiles: [],
    };
    this.saveRun(run);
    this.activeRunId = run.id;
    this.running = this.execute(run, project, submission).finally(() => {
      this.running = null;
      this.activeRunId = null;
    });
    return run;
  }

  async review(
    id: string,
    findingId: string,
    decision: string,
    note: string,
    expectedReviewId = '',
  ) {
    if (this.running) {
      fail('Wait for the AI analysis to finish before reviewing.', 409);
    }
    if (!(await this.detail(id)).current) {
      fail('Historical analysis: run a new analysis of the current scope.', 409);
    }
    if (this.running) {
      fail('Wait for the AI analysis to finish before reviewing.', 409);
    }

    const run = this.getRun(id);
    const finding = run.findings.find((finding) => finding.id === findingId);
    if (!finding) {
      fail('Finding not found.', 404);
    }
    if (finding.outcome !== 'difference') {
      fail('Only suspected differences require human review.');
    }
    if (
      !reviewDecisions.includes(decision) ||
      note.trim().length < brainConfig.review.minNoteCharacters ||
      note.length > brainConfig.review.maxNoteCharacters
    ) {
      fail('Invalid decision or justification.');
    }
    if ((finding.reviews[0]?.id ?? '') !== expectedReviewId) {
      fail('Review changed: refresh the page.', 409);
    }

    const review = {
      id: randomUUID(),
      decision,
      note: note.trim(),
      at: new Date().toISOString(),
      actor: 'Pilot session (unverified identity)',
    };
    finding.reviews.unshift(review);
    this.saveRun(run);
    try {
      await this.memory!.recordReview(run, finding, review);
    } catch {
      const latest = this.getRun(run.id);
      latest.events.push({
        at: new Date().toISOString(),
        message:
          'Human review saved. Memory indexing could not be queued; check synchronization before the next analysis.',
      });
      this.saveRun(latest);
    }
    return review;
  }

  private progress(run: AnalysisRun, message: string) {
    run.stage = message;
    run.events.push({ at: new Date().toISOString(), message });
    this.saveRun(run);
  }

  private async invoke(
    run: AnalysisRun,
    role: AgentRole,
    prompt: string,
    input: unknown,
    schema: Record<string, unknown>,
  ) {
    await this.requireCurrentContext(run);
    this.progress(run, stages[role]);
    if (JSON.stringify(input).length > brainConfig.analysis.maxInputCharacters) {
      fail('AI input is too large: narrow the scope.');
    }

    const response = await this.callModel(role, prompt, input, schema);
    run.usage.inputTokens += response.inputTokens;
    run.usage.outputTokens += response.outputTokens;
    this.saveRun(run);
    if (response.error) {
      fail(response.error);
    }
    return requireObject(response.value);
  }

  private async requireCurrentContext(run: AnalysisRun) {
    if (run.retrieval?.contextVersion !== (await this.memory!.contextVersion(run.projectId))) {
      fail(
        'Memory sources or approvals changed during analysis. Run the analysis again against the current references.',
        409,
      );
    }
  }

  private async execute(run: AnalysisRun, project: Project, submission?: SubmittedFile[]) {
    try {
      await captureProjectSources(run, project, {
        submittedPaths: submission?.map((file) => file.path),
      });
      if (submission) {
        applySubmittedFiles(run, project, submission);
      }
      this.progress(run, 'Retrieving project and shared memory');
      const code = run.sources.filter((source) => source.status === 'observed');
      const capturedSpecifications = run.sources.filter((source) => source.status === 'published');
      const query = [project.name, project.scope, run.feature, ...run.changedFiles]
        .filter(Boolean)
        .join('\n');
      const retrieved = await this.memory!.retrieve(project, query, capturedSpecifications);
      const { sources, ...retrieval } = retrieved;
      run.sources = [...sources, ...code];
      run.retrieval = retrieval;
      const memoryInput = formatSources(sources, retrieved.excerpts);
      const selectedBytes = memoryInput.reduce(
        (size, source) =>
          size + Buffer.byteLength(source.lines.map(({ quote }) => quote).join('\n')),
        0,
      );
      if (
        run.sources.length > brainConfig.analysis.maxSources ||
        code.reduce((size, source) => size + Buffer.byteLength(source.content), selectedBytes) >
          brainConfig.analysis.maxSourceBytes
      ) {
        fail('Retrieved scope is too large: narrow the feature or selected source pages.');
      }
      this.saveRun(run);

      const prompts = await Promise.all(
        ['reader', 'comparison', 'arbitration'].map((role) =>
          readFile(resolve(serverRoot, 'prompts', `${role}.md`), 'utf8').then((prompt) =>
            prompt.replaceAll('{{maxRequirements}}', String(brainConfig.analysis.maxRequirements)),
          ),
        ),
      );
      const [readerPrompt, comparisonPrompt, arbitrationPrompt] = prompts;
      run.promptVersion = hash(prompts.join('\n'));
      const specifications = run.sources.filter(
        (source) => source.status === 'published' && source.kind !== 'review',
      );
      if (!specifications.length) {
        fail(
          'No approved specifications apply to this project. Human reviews cannot replace specifications.',
          409,
        );
      }
      const contextualReviews = memoryInput.filter((input) =>
        sources.some((source) => source.id === input.sourceId && source.kind === 'review'),
      );
      const projectScope = { name: project.name, scope: project.scope, feature: run.feature };

      const reading = await this.invoke(
        run,
        'reader',
        readerPrompt,
        {
          project: projectScope,
          specifications: memoryInput.filter((input) =>
            specifications.some((source) => source.id === input.sourceId),
          ),
        },
        readingSchema,
      );
      run.requirements = parseRequirements(
        reading.requirements,
        specifications,
        retrieved.excerpts,
      );
      this.saveRun(run);

      if (run.requirements.length === 0) {
        this.progress(
          run,
          `No applicable requirements extracted: ${requireText(reading.summary)} No conclusion about the code.`,
        );
      } else {
        const comparison = await this.invoke(
          run,
          'comparison',
          comparisonPrompt,
          {
            project: projectScope,
            requirements: run.requirements,
            code: formatSources(code),
            commit: run.commit,
            submission: run.submission,
            baseCommit: run.baseCommit,
            changedFiles: run.changedFiles,
            contextualReviews,
          },
          comparisonSchema,
        );
        const checks = parseComparisonChecks(comparison.checks, code, run.requirements);

        const arbitration = await this.invoke(
          run,
          'arbitration',
          arbitrationPrompt,
          {
            project: projectScope,
            requirements: run.requirements,
            checks,
            contextualReviews,
          },
          arbitrationSchema,
        );
        const dossiers = parseArbitrationDossiers(arbitration.dossiers, run.requirements);
        run.findings = createFindings(run, checks, dossiers);
      }

      await this.requireCurrentContext(run);
      run.status = 'succeeded';
      run.finishedAt = new Date().toISOString();
      this.progress(run, 'Analysis complete · decisions require human review');
    } catch (error) {
      run.status = 'failed';
      run.finishedAt = new Date().toISOString();
      run.error =
        error instanceof Error && 'statusCode' in error
          ? error.message
          : 'Analysis interrupted. Check the model, sources, and commits available to the server. No validated results.';
      this.saveRun(run);
    }
  }
}
