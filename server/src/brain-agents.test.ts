import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BrainAgents, registerBrainAgents } from './brain-agents.js';
import Fastify from 'fastify';
import { brainConfig } from './brain/config.js';
import { makeSource, type Source } from './brain/sources.js';
import { fixtureGit } from './brain/testing/git.js';
import type {
  AnalysisRun,
  Finding,
  HumanReview,
  Project,
  ModelCall,
} from './brain/analysis/types.js';

test('Brain settings control Git capture, provider requests, reader prompts and validation', async (context) => {
  const fixtureData = await fixture();
  const model = mockModel();
  const originalAnalysis = { ...brainConfig.analysis };
  const originalGitBuffer = brainConfig.git.maxBufferBytes;
  let exceedRequirementLimit = false;

  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.max_output_tokens, 1234);
    const role = body.text.format.name;
    if (role === 'reader') {
      assert.match(body.instructions, /at most 1 requirements/);
      assert.doesNotMatch(body.instructions, /\{\{maxRequirements\}\}/);
    }
    const result = await model.call(
      role,
      body.instructions,
      JSON.parse(body.input),
      body.text.format.schema,
    );
    if (role === 'reader' && exceedRequirementLimit) {
      const value = result.value as { requirements: { id: string }[] };
      value.requirements.push({ ...value.requirements[0], id: 'R2' });
    }
    return Response.json({
      status: 'completed',
      usage: {},
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result.value) }] },
      ],
    });
  });

  const service = new BrainAgents({
    dbPath: fixtureData.dbPath,
    projectsPath: fixtureData.projectsPath,
    memory: fixtureData.memory,
    model: 'test-model',
    apiKey: 'test-key-never-sent',
    requestTimeoutMs: 0,
  });
  await service.init();
  try {
    brainConfig.git.maxBufferBytes = 1;
    const gitFailure = await service.start('dashboard', fixtureData.commit);
    await service.wait();
    assert.equal((await service.detail(gitFailure.id)).status, 'failed');
    assert.equal(model.calls.length, 0);

    brainConfig.git.maxBufferBytes = originalGitBuffer;
    brainConfig.analysis.maxSourceBytes = 1;
    const sourceFailure = await service.start('dashboard', fixtureData.commit);
    await service.wait();
    assert.match((await service.detail(sourceFailure.id)).error!, /Scope is too large/);
    assert.equal(model.calls.length, 0);

    brainConfig.analysis.maxSourceBytes = originalAnalysis.maxSourceBytes;
    brainConfig.analysis.maxRequirements = 1;
    brainConfig.analysis.maxOutputTokens = 1234;
    const success = await service.start('dashboard', fixtureData.commit);
    await service.wait();
    assert.equal((await service.detail(success.id)).status, 'succeeded');
    assert.equal(model.calls.length, 3);

    exceedRequirementLimit = true;
    const invalid = await service.start('dashboard', fixtureData.commit);
    await service.wait();
    assert.match((await service.detail(invalid.id)).error!, /List is missing or too long/);
    assert.equal(model.calls.length, 4, 'Validation must stop after the reader');
  } finally {
    Object.assign(brainConfig.analysis, originalAnalysis);
    brainConfig.git.maxBufferBytes = originalGitBuffer;
    await service.close();
    await rm(fixtureData.root, { recursive: true, force: true });
  }
});

test('provider failures stop the pipeline and preserve any reported usage', async (t) => {
  const f = await fixture();
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    memory: f.memory,
    model: 'test-model',
    apiKey: 'fixture-key',
    requestTimeoutMs: 600_000,
  });
  t.after(async () => {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await service.init();
  assert.equal((await service.state()).provider, 'openai');
  assert.equal((await service.state()).requestTimeoutMs, 600_000);
  for (const incomplete of [false, true]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () =>
      incomplete
        ? Response.json({ status: 'incomplete', usage: { input_tokens: 10, output_tokens: 5 } })
        : Response.json({ error: { message: 'Private provider detail' } }, { status: 503 }),
    );
    const run = await service.start('dashboard', f.commit);
    await service.wait();
    const failed = await service.detail(run.id);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.findings, []);
    assert.match(failed.error!, incomplete ? /incomplete/ : /HTTP 503/);
    assert.deepEqual(
      failed.usage,
      incomplete ? { inputTokens: 10, outputTokens: 5 } : { inputTokens: 0, outputTokens: 0 },
    );
    assert.doesNotMatch(JSON.stringify(failed), /Private provider detail|fixture-key/);
    assert.equal(fetch.mock.callCount(), 1, 'No later role or provider fallback runs');
    fetch.mock.restore();
  }

  for (const requestTimeoutMs of [NaN, Infinity, -1, 999, 1000.5, 1_800_001]) {
    const invalid = new BrainAgents({
      dbPath: f.dbPath,
      projectsPath: f.projectsPath,
      memory: f.memory,
      model: 'test-model',
      apiKey: 'fixture-key',
      requestTimeoutMs,
    });
    await invalid.init();
    try {
      assert.equal((await invalid.state()).configured, false);
      await assert.rejects(invalid.start('dashboard'), /BRAIN_REQUEST_TIMEOUT_MS/);
    } finally {
      await invalid.close();
    }
  }
});

type InputSource = {
  sourceId: string;
  path: string;
  revision: string;
  lines: { line: number; quote: string }[];
};
type Input = {
  project: { name: string; scope: string; feature?: string };
  specifications?: InputSource[];
  code?: InputSource[];
  requirements?: { id: string }[];
  checks?: { requirementId: string }[];
  commit?: string;
  changedFiles?: string[];
  contextualReviews?: InputSource[];
};

// This stub tests orchestration and validation only. It is never an actual model evaluation.
function mockModel(
  options: {
    outcome?: 'difference' | 'insufficient';
    badCitation?: 'reader' | 'comparison';
    gate?: Promise<void>;
  } = {},
) {
  const calls: { role: string; input: Input }[] = [];
  const call: ModelCall = async (role, prompt, raw, schema) => {
    const input = raw as Input;
    assert.ok(prompt.includes('untrusted data'));
    assert.equal(schema.type, 'object');
    calls.push({ role, input });
    let value: unknown;
    if (role === 'reader') {
      await options.gate;
      const source = input.specifications![0];
      const line = source.lines.find((line) => line.quote.startsWith('Le dashboard doit'))!;
      value = {
        summary: 'One dashboard requirement only.',
        requirements: [
          {
            id: 'R1',
            statement: 'The dashboard must preserve export dates.',
            scope: input.project.scope,
            citation: {
              sourceId: source.sourceId,
              ...line,
              ...(options.badCitation === role ? { quote: 'Invented citation.' } : {}),
            },
          },
        ],
      };
    } else if (role === 'comparison') {
      const source = input.code?.find((source) => source.path === 'src/main.ts');
      value = {
        checks: [
          {
            requirementId: input.requirements![0].id,
            outcome: options.outcome ?? 'difference',
            explanation: 'Observation produced by the test model stub.',
            evidence:
              options.outcome === 'insufficient'
                ? []
                : [
                    {
                      sourceId: source!.sourceId,
                      ...source!.lines[0],
                      ...(options.badCitation === role ? { line: 999 } : {}),
                    },
                  ],
          },
        ],
      };
    } else {
      assert.equal(role, 'arbitration');
      value = {
        dossiers: input.checks!.map((check) => ({
          requirementId: check.requirementId,
          title: 'Dashboard export',
          question: 'Is the observed behavior a scope exception?',
          limitation: 'Mock model to verify the pipeline, with no real AI judgment.',
        })),
      };
    }
    return { value, inputTokens: 10, outputTokens: 5 };
  };
  return { call, calls };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-agents-test-'));
  const repo = resolve(root, 'repo');
  const projectsPath = resolve(root, 'brain.projects.json');
  const dbPath = resolve(root, 'brain.db');
  for (const path of ['repo/src', 'repo/docs', 'repo/other']) {
    await mkdir(resolve(root, path), { recursive: true });
  }
  const spec =
    '# Décisions du dashboard\nStatut: Publié\nLe dashboard doit conserver la date des exports.\n';
  const capturedNotion = [
    makeSource('notion', 'notion/alpha/spec.md', spec),
    makeSource('notion', 'notion/alpha-copy/spec.md', spec),
  ];
  for (const source of capturedNotion) {
    source.status = 'published';
  }
  await writeFile(
    resolve(repo, 'docs/spec.md'),
    '# Spécification Git du dashboard\nLes exports sont consultables.\n',
  );
  await writeFile(resolve(repo, 'src/main.ts'), 'export const includeDate = false;\n');
  await writeFile(resolve(repo, 'src/unchanged.ts'), 'export const format = "csv";\n');
  await writeFile(resolve(repo, 'src/secret.txt'), 'EXCLUDED_TEST_SENTINEL\n');
  await writeFile(resolve(repo, 'other/site.ts'), 'export const otherProject = true;\n');
  const projects = [
    {
      id: 'dashboard',
      name: 'Dashboard',
      scope: 'Dashboard export behavior only.',
      repoPath: './repo',
      codePaths: ['src/'],
      specs: [{ kind: 'git', path: 'docs/spec.md' }],
    },
    {
      id: 'site',
      name: 'Online store',
      scope: 'Online store only.',
      repoPath: './repo',
      codePaths: ['other/'],
      specs: [],
    },
  ];
  await writeFile(projectsPath, JSON.stringify(projects));
  const git = fixtureGit(repo);
  await git('init');
  await git('add', '.');
  await git('commit', '-m', 'fixture');
  const commit = await git('rev-parse', 'HEAD');
  const memoryState = {
    version: 'memory-v1',
    contextRevision: 0,
    reviews: [] as HumanReview[],
    queries: [] as string[],
  };
  const memory = {
    version: () => memoryState.version,
    contextVersion: () => `${memoryState.version}:${memoryState.contextRevision}`,
    retrieve: async (project: Project, query: string, gitSpecifications: Source[] = []) => {
      memoryState.queries.push(query);
      const sources = structuredClone([
        ...(project.id === 'dashboard' ? capturedNotion : []),
        ...gitSpecifications,
      ]);
      return {
        sources,
        excerpts: sources.map((source) => ({
          sourceId: source.id,
          startLine: 1,
          endLine: source.lines,
        })),
        datasets: ['test-dataset'],
        sourceIds: sources.map((source) => source.id),
        retrievedAt: new Date().toISOString(),
        query,
        memoryVersion: memoryState.version,
        contextVersion: `${memoryState.version}:${memoryState.contextRevision}`,
      };
    },
    recordReview: async (_run: AnalysisRun, _finding: Finding, review: HumanReview) => {
      memoryState.reviews.push(review);
      memoryState.contextRevision++;
    },
  };
  return {
    root,
    repo,
    dbPath,
    projectsPath,
    projects,
    commit,
    git,
    memory,
    memoryState,
    capturedNotion,
  };
}

test('submitted replacements and deletions skip oversized baseline files and enforce the final context budget', async (t) => {
  const f = await fixture();
  const model = mockModel({ outcome: 'insufficient' });
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    memory: f.memory,
    model: 'test',
    call: model.call,
  });
  t.after(async () => {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const oversized = 'x'.repeat(brainConfig.analysis.maxSourceBytes + 1);
  await writeFile(resolve(f.repo, 'src/main.ts'), oversized);
  await f.git('add', 'src/main.ts');
  await f.git('commit', '-m', 'Large baseline');
  const baseline = await f.git('rev-parse', 'HEAD');
  await service.init();
  for (const content of ['export const includeDate = true;', null]) {
    const run = await service.start('dashboard', baseline, undefined, 'Reduce the feature', [
      { path: 'src/main.ts', content },
    ]);
    await service.wait();
    const result = await service.detail(run.id);
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(
      result.sources.find((source) => source.path === 'src/main.ts')?.content,
      content ?? undefined,
    );
    assert.ok(result.sources.some((source) => source.path === 'src/unchanged.ts'));
    assert.ok(result.sources.some((source) => source.path === 'docs/spec.md'));
    assert.equal(result.submission?.baselineCommit, baseline);
  }
  const calls = model.calls.length;
  const tooLarge = await service.start(
    'dashboard',
    baseline,
    undefined,
    'Exceed the combined budget',
    [{ path: 'src/main.ts', content: 'x'.repeat(brainConfig.analysis.maxSourceBytes) }],
  );
  await service.wait();
  assert.match((await service.detail(tooLarge.id)).error!, /baseline context exceed/);
  assert.equal(model.calls.length, calls);
  assert.equal((await f.git('show', `${baseline}:src/main.ts`)).length, oversized.length);
});

test('Brain agents: project capture, ordered mock calls, concurrent arbitration and persistent evidence', async () => {
  const f = await fixture();
  let release!: () => void;
  const model = mockModel({
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const options = {
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    memory: f.memory,
    model: 'test-model',
    apiKey: '',
    call: model.call,
  };
  let service = new BrainAgents(options);
  await service.init();
  try {
    await writeFile(resolve(f.repo, 'src/main.ts'), 'UNCOMMITTED_CHANGE_NOT_TO_ANALYSE\n');
    await writeFile(resolve(f.repo, 'docs/spec.md'), 'UNCOMMITTED_SPEC_NOT_TO_ANALYSE\n');
    const launches = await Promise.allSettled([
      service.start('dashboard', f.commit),
      service.start('dashboard', f.commit),
    ]);
    const accepted = launches.filter((result) => result.status === 'fulfilled');
    assert.equal(accepted.length, 1);
    const rejected = launches.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    assert.equal(rejected.reason.statusCode, 409);
    const run = (accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<BrainAgents['start']>>>)
      .value;
    assert.equal((await service.state()).activeRunId, run.id);
    release();
    await service.wait();
    const detail = await service.detail(run.id);
    assert.equal(detail.status, 'succeeded', detail.error);
    assert.equal(detail.current, true);
    assert.equal(detail.commit, f.commit);
    assert.equal(
      detail.sources.find((source) => source.path === 'docs/spec.md')!.revision,
      f.commit,
    );
    assert.equal(detail.retrieval?.memoryVersion, 'memory-v1');
    assert.equal(detail.retrieval?.sourceIds.length, 3);
    assert.equal('sources' in detail.retrieval!, false);
    assert.deepEqual(
      model.calls.map((call) => call.role),
      ['reader', 'comparison', 'arbitration'],
    );
    assert.equal(model.calls[0].input.project.name, 'Dashboard');
    assert.equal(model.calls[0].input.specifications!.length, 3);
    assert.deepEqual(model.calls[1].input.code!.map((source) => source.path).sort(), [
      'src/main.ts',
      'src/unchanged.ts',
    ]);
    assert.equal(model.calls[1].input.commit, f.commit);
    assert.equal(JSON.stringify(model.calls).includes('UNCOMMITTED'), false);
    assert.equal(JSON.stringify(model.calls).includes('EXCLUDED_TEST_SENTINEL'), false);
    assert.deepEqual(detail.usage, { inputTokens: 30, outputTokens: 15 });
    assert.match(detail.promptVersion!, /^[a-f0-9]{64}$/);
    assert.equal(new Set(detail.sources.map((source) => source.id)).size, detail.sources.length);
    assert.deepEqual(
      detail.sources
        .filter((source) => source.kind === 'notion')
        .map((source) => source.path)
        .sort(),
      ['notion/alpha-copy/spec.md', 'notion/alpha/spec.md'],
    );
    for (const finding of detail.findings) {
      assert.ok(
        detail.requirements.some((requirement) => requirement.id === finding.requirementId),
      );
      for (const citation of [finding.decision, ...finding.evidence]) {
        assert.equal(
          detail.sources.find((source) => source.id === citation.sourceId)!.content.split('\n')[
            citation.line - 1
          ],
          citation.quote,
        );
      }
    }
    const finding = detail.findings[0];
    const summaryBeforeReview = (await service.state()).runs[0];
    assert.equal(summaryBeforeReview.findingCount, detail.findings.length);
    assert.equal('sources' in summaryBeforeReview, false);
    assert.equal('requirements' in summaryBeforeReview, false);
    assert.equal('findings' in summaryBeforeReview, false);
    assert.equal((await service.state()).runs[0].detailVersion, summaryBeforeReview.detailVersion);
    const reviews = await Promise.allSettled([
      service.review(run.id, finding.id, 'investigate', 'First test justification.'),
      service.review(run.id, finding.id, 'exception', 'Second test justification.'),
    ]);
    assert.equal(reviews.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(
      (reviews.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
        .statusCode,
      409,
    );
    const saved = (await service.detail(run.id)).findings[0].reviews;
    assert.equal(saved.length, 1);
    assert.notEqual(
      (await service.state()).runs[0].detailVersion,
      summaryBeforeReview.detailVersion,
    );
    const revision = await service.review(
      run.id,
      finding.id,
      'confirmed',
      'Justification revised after human review.',
      saved[0].id,
    );
    const history = (await service.detail(run.id)).findings[0].reviews;
    assert.deepEqual(
      history.map((review) => review.id),
      [revision.id, saved[0].id],
    );
    assert.deepEqual(
      f.memoryState.reviews.map((review) => review.id),
      [saved[0].id, revision.id],
    );
    await service.close();
    service = new BrainAgents(options);
    await service.init();
    const reloaded = await service.detail(run.id);
    assert.deepEqual(reloaded.sources, detail.sources);
    assert.deepEqual(reloaded.findings[0].reviews, history);
    assert.equal((await service.state()).activeRunId, null);
    const currentVersion = (await service.state()).runs[0].detailVersion;
    f.projects[0].scope = 'New scope requiring a separate analysis.';
    await writeFile(f.projectsPath, JSON.stringify(f.projects));
    assert.equal((await service.detail(run.id)).current, false);
    assert.notEqual((await service.state()).runs[0].detailVersion, currentVersion);
    await assert.rejects(
      service.review(run.id, finding.id, 'confirmed', 'Decision on a previous scope.', revision.id),
      /Historical/,
    );
  } finally {
    release();
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Brain agents: invalid model citations stop the pipeline; insufficient evidence remains explicit', async () => {
  const f = await fixture();
  try {
    for (const role of ['reader', 'comparison'] as const) {
      const model = mockModel({ badCitation: role });
      const service = new BrainAgents({
        dbPath: resolve(f.root, `${role}.db`),
        projectsPath: f.projectsPath,
        memory: f.memory,
        model: 'test-model',
        call: model.call,
      });
      await service.init();
      try {
        const run = await service.start('dashboard');
        await service.wait();
        const detail = await service.detail(run.id);
        assert.equal(detail.status, 'failed');
        assert.match(detail.error!, /Citation rejected/);
        assert.equal(detail.findings.length, 0);
        assert.equal(detail.current, false);
        assert.deepEqual(
          model.calls.map((call) => call.role),
          role === 'reader' ? ['reader'] : ['reader', 'comparison'],
        );
      } finally {
        await service.close();
      }
    }
    const model = mockModel({ outcome: 'insufficient' });
    const service = new BrainAgents({
      dbPath: f.dbPath,
      projectsPath: f.projectsPath,
      memory: f.memory,
      model: 'test-model',
      call: model.call,
    });
    await service.init();
    try {
      const run = await service.start('dashboard');
      await service.wait();
      const detail = await service.detail(run.id);
      assert.equal(detail.status, 'succeeded', detail.error);
      assert.equal(detail.findings[0].outcome, 'insufficient');
      assert.deepEqual(detail.findings[0].evidence, []);
      await assert.rejects(
        service.review(run.id, detail.findings[0].id, 'confirmed', 'Insufficient evidence.'),
        /suspected differences/,
      );
    } finally {
      await service.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Brain agents: unavailable configuration and invalid targets never call a model', async () => {
  const f = await fixture();
  try {
    const unavailable = new BrainAgents({
      dbPath: resolve(f.root, 'unavailable.db'),
      projectsPath: f.projectsPath,
      memory: f.memory,
      model: '',
      apiKey: '',
    });
    await unavailable.init();
    try {
      const state = await unavailable.state();
      assert.equal(state.configured, false);
      assert.match(state.reason, /BRAIN_MODEL/);
      assert.equal(state.projects.length, 2);
      await assert.rejects(unavailable.start('dashboard'), /not configured/);
      assert.deepEqual((await unavailable.state()).runs, []);
    } finally {
      await unavailable.close();
    }
    const model = mockModel();
    const service = new BrainAgents({
      dbPath: f.dbPath,
      projectsPath: f.projectsPath,
      memory: f.memory,
      model: 'test-model',
      call: model.call,
    });
    await service.init();
    try {
      await assert.rejects(service.start('missing-project'), /not registered/);
      await assert.rejects(service.start('dashboard', '--malicious-option'), /full Git SHA/);
      await assert.rejects(service.start('dashboard', f.commit, '../../HEAD'), /full Git SHA/);
      await assert.rejects(
        service.start(
          'dashboard',
          f.commit,
          undefined,
          'x'.repeat(brainConfig.analysis.maxTextCharacters + 1),
        ),
        /too long/,
      );
      assert.equal(model.calls.length, 0);
      assert.equal((await service.state()).runs.length, 0);
      await writeFile(f.projectsPath, '[]');
      assert.equal((await service.state()).configured, false);
      await assert.rejects(service.start('dashboard'), /not registered/);
      assert.equal(model.calls.length, 0);
    } finally {
      await service.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Brain agents: retain the reader explanation when no requirements apply', async () => {
  const f = await fixture();
  const roles: string[] = [];
  const summary = 'The selected specifications describe a different feature.';
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    memory: f.memory,
    model: 'test-model',
    call: async (role) => {
      roles.push(role);
      return { value: { summary, requirements: [] }, inputTokens: 8, outputTokens: 4 };
    },
  });
  await service.init();
  try {
    const run = await service.start('dashboard', f.commit);
    await service.wait();
    const detail = await service.detail(run.id);
    assert.equal(detail.status, 'succeeded', detail.error);
    assert.deepEqual(roles, ['reader']);
    assert.deepEqual(detail.findings, []);
    assert.ok(detail.events.some((event) => event.message.includes(summary)));
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Brain agents: base commit scopes code to changed allowed files and preserves the selected specifications', async () => {
  const f = await fixture();
  const model = mockModel();
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    memory: f.memory,
    model: 'test-model',
    call: model.call,
  });
  await service.init();
  try {
    await writeFile(resolve(f.repo, 'src/main.ts'), 'export const includeDate = true;\n');
    await writeFile(resolve(f.repo, 'other/site.ts'), 'export const otherProject = "modified";\n');
    await f.git('add', 'src/main.ts', 'other/site.ts');
    await f.git('commit', '-m', 'change two projects');
    const head = await f.git('rev-parse', 'HEAD');
    const run = await service.start('dashboard', head, f.commit);
    await service.wait();
    const detail = await service.detail(run.id);
    assert.equal(detail.status, 'succeeded', detail.error);
    assert.equal(detail.baseCommit, f.commit);
    assert.equal(detail.commit, head);
    assert.deepEqual(detail.changedFiles.sort(), ['other/site.ts', 'src/main.ts']);
    assert.deepEqual(
      model.calls[1].input.code!.map((source) => source.path),
      ['src/main.ts'],
    );
    assert.equal(model.calls[0].input.specifications!.length, 3);
    assert.equal(model.calls[1].input.code![0].lines[0].quote, 'export const includeDate = true;');
    assert.equal(
      detail.sources.some((source) => source.path === 'src/unchanged.ts'),
      false,
    );
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Brain agents require configured memory and never fall back to Git-only analysis', async () => {
  const f = await fixture();
  const model = mockModel();
  const unavailable = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    call: model.call,
  });
  await unavailable.init();
  try {
    assert.equal((await unavailable.state()).configured, false);
    await assert.rejects(unavailable.start('dashboard'), /memory is not configured/);
    assert.equal(model.calls.length, 0);
  } finally {
    await unavailable.close();
  }
  const failing = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    call: model.call,
    memory: {
      ...f.memory,
      retrieve: async () => {
        throw Object.assign(new Error('Cognee unavailable.'), { statusCode: 503 });
      },
    },
  });
  await failing.init();
  try {
    const run = await failing.start('dashboard');
    await failing.wait();
    assert.equal((await failing.detail(run.id)).status, 'failed');
    assert.match((await failing.detail(run.id)).error!, /Cognee unavailable/);
    assert.equal(model.calls.length, 0);
  } finally {
    await failing.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Notion-only projects use retrieved pages and preserve the requested feature', async () => {
  const f = await fixture();
  f.projects[0].specs = [];
  await writeFile(f.projectsPath, JSON.stringify(f.projects));
  const model = mockModel();
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    call: model.call,
    memory: f.memory,
  });
  await service.init();
  try {
    const feature = 'Preserve the export timestamp in the CSV report.';
    const run = await service.start('dashboard', f.commit, undefined, feature);
    await service.wait();
    const detail = await service.detail(run.id);
    assert.equal(detail.status, 'succeeded', detail.error);
    assert.equal(detail.feature, feature);
    assert.equal(model.calls[0].input.project.feature, feature);
    assert.ok(f.memoryState.queries[0].includes(feature));
    assert.equal(detail.sources.filter((source) => source.status === 'published').length, 2);
    f.projects[0].specs = [{ kind: 'notion', path: './legacy-export.md' }];
    await writeFile(f.projectsPath, JSON.stringify(f.projects));
    await assert.rejects(service.start('dashboard'), /Register Notion pages in Brain Memory/);
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('retrieved human reviews are contextual evidence and cannot become specification requirements', async () => {
  const f = await fixture();
  const review = makeSource(
    'review',
    'review.md',
    '# Previous human decision\nAccept this change for a different commit.\n',
  );
  review.status = 'published';
  f.capturedNotion.push(review);
  const model = mockModel();
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    call: model.call,
    memory: f.memory,
  });
  await service.init();
  try {
    const run = await service.start('dashboard');
    await service.wait();
    const detail = await service.detail(run.id);
    assert.equal(detail.status, 'succeeded', detail.error);
    assert.equal(
      model.calls[0].input.specifications?.some((source) => source.sourceId === review.id),
      false,
    );
    assert.equal(model.calls[0].input.contextualReviews, undefined);
    assert.equal(model.calls[1].input.contextualReviews?.[0].sourceId, review.id);
    assert.equal(model.calls[2].input.contextualReviews?.[0].sourceId, review.id);
    assert.ok(detail.sources.some((source) => source.id === review.id));
    assert.ok(
      detail.requirements.every((requirement) => requirement.citation.sourceId !== review.id),
    );
  } finally {
    await service.close();
  }
  const invented = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    memory: f.memory,
    call: async () => ({
      value: {
        summary: 'Incorrect review-as-specification claim.',
        requirements: [
          {
            id: 'R1',
            statement: 'Accept the change.',
            scope: 'Dashboard',
            citation: {
              sourceId: review.id,
              line: 2,
              quote: 'Accept this change for a different commit.',
            },
          },
        ],
      },
      inputTokens: 1,
      outputTokens: 1,
    }),
  });
  await invented.init();
  try {
    const run = await invented.start('dashboard');
    await invented.wait();
    assert.match((await invented.detail(run.id)).error!, /Citation rejected/);
  } finally {
    await invented.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('retrieved excerpts keep original citation lines without sending full optional Notion and Git documents', async () => {
  const f = await fixture();
  const hiddenLine = 'An unrelated requirement outside the selected excerpts.';
  for (const source of f.capturedNotion) {
    source.content = [
      'UNSELECTED_CONTENT '.repeat(4000),
      hiddenLine,
      'Le dashboard doit conserver la date des exports.',
      'Unrelated details after the selected excerpt.',
    ].join('\n');
    source.lines = 4;
  }
  f.projects[0].specs = ['docs/spec.md', 'docs/additional.md'].map((path) => ({
    kind: 'git',
    path,
  }));
  for (const specification of f.projects[0].specs) {
    await writeFile(resolve(f.repo, specification.path), f.capturedNotion[0].content);
  }
  await writeFile(f.projectsPath, JSON.stringify(f.projects));
  await f.git('add', 'docs');
  await f.git('commit', '-m', 'Add large optional specifications');
  const model = mockModel();
  let citeHiddenLine = false;
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    memory: {
      ...f.memory,
      retrieve: async (...args) => {
        const retrieved = await f.memory.retrieve(...args);
        return {
          ...retrieved,
          excerpts: retrieved.excerpts.map((excerpt) => ({ ...excerpt, startLine: 3, endLine: 3 })),
        };
      },
    },
    call: async (...args) => {
      const result = await model.call(...args);
      if (args[0] === 'reader' && citeHiddenLine) {
        const value = result.value as {
          requirements: { citation: { line: number; quote: string } }[];
        };
        value.requirements[0].citation.line = 2;
        value.requirements[0].citation.quote = hiddenLine;
      }
      return result;
    },
  });
  await service.init();
  try {
    const run = await service.start('dashboard');
    await service.wait();
    const detail = await service.detail(run.id);
    assert.equal(detail.status, 'succeeded', detail.error);
    assert.ok(
      detail.sources.reduce((size, source) => size + Buffer.byteLength(source.content), 0) >
        brainConfig.analysis.maxSourceBytes,
      'Complete snapshots remain available even when only excerpts fit the model context',
    );
    assert.deepEqual(model.calls[0].input.specifications![0].lines, [
      { line: 3, quote: 'Le dashboard doit conserver la date des exports.' },
    ]);
    assert.equal(model.calls[0].input.specifications!.length, 4);
    assert.ok(model.calls[0].input.specifications!.every((source) => source.lines.length === 1));
    assert.equal(detail.requirements[0].citation.line, 3);
    assert.doesNotMatch(JSON.stringify(model.calls), /UNSELECTED_CONTENT|Unrelated details/);
    assert.equal(detail.sources[0].content, f.capturedNotion[0].content);

    citeHiddenLine = true;
    const invalid = await service.start('dashboard');
    await service.wait();
    const rejected = await service.detail(invalid.id);
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error!, /Citation rejected.*not included in the retrieved excerpts/);
    assert.deepEqual(
      model.calls.map((call) => call.role),
      ['reader', 'comparison', 'arbitration', 'reader'],
    );
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('analysis storage upgrades existing archives and limits lightweight run summaries', async () => {
  const f = await fixture();
  const { default: Sqlite } = await import('better-sqlite3');
  const legacy = new Sqlite(f.dbPath);
  legacy.exec('CREATE TABLE brain_agent_runs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const archived: AnalysisRun = {
    id: 'legacy-running',
    projectId: 'dashboard',
    projectName: 'Dashboard',
    scope: 'Dashboard exports',
    projectVersion: 'old-project',
    status: 'running',
    stage: 'Reading specifications',
    startedAt: '2026-01-01T00:00:00Z',
    model: 'test-model',
    events: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    sources: JSON.parse(JSON.stringify(f.capturedNotion)),
    requirements: [],
    findings: [],
    changedFiles: [],
  };
  legacy
    .prepare('INSERT INTO brain_agent_runs VALUES (?, ?)')
    .run(archived.id, JSON.stringify(archived));
  legacy.close();
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    memory: f.memory,
    model: 'test-model',
    call: mockModel().call,
  });
  const previousLimit = brainConfig.memory.maxRecentRuns;
  await service.init();
  try {
    const preserved = await service.detail(archived.id);
    assert.equal(preserved.status, 'interrupted');
    assert.deepEqual(preserved.sources, archived.sources);
    const run = await service.start('dashboard');
    await service.wait();
    assert.equal((await service.detail(run.id)).status, 'succeeded');
    brainConfig.memory.maxRecentRuns = 1;
    const state = await service.state();
    assert.deepEqual(
      state.runs.map((summary) => summary.id),
      [run.id],
    );
    assert.equal('sources' in state.runs[0], false);
    assert.ok(state.runs[0].detailVersion);
    assert.deepEqual((await service.detail(archived.id)).sources, archived.sources);
  } finally {
    brainConfig.memory.maxRecentRuns = previousLimit;
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a source approval change invalidates in-flight results and existing analyses', async () => {
  const f = await fixture();
  const model = mockModel();
  let changeDuringCall = false;
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    memory: f.memory,
    call: async (...args) => {
      const result = await model.call(...args);
      if (args[0] === 'arbitration' && changeDuringCall) {
        f.memoryState.version = 'withdrawn-v3';
      }
      return result;
    },
  });
  await service.init();
  try {
    const first = await service.start('dashboard');
    await service.wait();
    assert.equal((await service.detail(first.id)).current, true);
    const currentVersion = (await service.state()).runs[0].detailVersion;
    const savedEvidence = (await service.detail(first.id)).sources;
    f.memoryState.version = 'reassigned-v2';
    assert.equal((await service.detail(first.id)).current, false);
    assert.notEqual((await service.state()).runs[0].detailVersion, currentVersion);
    assert.equal((await service.graphSnapshots())[0].current, false);
    assert.deepEqual((await service.detail(first.id)).sources, savedEvidence);
    changeDuringCall = true;
    const second = await service.start('dashboard');
    await service.wait();
    const detail = await service.detail(second.id);
    assert.equal(detail.status, 'failed');
    assert.match(detail.error!, /approvals changed during analysis/);
    assert.equal(detail.current, false);
    await assert.rejects(
      service.review(
        second.id,
        detail.findings[0].id,
        'confirmed',
        'Cannot approve stale evidence.',
      ),
      /Historical analysis/,
    );
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('changed review context stops the pipeline before the next model call', async () => {
  const f = await fixture();
  const model = mockModel();
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    memory: f.memory,
    call: async (...args) => {
      const result = await model.call(...args);
      if (args[0] === 'reader') {
        f.memoryState.contextRevision++;
      }
      return result;
    },
  });
  await service.init();
  try {
    const run = await service.start('dashboard');
    await service.wait();
    const detail = await service.detail(run.id);
    assert.equal(detail.status, 'failed');
    assert.match(detail.error!, /Memory sources or approvals changed/);
    assert.deepEqual(
      model.calls.map((call) => call.role),
      ['reader'],
    );
    assert.equal(detail.retrieval?.memoryVersion, f.memory.version());
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('human review writes require administrative access rather than a viewer credential', async () => {
  const f = await fixture();
  const app = Fastify();
  const previous = process.env.BRAIN_ADMIN_TOKEN;
  process.env.BRAIN_ADMIN_TOKEN = 'test-admin-credential';
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    memory: f.memory,
    model: 'test-model',
    call: mockModel().call,
  });
  await registerBrainAgents(app, service);
  try {
    const payload = {
      findingId: 'finding',
      decision: 'confirmed',
      note: 'Review from a human administrator.',
    };
    const url = '/api/brain/analyses/not-found/reviews';
    const viewer = await app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'x-aad-token': 'test-viewer-credential' },
    });
    assert.equal(viewer.statusCode, 403);
    const wrongAdmin = await app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'x-brain-admin-token': 'incorrect' },
    });
    assert.equal(wrongAdmin.statusCode, 403);
    const administrator = await app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'x-brain-admin-token': 'test-admin-credential' },
    });
    assert.equal(
      administrator.statusCode,
      404,
      'Administrative access reaches the analysis lookup',
    );
  } finally {
    if (previous === undefined) {
      delete process.env.BRAIN_ADMIN_TOKEN;
    } else {
      process.env.BRAIN_ADMIN_TOKEN = previous;
    }
    await app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
