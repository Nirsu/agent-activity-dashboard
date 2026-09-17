import { fixtureGit } from './brain/testing/git.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';
import { BrainAgents } from './brain/analysis/service.js';
import { requireBrainAccess } from './brain/access.js';
import { registerBrainMcp } from './brain/mcp.js';
import type { BrainAgentsOptions } from './brain/analysis/types.js';

test('a real MCP client discovers context, submits changes and reads preserved findings without writing the checkout', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-mcp-'));
  let service: BrainAgents | undefined;
  let app: ReturnType<typeof Fastify> | undefined;
  let client: Client | undefined;
  const previousToken = config.viewerToken;
  t.after(async () => {
    await client?.close();
    await app?.close();
    await service?.close();
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
    call,
    memory,
  });
  await service.init();
  config.viewerToken = 'test-viewer';
  app = Fastify();
  app.addHook('onRequest', requireBrainAccess);
  registerBrainMcp(app, service);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const url = new URL(`http://127.0.0.1:${address.port}/api/brain/mcp`);
  client = new Client({ name: 'developer-agent-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer test-viewer' } },
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
  };
  assert.equal(output.status, 'succeeded');
  assert.equal(output.submission.baselineCommit, baseline);
  assert.equal(output.findings[0].outcome, 'difference');
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
          authorization: 'Bearer test-viewer',
          origin: 'https://untrusted.invalid',
          'content-type': 'application/json',
        },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(url, { headers: { authorization: 'Bearer test-viewer' } })).status,
    405,
  );

  const committed = await client.callTool({
    name: 'brain_start_analysis',
    arguments: { projectId: 'dashboard', commit: baseline, feature: 'Protect hook arguments' },
  });
  await service.wait();
  const committedRun = await service.detail((committed.structuredContent as { id: string }).id);
  assert.equal(committedRun.submission, undefined);
  assert.equal(committedRun.findings[0].outcome, 'aligned');
  const saved = await service.detail(id);
  assert.equal(saved.findings[0].outcome, 'difference');
});
