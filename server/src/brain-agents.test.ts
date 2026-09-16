import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { BrainAgents } from './brain-agents.js';
import { brainConfig } from './brain/config.js';

const exec = promisify(execFile);

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
    assert.match((await service.detail(sourceFailure.id)).error!, /Notion export is too large/);
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

test('Unlimited model calls omit application deadlines and complete all roles over HTTP', async (context) => {
  const f = await fixture();
  const model = mockModel();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const schema = body.text.format.schema;
    const role = schema.properties.requirements
      ? 'reader'
      : schema.properties.checks
        ? 'comparison'
        : 'arbitration';
    const result = await model.call(role, body.instructions, JSON.parse(body.input), schema);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(result.value) }],
          },
        ],
        usage: {},
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fetch = globalThis.fetch;
  context.mock.method(AbortSignal, 'timeout', () => {
    throw new Error('Unlimited calls must not create a deadline');
  });
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.signal, undefined);
    return fetch(`http://127.0.0.1:${port}`, init);
  });
  const timers: { headersTimeout: number; bodyTimeout: number }[] = [];
  const requests = channel('undici:request:create');
  const observe = (event: unknown) => {
    const { request } = event as { request: { headersTimeout: number; bodyTimeout: number } };
    timers.push({ headersTimeout: request.headersTimeout, bodyTimeout: request.bodyTimeout });
  };
  requests.subscribe(observe);
  try {
    const service = new BrainAgents({
      dbPath: f.dbPath,
      projectsPath: f.projectsPath,
      model: 'test-model',
      apiKey: 'test',
      requestTimeoutMs: 0,
    });
    await service.init();
    try {
      assert.equal((await service.state()).configured, true);
      const run = await service.start('dashboard', f.commit);
      await service.wait();
      const detail = await service.detail(run.id);
      assert.equal(detail.status, 'succeeded', detail.error);
      assert.equal(detail.requestTimeoutMs, 0);
    } finally {
      await service.close();
    }
    assert.equal(timers.length, 3);
    // Undefined means the request inherits the dispatcher's disabled response timers.
    assert.ok(
      timers.every(
        (t) =>
          (t.headersTimeout == null || t.headersTimeout === 0) &&
          (t.bodyTimeout == null || t.bodyTimeout === 0),
      ),
    );
  } finally {
    requests.unsubscribe(observe);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.root, { recursive: true, force: true });
  }
});

test('OpenAI transport validates structured responses and stops on errors without a fallback', async (context) => {
  const timeout = AbortSignal.timeout;
  context.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 600_000);
    return timeout(ms);
  });
  const f = await fixture();
  const model = mockModel();
  let mode = 'success';
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      'Bearer test-key-never-sent',
    );
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body as string);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.max_output_tokens, brainConfig.analysis.maxOutputTokens);
    assert.equal(body.tools, undefined);
    assert.equal(JSON.stringify(body).includes('test-key-never-sent'), false);
    if (mode === 'network') {
      throw new Error('Do not expose provider or credential details');
    }
    if (mode === 'timeout') {
      throw new DOMException('Do not expose provider or credential details', 'TimeoutError');
    }
    if (mode === 'body-timeout' || mode === 'body-network') {
      return Object.assign(new Response(), {
        json: async () => {
          throw mode === 'body-timeout'
            ? new DOMException('Do not expose provider or credential details', 'TimeoutError')
            : new TypeError('Do not expose provider or credential details');
        },
      });
    }
    if (mode === 'invalid-envelope') {
      return new Response('{invalid');
    }
    if (
      [
        'credit_balance_exhausted',
        'project_spend_limit_exceeded',
        'insufficient_quota',
        'rate_limit_exceeded',
      ].includes(mode)
    ) {
      return Response.json(
        {
          error: {
            code: mode,
            type: mode === 'rate_limit_exceeded' ? 'rate_limit_error' : 'insufficient_quota',
            message: 'Do not expose provider or credential details',
          },
        },
        { status: 429 },
      );
    }
    if (mode === 'invalid-error-body') {
      return new Response('<html>Do not expose provider or credential details</html>', {
        status: 429,
      });
    }
    if (['401', '429', '404', '503'].includes(mode)) {
      return new Response('{}', { status: Number(mode) });
    }
    const result = await model.call(
      body.text.format.name,
      body.instructions,
      JSON.parse(body.input),
      body.text.format.schema,
    );
    return new Response(
      JSON.stringify({
        status: mode === 'incomplete' ? 'incomplete' : 'completed',
        output: [
          {
            type: 'message',
            content: [
              mode === 'refusal'
                ? { type: 'refusal', refusal: 'Request refused.' }
                : {
                    type: 'output_text',
                    text: mode === 'invalid-json' ? '{invalid' : JSON.stringify(result.value),
                  },
            ],
          },
        ],
        usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
      }),
      { status: 200 },
    );
  });
  const service = new BrainAgents({
    dbPath: f.dbPath,
    projectsPath: f.projectsPath,
    model: 'test-model',
    apiKey: 'test-key-never-sent',
    requestTimeoutMs: 600_000,
  });
  await service.init();
  try {
    const first = await service.start('dashboard', f.commit);
    await service.wait();
    assert.equal((await service.detail(first.id)).status, 'succeeded');
    assert.equal(requests, 3);
    assert.equal((await service.state()).provider, 'openai');
    assert.equal((await service.state()).requestTimeoutMs, 600_000);
    for (mode of [
      'incomplete',
      'refusal',
      'invalid-json',
      '401',
      '429',
      '404',
      '503',
      'network',
      'timeout',
      'body-timeout',
      'body-network',
      'invalid-envelope',
      'credit_balance_exhausted',
      'project_spend_limit_exceeded',
      'insufficient_quota',
      'rate_limit_exceeded',
      'invalid-error-body',
    ]) {
      const before: number = requests;
      const run = await service.start('dashboard', f.commit);
      await service.wait();
      const failed = await service.detail(run.id);
      assert.equal(failed.status, 'failed', mode);
      assert.deepEqual(failed.findings, []);
      if (mode === 'incomplete') {
        assert.match(failed.error!, /incomplete/);
      }
      if (mode === 'network') {
        assert.match(failed.error!, /connection failed/);
      }
      if (mode === 'timeout') {
        assert.match(failed.error!, /timed out after 600 seconds/);
      }
      if (mode === 'body-timeout') {
        assert.match(failed.error!, /timed out after 600 seconds/);
      }
      if (mode === 'body-network') {
        assert.match(failed.error!, /connection failed/);
      }
      if (mode === 'invalid-envelope') {
        assert.match(failed.error!, /invalid JSON response/);
      }
      assert.deepEqual(
        failed.usage,
        ['incomplete', 'refusal', 'invalid-json'].includes(mode)
          ? { inputTokens: 10, outputTokens: 5 }
          : { inputTokens: 0, outputTokens: 0 },
      );
      if (mode === 'credit_balance_exhausted') {
        assert.match(failed.error!, /API credits are exhausted/);
      }
      if (mode === 'project_spend_limit_exceeded') {
        assert.match(failed.error!, /spending limit reached/);
      }
      if (mode === 'insufficient_quota') {
        assert.match(failed.error!, /API quota is insufficient/);
      }
      if (mode === 'rate_limit_exceeded') {
        assert.match(failed.error!, /rate limit reached/);
      }
      if (mode === 'invalid-error-body') {
        assert.match(failed.error!, /HTTP 429/);
      }
      if (['401', '429', '404', '503'].includes(mode)) {
        assert.ok(failed.error!.includes(`HTTP ${mode}`));
      }
      assert.equal(requests, before + 1, 'No automatic retry');
      assert.doesNotMatch(JSON.stringify(failed), /test-key-never-sent|Do not expose/);
    }
    for (const requestTimeoutMs of [NaN, Infinity, -1, 999, 1000.5, 1_800_001]) {
      const invalid = new BrainAgents({
        dbPath: f.dbPath,
        projectsPath: f.projectsPath,
        model: 'test-model',
        apiKey: 'test',
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
  } finally {
    await service.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
type ModelCall = NonNullable<NonNullable<ConstructorParameters<typeof BrainAgents>[0]>['call']>;
type InputSource = {
  sourceId: string;
  path: string;
  revision: string;
  lines: { line: number; quote: string }[];
};
type Input = {
  project: { name: string; scope: string };
  specifications?: InputSource[];
  code?: InputSource[];
  requirements?: { id: string }[];
  checks?: { requirementId: string }[];
  commit?: string;
  changedFiles?: string[];
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
  for (const path of [
    'repo/src',
    'repo/docs',
    'repo/other',
    'notion/alpha',
    'notion/alpha-copy',
    'notion/beta',
  ]) {
    await mkdir(resolve(root, path), { recursive: true });
  }
  const spec =
    '# Décisions du dashboard\nStatut: Publié\nLe dashboard doit conserver la date des exports.\n';
  await writeFile(resolve(root, 'notion/alpha/spec.md'), spec);
  await writeFile(resolve(root, 'notion/alpha-copy/spec.md'), spec);
  await writeFile(
    resolve(root, 'notion/beta/spec.md'),
    '# Autre produit\nStatut: Publié\nUtiliser PostgreSQL pour le site marchand.\n',
  );
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
      specs: [
        { kind: 'notion', path: './notion/alpha/spec.md' },
        { kind: 'notion', path: './notion/alpha-copy/spec.md' },
        { kind: 'git', path: 'docs/spec.md' },
      ],
    },
    {
      id: 'site',
      name: 'Online store',
      scope: 'Online store only.',
      repoPath: './repo',
      codePaths: ['other/'],
      specs: [{ kind: 'notion', path: './notion/beta/spec.md' }],
    },
  ];
  await writeFile(projectsPath, JSON.stringify(projects));
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', repo, ...args], { windowsHide: true })).stdout.trim();
  await git('init');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  const commit = await git('rev-parse', 'HEAD');
  return { root, repo, dbPath, projectsPath, projects, commit, git };
}

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
    assert.equal(JSON.stringify(model.calls).includes('PostgreSQL'), false);
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
    await service.close();
    service = new BrainAgents(options);
    await service.init();
    const reloaded = await service.detail(run.id);
    assert.deepEqual(reloaded.sources, detail.sources);
    assert.deepEqual(reloaded.findings[0].reviews, history);
    assert.equal((await service.state()).activeRunId, null);
    f.projects[0].scope = 'New scope requiring a separate analysis.';
    await writeFile(f.projectsPath, JSON.stringify(f.projects));
    assert.equal((await service.detail(run.id)).current, false);
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
      model: 'test-model',
      call: model.call,
    });
    await service.init();
    try {
      await assert.rejects(service.start('missing-project'), /not registered/);
      await assert.rejects(service.start('dashboard', '--malicious-option'), /full Git SHA/);
      await assert.rejects(service.start('dashboard', f.commit, '../../HEAD'), /full Git SHA/);
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
    model: 'test-model',
    call: model.call,
  });
  await service.init();
  try {
    await writeFile(resolve(f.repo, 'src/main.ts'), 'export const includeDate = true;\n');
    await writeFile(resolve(f.repo, 'other/site.ts'), 'export const otherProject = "modified";\n');
    await f.git('add', 'src/main.ts', 'other/site.ts');
    await f.git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'change two projects',
    );
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
