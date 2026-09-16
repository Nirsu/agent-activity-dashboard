import { brainConfig } from '../config.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import type { Source } from '../sources.js';
import { OpenAIClient } from './openai.js';
import { captureProjectSources, readProjects } from './projects.js';
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

function formatSources(sources: Source[]) {
  return sources.map((source) => ({
    sourceId: source.id,
    path: source.path,
    revision: source.revision,
    lines: source.content.split('\n').map((quote, index) => ({ line: index + 1, quote })),
  }));
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

// ponytail: bounded local checkouts + three sequential calls; add retrieval when corpus limits are reached.
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
    return '';
  }

  async init() {
    const { default: Sqlite } = await import('better-sqlite3');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Sqlite(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS brain_agent_runs (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );

    for (const run of this.allRuns()) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.error = 'Server stopped during analysis. Restart the analysis explicitly.';
        run.finishedAt = new Date().toISOString();
        this.saveRun(run);
      }
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
        'INSERT INTO brain_agent_runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(run.id, JSON.stringify(run));
  }

  private allRuns(): AnalysisRun[] {
    const rows = this.db.prepare('SELECT data FROM brain_agent_runs ORDER BY rowid DESC').all() as {
      data: string;
    }[];
    return rows.map((row) => JSON.parse(row.data));
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
      reason = 'Add a project and its specifications to brain.projects.json.';
    }
    if (!reason) {
      reason = this.configurationError();
    }

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
      runs: this.allRuns()
        .slice(0, brainConfig.memory.maxRecentRuns)
        .map(({ sources, requirements, findings, projectVersion, ...run }) => ({
          ...run,
          findingCount: findings.length,
        })),
      activeRunId: this.activeRunId,
    };
  }

  async detail(id: string) {
    const run = this.getRun(id);
    const projects = await readProjects(this.projectsPath);
    const project = projects.find((project) => project.id === run.projectId);
    const latestRun = this.allRuns().find(
      (candidate) => candidate.projectId === run.projectId && candidate.status === 'succeeded',
    );
    const hasCurrentConfiguration = Boolean(
      project && hash(JSON.stringify(project)) === run.projectVersion,
    );

    return {
      ...run,
      current: run.status === 'succeeded' && latestRun?.id === id && hasCurrentConfiguration,
    };
  }

  async start(projectId: string, commit?: string, baseCommit?: string) {
    if (this.running) {
      fail('An AI analysis is already running.', 409);
    }
    const error = this.configurationError();
    if (error) {
      fail(error, 409);
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
    this.running = this.execute(run, project).finally(() => {
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

  private async execute(run: AnalysisRun, project: Project) {
    try {
      await captureProjectSources(run, project, this.projectsPath);
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
      const specifications = run.sources.filter((source) => source.status === 'published');
      const code = run.sources.filter((source) => source.status === 'observed');
      const projectScope = { name: project.name, scope: project.scope };

      const reading = await this.invoke(
        run,
        'reader',
        readerPrompt,
        {
          project: projectScope,
          specifications: formatSources(specifications),
        },
        readingSchema,
      );
      run.requirements = parseRequirements(reading.requirements, specifications);
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
            baseCommit: run.baseCommit,
            changedFiles: run.changedFiles,
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
          },
          arbitrationSchema,
        );
        const dossiers = parseArbitrationDossiers(arbitration.dossiers, run.requirements);
        run.findings = createFindings(run, checks, dossiers);
      }

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
