import { fixtureGit } from './brain/testing/git.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';
import { BrainAgents } from './brain/analysis/service.js';
import { requireBrainAccess } from './brain/access.js';
import { registerBrainMcp } from './brain/mcp.js';
import { AccessStore } from './access/store.js';
import { brainConfig } from './brain/config.js';
import type { BrainAgentsOptions } from './brain/analysis/types.js';

test('a real MCP client discovers context, submits changes and reads preserved findings without writing the checkout', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-mcp-'));
  let service: BrainAgents | undefined;
  let app: ReturnType<typeof Fastify> | undefined;
  let client: Client | undefined;
  let access: AccessStore | undefined;
  const previousToken = config.viewerToken;
  t.after(async () => {
    await client?.close();
    await app?.close();
    await service?.close();
    await access?.close();
    config.viewerToken = previousToken;
    await rm(root, { recursive: true, force: true });
  });
  const git = fixtureGit(root);
  await git('init');
  await writeFile(
    resolve(root, 'README.md'),
    'Use sanitized summaries.\nNever send raw arguments.',
  );
  await writeFile(resolve(root, 'hook.js'), 'send({ summary: "Terminal command" });');
  await git('add', 'README.md', 'hook.js');
  await git('commit', '-m', 'Fixture baseline');
  const baseline = await git('rev-parse', 'HEAD');
  const projectsPath = resolve(root, 'projects.json');
  await writeFile(
    projectsPath,
    JSON.stringify([
      {
        id: 'dashboard',
        name: 'Dashboard',
        scope: 'Hook payload only',
        repoPath: '.',
        codePaths: ['hook.js', 'new.js'],
        specs: [{ kind: 'git', path: 'README.md' }],
      },
    ]),
  );
  const seenInputs: string[] = [];
  let noRequirements = false;
  const memory: NonNullable<BrainAgentsOptions['memory']> = {
    version: () => 'memory',
    contextVersion: () => 'memory',
    recordReview: async () => {},
    retrieve: async (_project, query, sources = []) => ({
      sources,
      excerpts: sources.map((source) => ({
        sourceId: source.id,
        startLine: 1,
        endLine: source.lines,
      })),
      datasets: [],
      sourceIds: sources.map((source) => source.id),
      retrievedAt: new Date().toISOString(),
      query,
      memoryVersion: 'memory',
      contextVersion: 'memory',
    }),
  };
  // Deterministic fixture checks wiring and provenance, not the accuracy of a real model.
  const call: NonNullable<BrainAgentsOptions['call']> = async (role, _prompt, input) => {
    seenInputs.push(JSON.stringify(input));
    const data = input as {
      specifications?: { sourceId: string; lines: { quote: string }[] }[];
      code?: { sourceId: string; lines: { quote: string }[] }[];
    };
    let value: unknown;
    if (role === 'reader') {
      if (noRequirements) {
        return {
          value: {
            summary: 'The approved references do not describe this feature.',
            requirements: [],
          },
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      const source = data.specifications![0];
      value = {
        summary: 'One rule',
        requirements: [
          {
            id: 'R1',
            statement: 'Never send raw arguments.',
            scope: 'Hook payload',
            citation: {
              sourceId: source.sourceId,
              line: 1,
              endLine: 2,
              quote: source.lines.map((line) => line.quote).join('\n'),
            },
          },
        ],
      };
    } else if (role === 'comparison') {
      const source = data.code![0];
      const quote = source.lines.map((line) => line.quote).join('\n');
      value = {
        checks: [
          {
            requirementId: 'R1',
            outcome: quote.includes('arguments') ? 'difference' : 'aligned',
            explanation: 'Fixture explanation',
            evidence: [{ sourceId: source.sourceId, line: 1, endLine: source.lines.length, quote }],
          },
        ],
      };
    } else {
      value = {
        dossiers: [
          {
            requirementId: 'R1',
            title: 'Payload review',
            question: 'Should this be corrected?',
            limitation: 'Test stub; no code executed.',
          },
        ],
      };
    }
    return { value, inputTokens: 0, outputTokens: 0 };
  };
  service = new BrainAgents({
    dbPath: resolve(root, 'brain.db'),
    projectsPath,
    model: 'test',
    requestTimeoutMs: 0,
    call,
    memory,
  });
  await service.init();
  config.viewerToken = 'test-viewer';
  access = new AccessStore(resolve(root, 'access.db'));
  await access.init();
  const workstationAccount = await access.saveAccount(
    { name: 'MCP developer', email: 'mcp@example.test', teamIds: [], enabled: true },
    'test',
  );
  const workstation = await access.issue(workstationAccount.id, 'MCP client', null, 'test');
  const authorization = `Bearer ${workstation.secret}`;
  app = Fastify();
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    request.accessPrincipal = token ? await access!.authenticate(token) : null;
  });
  app.addHook('onRequest', requireBrainAccess);
  registerBrainMcp(app, service);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const url = new URL(`http://127.0.0.1:${address.port}/api/brain/mcp`);
  client = new Client({ name: 'developer-agent-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization } },
    }),
  );
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'brain_get_analysis',
    'brain_get_project_context',
    'brain_list_projects',
    'brain_start_analysis',
    'brain_submit_change',
  ]);
  const projects = await client.callTool({ name: 'brain_list_projects', arguments: {} });
  assert.match(JSON.stringify(projects.structuredContent), /dashboard/);
  assert.doesNotMatch(JSON.stringify(projects), /repoPath|test-viewer/);
  assert.deepEqual((projects.structuredContent as { submissionLimits: unknown }).submissionLimits, {
    ...brainConfig.submission,
    maxRequestBytes: brainConfig.mcp.maxRequestBytes,
  });
  const context = await client.callTool({
    name: 'brain_get_project_context',
    arguments: { projectId: 'dashboard', feature: 'Protect hook arguments', commit: baseline },
  });
  assert.match(JSON.stringify(context.structuredContent), /Never send raw arguments/);
  assert.equal(seenInputs.length, 0);

  const start = await client.callTool({
    name: 'brain_submit_change',
    arguments: {
      projectId: 'dashboard',
      feature: 'Protect hook arguments',
      baselineCommit: baseline,
      files: [{ path: 'hook.js', content: 'send({ arguments: "synthetic test" });' }],
    },
  });
  assert.equal(start.isError, undefined);
  assert.equal((start.structuredContent as { requestTimeoutMs: number }).requestTimeoutMs, 0);
  const id = (start.structuredContent as { id: string }).id;
  await service.wait();
  const result = await client.callTool({
    name: 'brain_get_analysis',
    arguments: { analysisId: id },
  });
  const output = result.structuredContent as {
    status: string;
    submission: { baselineCommit: string };
    findings: { outcome: string }[];
    retrieval: unknown;
    noConclusionReason?: string;
  };
  assert.equal(output.status, 'succeeded');
  assert.equal(output.submission.baselineCommit, baseline);
  assert.equal(output.findings[0].outcome, 'difference');
  assert.deepEqual(output.retrieval, (await service.detail(id)).retrieval);
  assert.ok(output.retrieval);
  assert.equal(output.noConclusionReason, undefined);
  assert.equal(
    await readFile(resolve(root, 'hook.js'), 'utf8'),
    'send({ summary: "Terminal command" });',
  );
  assert.ok(seenInputs.some((input) => input.includes('synthetic test')));

  for (const path of ['../outside.js', '.env', 'README.md', 'other.js']) {
    const rejected = await client.callTool({
      name: 'brain_submit_change',
      arguments: {
        projectId: 'dashboard',
        feature: 'Invalid scope',
        baselineCommit: baseline,
        files: [{ path, content: 'rejected' }],
      },
    });
    assert.equal(rejected.isError, true, path);
  }
  const invalid = await client.callTool({
    name: 'brain_start_analysis',
    arguments: { projectId: 'dashboard', commit: 'HEAD', feature: 'Invalid revision' },
  });
  assert.equal(invalid.isError, true);
  const unknown = await client.callTool({
    name: 'brain_get_analysis',
    arguments: { analysisId: 'missing' },
  });
  assert.equal(unknown.isError, true);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: {
          authorization,
          origin: 'https://untrusted.invalid',
          'content-type': 'application/json',
        },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await fetch(url, { headers: { authorization } })).status, 405);
  assert.equal(
    (await fetch(url, { headers: { authorization: 'Bearer test-viewer' } })).status,
    401,
    'a dashboard viewer credential cannot authenticate the MCP',
  );

  const committed = await client.callTool({
    name: 'brain_start_analysis',
    arguments: {
      projectId: 'dashboard',
      commit: baseline,
      feature: 'Protect hook arguments',
      workItemId: 'work-mcp',
      ticket: 'HM-42',
      originSessionId: 'codex-mcp',
      parentRunId: id,
    },
  });
  await service.wait();
  assert.equal((committed.structuredContent as { requestTimeoutMs: number }).requestTimeoutMs, 0);
  const committedRun = await service.detail((committed.structuredContent as { id: string }).id);
  assert.equal(committedRun.submission, undefined);
  assert.deepEqual(committedRun.correlation, {
    workItemId: 'work-mcp',
    ticket: 'HM-42',
    originSessionId: `${workstationAccount.id}/${workstation.token.id}/codex-mcp`,
    parentRunId: id,
    developerId: workstationAccount.id,
    workstationId: workstation.token.id,
  });
  assert.equal(committedRun.findings[0].outcome, 'aligned');
  const saved = await service.detail(id);
  assert.equal(saved.findings[0].outcome, 'difference');

  noRequirements = true;
  const noConclusion = await client.callTool({
    name: 'brain_start_analysis',
    arguments: {
      projectId: 'dashboard',
      commit: baseline,
      feature: 'Feature outside approved references',
    },
  });
  await service.wait();
  const empty = await client.callTool({
    name: 'brain_get_analysis',
    arguments: { analysisId: (noConclusion.structuredContent as { id: string }).id },
  });
  const emptyOutput = empty.structuredContent as {
    status: string;
    coverage: string;
    requirements: unknown[];
    noConclusionReason: string;
    retrieval: unknown;
  };
  assert.equal(emptyOutput.status, 'succeeded');
  assert.equal(emptyOutput.coverage, 'no_conclusion');
  assert.deepEqual(emptyOutput.requirements, []);
  assert.equal(
    emptyOutput.noConclusionReason,
    'No applicable requirements extracted: The approved references do not describe this feature. No conclusion about the code.',
  );
  assert.ok(emptyOutput.noConclusionReason.length <= brainConfig.analysis.maxTextCharacters);
  assert.ok(emptyOutput.retrieval);
});

test('authenticated MCP accepts complete larger submissions and retains explicit upload limits', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-mcp-capacity-'));
  const access = new AccessStore(resolve(root, 'access.db'));
  const app = Fastify();
  const boundedApp = Fastify();
  const client = new Client({ name: 'capacity-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await Promise.all([app.close(), boundedApp.close()]);
    await access.close();
    await rm(root, { recursive: true, force: true });
  });
  await access.init();
  const account = await access.saveAccount(
    { name: 'Capacity developer', email: 'capacity@example.test', teamIds: [], enabled: true },
    'test',
  );
  const workstation = await access.issue(account.id, 'MCP capacity', null, 'test');
  const authorization = `Bearer ${workstation.secret}`;
  const project = {
    id: 'capacity',
    name: 'Capacity fixture',
    scope: 'Upload boundary verification',
    codePaths: ['src/'],
    specifications: 0,
    specificationPaths: [],
    repositoryRemote: undefined,
    enabled: true,
    codeAccess: 'local',
    readiness: undefined,
  };
  const starts: Parameters<BrainAgents['start']>[] = [];
  // This service boundary stub verifies transport and schema without invoking a model.
  const service: Pick<BrainAgents, 'state' | 'context' | 'start' | 'detail'> = {
    async state() {
      return {
        configured: true,
        reason: '',
        provider: 'test',
        model: 'test',
        requestTimeoutMs: 0,
        projects: [project],
        runs: [],
        activeRunId: null,
      };
    },
    async context() {
      throw new Error('Context is not used by this transport test.');
    },
    async detail() {
      throw new Error('Analysis polling is not used by this transport test.');
    },
    async start(...args) {
      starts.push(args);
      return {
        id: 'capacity-review',
        projectId: project.id,
        projectName: project.name,
        scope: project.scope,
        projectVersion: 'fixture',
        status: 'running',
        stage: 'Capturing sources',
        startedAt: new Date().toISOString(),
        model: 'test',
        events: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        sources: [],
        requirements: [],
        findings: [],
        changedFiles: [],
      };
    },
  };
  for (const server of [app, boundedApp]) {
    server.addHook('onRequest', async (request: FastifyRequest) => {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      request.accessPrincipal = token ? await access.authenticate(token) : null;
    });
    server.addHook('onRequest', requireBrainAccess);
  }
  registerBrainMcp(app, service);
  const maxRequestBytes = brainConfig.mcp.maxRequestBytes;
  try {
    brainConfig.mcp.maxRequestBytes = 1024;
    registerBrainMcp(boundedApp, service);
  } finally {
    brainConfig.mcp.maxRequestBytes = maxRequestBytes;
  }
  await Promise.all([
    app.listen({ host: '127.0.0.1', port: 0 }),
    boundedApp.listen({ host: '127.0.0.1', port: 0 }),
  ]);
  const address = app.server.address() as { port: number };
  const url = new URL(`http://127.0.0.1:${address.port}/api/brain/mcp`);
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization } } }),
  );
  const discovery = await client.callTool({ name: 'brain_list_projects', arguments: {} });
  assert.deepEqual(
    (discovery.structuredContent as { submissionLimits: unknown }).submissionLimits,
    { ...brainConfig.submission, maxRequestBytes },
  );
  const argumentsBase = {
    projectId: project.id,
    feature: 'Capture the whole local change',
    baselineCommit: 'a'.repeat(40),
  };
  const files = Array.from({ length: 75 }, (_, index) => ({
    path: `src/module-${index}.ts`,
    content: `// module ${index}\n${'const answer = "é";\n'.repeat(600)}`,
  }));
  const payload = { ...argumentsBase, files };
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 500_000);
  assert.ok(files.length > 60);
  const accepted = await client.callTool({ name: 'brain_submit_change', arguments: payload });
  assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0][4], files, 'every full file reaches the analysis service unchanged');
  assert.equal(starts[0][5]?.developerId, account.id);
  assert.equal(starts[0][5]?.workstationId, workstation.token.id);

  const tooMany = await client.callTool({
    name: 'brain_submit_change',
    arguments: {
      ...argumentsBase,
      files: Array.from({ length: brainConfig.submission.maxFiles + 1 }, (_, index) => ({
        path: `src/deleted-${index}.ts`,
        content: null,
      })),
    },
  });
  assert.equal(tooMany.isError, true);
  assert.match(
    JSON.stringify(tooMany),
    new RegExp(`exceeds ${brainConfig.submission.maxFiles} files`),
  );

  const unicodeContent = '€'.repeat(Math.floor(brainConfig.submission.maxFileBytes / 3) + 1);
  assert.ok(unicodeContent.length < brainConfig.submission.maxFileBytes);
  assert.ok(Buffer.byteLength(unicodeContent, 'utf8') > brainConfig.submission.maxFileBytes);
  const tooLarge = await client.callTool({
    name: 'brain_submit_change',
    arguments: {
      ...argumentsBase,
      files: [{ path: 'src/unicode.ts', content: unicodeContent }],
    },
  });
  assert.equal(tooLarge.isError, true);
  assert.match(JSON.stringify(tooLarge), /UTF-8 bytes/);
  assert.equal(starts.length, 1, 'invalid submissions never start an analysis');

  const boundedAddress = boundedApp.server.address() as { port: number };
  const overflow = await fetch(`http://127.0.0.1:${boundedAddress.port}/api/brain/mcp`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: payload, id: 1 }),
  });
  assert.equal(overflow.status, 413, 'the configured HTTP transport limit still applies');
  assert.equal(starts.length, 1);
});
