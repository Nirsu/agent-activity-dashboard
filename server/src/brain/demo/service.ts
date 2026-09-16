import { brainConfig } from '../config.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { config } from '../../config.js';
import { normalizeText, type Source } from '../sources.js';
import {
  decisions,
  type Finding,
  type Options,
  type Review,
  type Rule,
  type Run,
  type Snapshot,
} from './types.js';
import { captureDemoSources } from './capture.js';
import { evaluate, proposeRules } from './rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode });
};

// ponytail: one local worker and JSON records in SQLite; normalize tables when queries need it.
// A second server process must not share this database in this single-instance MVP.
export class BrainService {
  private db!: Database.Database;
  private running: Promise<void> | null = null;
  readonly options: Required<Options>;

  constructor(options: Options = {}) {
    this.options = {
      dbPath: options.dbPath ?? process.env.BRAIN_DB_PATH ?? resolve(config.dataDir, 'brain.db'),
      repoPath: options.repoPath ?? process.env.BRAIN_REPO_PATH ?? resolve(here, '../../../..'),
      notionPath:
        options.notionPath ??
        process.env.BRAIN_NOTION_PATH ??
        resolve(here, '../../../../../save_notion'),
      gitBinary: options.gitBinary ?? process.env.BRAIN_GIT_BINARY ?? 'git',
    };
  }

  async init() {
    const { default: Sqlite } = await import('better-sqlite3');
    mkdirSync(dirname(this.options.dbPath), { recursive: true });
    this.db = new Sqlite(this.options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS brain_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, id))',
    );
    for (const run of this.all<Run>('run')) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.finishedAt = now();
        run.error = 'Server stopped during this run. Restart the process explicitly.';
        this.put('run', run);
      }
    }
  }

  async close() {
    await this.running;
    this.db.close();
  }

  private put(kind: string, value: { id: string }) {
    this.db
      .prepare(
        'INSERT INTO brain_records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, value.id, JSON.stringify(value));
  }

  private get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT data FROM brain_records WHERE kind=? AND id=?')
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  private all<T>(kind: string): T[] {
    return (
      this.db
        .prepare('SELECT data FROM brain_records WHERE kind=? ORDER BY rowid DESC')
        .all(kind) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as T);
  }

  source(id: string) {
    return this.get<Source>('source', id) ?? fail('Source not found.', 404);
  }

  private snapshot() {
    return this.get<Snapshot>('snapshot', 'current');
  }

  state() {
    const snapshot = this.snapshot();
    const sources = (snapshot?.sourceIds ?? []).map((id) => {
      const { content, ...source } = this.source(id);
      return source;
    });
    const runs = this.all<Run>('run');
    const findings = this.all<Finding>('finding');
    const reviews = this.all<Review>('review');
    const rules = this.all<Rule>('rule').filter((rule) =>
      snapshot?.sourceIds.includes(rule.source.sourceId),
    );
    const activeRuleIds = new Set(rules.filter((rule) => rule.active).map((rule) => rule.id));
    const comparison = runs.find(
      (run) =>
        run.kind === 'compare' &&
        run.status === 'succeeded' &&
        run.commit === snapshot?.commit &&
        JSON.stringify(run.sourceIds) === JSON.stringify(snapshot?.sourceIds) &&
        activeRuleIds.size > 0 &&
        run.findingIds?.length === activeRuleIds.size &&
        run.findingIds.every((id) =>
          findings.some((finding) => finding.id === id && activeRuleIds.has(finding.ruleId)),
        ),
    );
    return {
      mode: 'demo',
      engine: 'Structured extraction and exact rules · no AI calls',
      scope:
        'Demonstration assumption: apply the new application architecture to the internal dashboard. Business applicability requires human review.',
      repo: basename(this.options.repoPath),
      snapshot,
      sources,
      rules,
      runs: runs.slice(0, brainConfig.memory.maxRecentRuns),
      activeRun: runs.find((run) => run.status === 'running') ?? null,
      findings: findings.map((finding) => ({
        ...finding,
        current: Boolean(comparison?.findingIds?.includes(finding.id)),
        reviews: reviews.filter((review) => review.findingId === finding.id),
      })),
      comparisonReady: Boolean(comparison),
    };
  }

  search(query: string) {
    const terms = [
      ...new Set(
        normalizeText(query)
          .split(/[^a-z0-9]+/)
          .filter((term) => term.length >= brainConfig.search.minTermCharacters),
      ),
    ];
    if (!terms.length) {
      return [];
    }
    return (this.snapshot()?.sourceIds ?? [])
      .map((id) => this.source(id))
      .map((source) => {
        const lines = source.content.split('\n');
        const matches = lines
          .map((quote, index) => ({
            quote,
            line: index + 1,
            score: terms.filter((term) => normalizeText(quote).includes(term)).length,
          }))
          .filter((match) => match.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, brainConfig.search.maxMatchesPerSource);
        return {
          sourceId: source.id,
          title: source.title,
          kind: source.kind,
          status: source.status,
          revision: source.revision,
          matches,
          score: matches.reduce((total, match) => total + match.score, 0),
        };
      })
      .filter((source) => source.score > 0)
      .sort(
        (left, right) =>
          Number(right.status === 'published') - Number(left.status === 'published') ||
          right.score - left.score,
      )
      .slice(0, brainConfig.search.maxResults);
  }

  activate(id: string, active: boolean, note: string) {
    if (this.running) {
      fail('An analysis is running. Wait for it to finish.', 409);
    }
    const rule = this.get<Rule>('rule', id) ?? fail('Rule not found.', 404);
    if (!this.snapshot()?.sourceIds.includes(rule.source.sourceId)) {
      fail('Revision replaced: import and validate the current rule.', 409);
    }
    if (this.source(rule.source.sourceId).status !== 'published') {
      fail('The source for this rule is not published.');
    }
    if (active && note.trim().length < brainConfig.review.minNoteCharacters) {
      fail(
        `Explain why this scope applies (at least ${brainConfig.review.minNoteCharacters} characters).`,
      );
    }
    rule.active = active;
    rule.activatedAt = now();
    rule.activationNote = note.trim();
    this.put('rule', rule);
    return rule;
  }

  review(findingId: string, decision: string, note: string, expectedReviewId?: string) {
    if (this.running) {
      fail('An analysis is running. Wait for it to finish.', 409);
    }
    const finding = this.get<Finding>('finding', findingId) ?? fail('Finding not found.', 404);
    if (!this.state().findings.some((finding) => finding.id === findingId && finding.current)) {
      fail('Historical finding: rerun the comparison before reviewing.', 409);
    }
    if (finding.outcome !== 'difference') {
      fail('Only suspected differences require human review.');
    }
    if (!decisions.includes(decision as Review['decision'])) {
      fail('Invalid decision.');
    }
    if (
      note.trim().length < brainConfig.review.minNoteCharacters ||
      note.length > brainConfig.review.maxNoteCharacters
    ) {
      fail(
        `The justification must contain between ${brainConfig.review.minNoteCharacters} and ${brainConfig.review.maxNoteCharacters.toLocaleString('en-US')} characters.`,
      );
    }
    const previous = this.all<Review>('review').find((review) => review.findingId === findingId);
    if ((previous?.id ?? '') !== (expectedReviewId ?? '')) {
      fail('This finding has changed. Refresh before submitting.', 409);
    }
    const review: Review = {
      id: randomUUID(),
      findingId,
      decision: decision as Review['decision'],
      note: note.trim(),
      at: now(),
      actor: 'Local demonstration session (unverified identity)',
    };
    this.put('review', review);
    return review;
  }

  start(kind: Run['kind']) {
    if (this.running) {
      fail('An analysis is already running.', 409);
    }
    if (kind === 'compare' && !this.snapshot()) {
      fail('Import sources before comparing.');
    }
    const run: Run = {
      id: randomUUID(),
      kind,
      status: 'running',
      stage: 'Preparing',
      startedAt: now(),
      events: [],
    };
    this.put('run', run);
    this.running = this.execute(run).finally(() => {
      this.running = null;
    });
    return run;
  }

  async wait() {
    await this.running;
  }

  private progress(run: Run, message: string) {
    run.stage = message;
    run.events.push({ at: now(), message });
    this.put('run', run);
  }

  private async execute(run: Run) {
    try {
      if (run.kind === 'import') {
        await this.importSources(run);
      } else {
        await this.compare(run);
      }
    } catch (error) {
      run.status = 'failed';
      run.finishedAt = now();
      // Do not expose subprocess output, credentials, or full paths in API/logs.
      run.error =
        error instanceof Error && 'statusCode' in error
          ? error.message
          : 'Import or analysis failed. Check configured paths, Git, and source validity. The last complete memory snapshot is preserved.';
      this.put('run', run);
    }
  }

  private async importSources(run: Run) {
    this.progress(run, 'Reading A · capturing Notion exports and the Git commit');
    const { commit, sources, excluded } = await captureDemoSources(this.options);
    this.progress(run, 'Matching B · grouping by topic and proposing rules');
    const rules = proposeRules(sources);
    const snapshot: Snapshot = {
      id: 'current',
      importedAt: now(),
      commit,
      sourceIds: sources.map((source) => source.id),
      excluded,
    };
    run.commit = commit;
    run.sourceIds = snapshot.sourceIds;
    this.progress(run, 'Memory · publishing the complete snapshot');
    run.status = 'succeeded';
    run.finishedAt = now();
    this.db.transaction(() => {
      for (const source of sources) {
        this.put('source', source);
      }
      for (const rule of rules) {
        const previous = this.get<Rule>('rule', rule.id);
        if (!previous || previous.source.sourceId !== rule.source.sourceId) {
          this.put('rule', rule);
        }
      }
      this.put('snapshot', snapshot);
      this.put('run', run);
    })();
  }

  private async compare(run: Run) {
    const snapshot = this.snapshot()!;
    run.commit = snapshot.commit;
    run.sourceIds = snapshot.sourceIds;
    const sources = snapshot.sourceIds.map((id) => this.source(id));
    const rules = this.all<Rule>('rule').filter(
      (rule) => rule.active && snapshot.sourceIds.includes(rule.source.sourceId),
    );
    if (!rules.length) {
      fail('Validate at least one rule and its demonstration scope.');
    }
    this.progress(run, 'Comparison · checking manifests at the imported commit');
    const results = rules.map((rule) => {
      const finding = evaluate(rule, sources, snapshot.commit, run.id);
      const previous = this.get<Finding>('finding', finding.id);
      // A moved document has the same content revision but a different citation.
      if (previous && previous.decision.sourceId !== finding.decision.sourceId) {
        finding.id = hash(`${finding.id}:${finding.decision.sourceId}`);
      }
      return finding;
    });
    this.progress(run, 'Arbitration · preparing questions and evidence');
    run.findingIds = results.map((finding) => finding.id);
    run.status = 'succeeded';
    run.finishedAt = now();
    this.db.transaction(() => {
      for (const result of results) {
        if (!this.get('finding', result.id)) {
          this.put('finding', result);
        }
      }
      this.put('run', run);
    })();
  }
}
