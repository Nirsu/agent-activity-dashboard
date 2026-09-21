import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import Sqlite from 'better-sqlite3';
import { BrainAgents } from './brain/analysis/service.js';
import { readProjects } from './brain/analysis/projects.js';
import type { AnalysisRun } from './brain/analysis/types.js';
import type { SourceRegistration } from './brain/memory/types.js';
import { addCurrentMemory, buildProjectGraph, registerMemoryGraph } from './brain/graph.js';
import { makeSource } from './brain/sources.js';

function analysis(): AnalysisRun {
  const specification = makeSource('code', 'README.md', 'Keep payloads sanitized.', 'commit');
  specification.status = 'published';
  const code = makeSource('code', 'hooks/hook.js', 'send(safeSummary);', 'commit');
  const unreferenced = makeSource('code', 'hooks/other.js', 'export {};', 'commit');
  const citation = { sourceId: specification.id, line: 1, quote: specification.content };
  return {
    id: 'success',
    projectId: 'dashboard',
    projectName: 'Dashboard',
    scope: 'Hook payloads',
    projectVersion: 'version',
    status: 'succeeded',
    stage: 'Complete',
    startedAt: '2026-09-16T10:00:00Z',
    model: 'mock',
    events: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    sources: [specification, code, unreferenced],
    requirements: [
      { id: 'R1', statement: 'Sanitize payloads', scope: 'Hooks', citation },
      {
        id: 'R2',
        statement: 'Another requirement',
        scope: 'Hooks',
        citation: { ...citation, quote: 'Different exact quote' },
      },
    ],
    findings: [
      {
        id: 'F1',
        title: 'Sanitize payloads',
        outcome: 'difference',
        explanation: 'Needs review',
        question: 'Is this sufficient?',
        limitation: 'Only one file',
        decision: citation,
        evidence: [{ sourceId: code.id, line: 1, quote: code.content }],
        reviews: [
          {
            id: 'latest',
            decision: 'investigate',
            note: 'Check the edge case',
            at: 'now',
            actor: 'Pilot',
          },
          {
            id: 'older',
            decision: 'confirmed',
            note: 'Replaced review',
            at: 'before',
            actor: 'Pilot',
          },
        ],
      },
    ],
    changedFiles: [],
  };
}

function emptyMemory() {
  return {
    store: { sources: () => [], capture: () => undefined },
    options: { cognee: { graph: async () => ({ nodes: [], edges: [], truncated: false }) } },
  };
}

test('Project graph uses recorded citations, includes unreferenced sources and latest reviews', () => {
  const run = analysis();
  const graph = buildProjectGraph({
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Hooks',
    current: true,
    run,
  });
  assert.equal(graph.nodes.filter((node) => node.kind === 'source').length, 3);
  assert.equal(graph.nodes.filter((node) => node.kind === 'requirement').length, 2);
  assert.equal(graph.nodes.filter((node) => node.kind === 'review').length, 1);
  assert.ok(
    graph.edges.some((edge) => edge.source === 'finding:F1' && edge.target === 'requirement:R1'),
  );
  assert.ok(
    !graph.edges.some((edge) => edge.source === 'finding:F1' && edge.target === 'requirement:R2'),
  );
  assert.ok(
    graph.edges.every(
      (edge) =>
        graph.nodes.some((node) => node.id === edge.source) &&
        graph.nodes.some((node) => node.id === edge.target),
    ),
  );
  assert.equal(graph.nodes.find((node) => node.id === 'requirement:R1')?.analysisId, run.id);
  assert.ok(
    graph.nodes.every((node) => !('content' in node)),
    'Full source bodies are not sent by the graph',
  );

  run.requirements[1].citation = run.requirements[0].citation;
  const ambiguous = buildProjectGraph({
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Hooks',
    current: true,
    run,
  });
  assert.equal(
    ambiguous.edges.filter((edge) => edge.label === 'checks').length,
    0,
    'Shared citations must not imply a guessed requirement join',
  );

  run.findings[0].requirementId = 'R2';
  const identified = buildProjectGraph({
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Hooks',
    current: true,
    run,
  });
  assert.deepEqual(
    identified.edges.filter((edge) => edge.label === 'checks').map((edge) => edge.target),
    ['requirement:R2'],
    'New findings retain the exact requirement even when citations are shared',
  );

  run.findings[0].requirementId = 'missing';
  const missing = buildProjectGraph({
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Hooks',
    current: true,
    run,
  });
  assert.equal(missing.edges.filter((edge) => edge.label === 'checks').length, 0);
});

test('Current graph shows memory before any analysis and isolates project and approval scope', async () => {
  const capture = makeSource('notion', 'Specification', 'Exact specification text.', 'revision');
  const registrations: SourceRegistration[] = [
    {
      id: 'approved',
      kind: 'notion',
      title: 'Approved source',
      projectIds: ['dashboard'],
      shared: false,
      mandatory: true,
      approval: 'approved',
      status: 'ready',
      currentSourceId: capture.id,
      datasetId: 'dataset-approved',
    },
    {
      id: 'draft',
      kind: 'notion',
      title: 'Draft source',
      projectIds: ['dashboard'],
      shared: false,
      mandatory: false,
      approval: 'draft',
      status: 'pending',
      datasetId: 'dataset-draft',
    },
    {
      id: 'withdrawn',
      kind: 'notion',
      title: 'Withdrawn source',
      projectIds: ['dashboard'],
      shared: false,
      mandatory: false,
      approval: 'withdrawn',
      status: 'withdrawn',
      datasetId: 'dataset-withdrawn',
    },
    {
      id: 'other',
      kind: 'notion',
      title: 'Unrelated source',
      projectIds: ['mobile'],
      shared: false,
      mandatory: false,
      approval: 'approved',
      status: 'ready',
      datasetId: 'dataset-other',
    },
    {
      id: 'shared',
      kind: 'notion',
      title: 'Shared source',
      projectIds: [],
      shared: true,
      mandatory: true,
      approval: 'draft',
      status: 'pending',
    },
  ];
  const graph = buildProjectGraph({
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Hooks',
    current: false,
    run: undefined,
  });
  await addCurrentMemory(graph, {
    store: {
      sources: () => registrations,
      capture: (id) => (id === capture.id ? capture : undefined),
    },
    options: {
      cognee: {
        graph: async (datasets) => {
          assert.deepEqual(datasets, ['dataset-approved']);
          return {
            nodes: [
              {
                id: 'dataset-approved:entity',
                datasetId: 'dataset-approved',
                label: 'Privacy',
                type: 'Entity',
                properties: { description: 'An extracted concept' },
              },
              {
                id: 'dataset-approved:hooks',
                datasetId: 'dataset-approved',
                label: 'Hooks',
                type: 'Entity',
                properties: {},
              },
              ...['DocumentChunk', 'TextDocument', 'TextSummary', 'EntityType'].map((type) => ({
                id: `dataset-approved:${type}`,
                datasetId: 'dataset-approved',
                label: `${type}_internal_identifier`,
                type,
                properties: { text: capture.content },
              })),
            ],
            edges: [
              {
                id: 'concept-link',
                datasetId: 'dataset-approved',
                source: 'dataset-approved:entity',
                target: 'dataset-approved:hooks',
                label: 'protects',
              },
              {
                id: 'storage-link',
                datasetId: 'dataset-approved',
                source: 'dataset-approved:DocumentChunk',
                target: 'dataset-approved:entity',
                label: 'contains',
              },
              {
                id: 'type-link',
                datasetId: 'dataset-approved',
                source: 'dataset-approved:entity',
                target: 'dataset-approved:EntityType',
                label: 'is_a',
              },
            ],
            truncated: false,
          };
        },
      },
    },
  });
  assert.equal(graph.nodes.filter((node) => node.kind === 'source').length, 3);
  assert.ok(!JSON.stringify(graph).includes('Unrelated source'));
  const entity = graph.nodes.find((node) => node.kind === 'entity');
  assert.equal(entity?.sourceId, capture.id);
  assert.equal(entity?.status, 'model extracted');
  assert.equal(
    entity?.line,
    undefined,
    'capture provenance must not invent an exact line for an entity',
  );
  assert.ok(graph.edges.some((edge) => edge.origin === 'extracted' && edge.target === entity?.id));
  assert.ok(graph.edges.some((edge) => edge.origin === 'recorded'));
  assert.deepEqual(
    graph.nodes.filter((node) => node.kind === 'entity').map((node) => node.label),
    ['Privacy', 'Hooks'],
  );
  assert.ok(!JSON.stringify(graph).includes('internal_identifier'));
  const conceptEdges = graph.edges.filter((edge) => edge.source.startsWith('entity:'));
  assert.equal(
    conceptEdges.length,
    1,
    'hiding storage nodes must not create inferred replacement edges',
  );
  assert.equal(conceptEdges[0].label, 'protects');
});

test('A Cognee failure or foreign response keeps recorded historical evidence but exposes no extracted data', async () => {
  const run = analysis();
  const source = run.sources[0];
  const registration: SourceRegistration = {
    id: 'source',
    kind: 'notion',
    title: 'Specification',
    projectIds: ['dashboard'],
    shared: false,
    mandatory: true,
    approval: 'approved',
    status: 'ready',
    datasetId: 'allowed',
    currentSourceId: source.id,
  };
  const memory = {
    store: { sources: () => [registration], capture: () => source },
    options: {
      cognee: {
        graph: async () => ({
          nodes: [
            {
              id: 'foreign:entity',
              datasetId: 'foreign',
              label: 'Forbidden',
              type: 'Entity',
              properties: {},
            },
          ],
          edges: [],
          truncated: false,
        }),
      },
    },
  };
  const graph = await addCurrentMemory(
    buildProjectGraph({ id: 'dashboard', name: 'Dashboard', scope: 'Hooks', current: false, run }),
    memory,
  );
  assert.equal(graph.nodes.filter((node) => node.kind === 'entity').length, 0);
  assert.ok(graph.nodes.some((node) => node.kind === 'finding'));
  assert.match(graph.warning ?? '', /unavailable/);
  assert.match(graph.scope.description, /Historical analysis/);
  registration.approval = 'withdrawn';
  const withdrawn = await addCurrentMemory(
    buildProjectGraph({ id: 'dashboard', name: 'Dashboard', scope: 'Hooks', current: false, run }),
    memory,
  );
  assert.ok(
    withdrawn.nodes
      .find((node) => node.sourceId === source.id)
      ?.status?.includes('analysis capture'),
  );
  assert.ok(withdrawn.nodes.some((node) => node.kind === 'finding' && node.analysisId === run.id));
  assert.equal(withdrawn.warning, undefined, 'withdrawn datasets must not be queried');
});

test('Graph endpoint selects the latest successful registered snapshot and marks changed configuration', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'brain-graph-'));
  const dbPath = resolve(root, 'brain.db');
  const projectsPath = resolve(root, 'projects.json');
  const project = {
    id: 'dashboard',
    name: 'Dashboard',
    scope: 'Hook payloads',
    repoPath: '.',
    specs: [{ kind: 'git', path: 'README.md' }],
    codePaths: ['hooks/hook.js'],
  };
  await writeFile(projectsPath, JSON.stringify([project]));
  const service = new BrainAgents({ dbPath, projectsPath });
  await service.init();
  const database = new Sqlite(dbPath);
  const run = analysis();
  run.projectVersion = createHash('sha256')
    .update(JSON.stringify((await readProjects(projectsPath))[0]))
    .digest('hex');
  const save = database.prepare('INSERT INTO brain_agent_runs (id, data) VALUES (?, ?)');
  save.run(run.id, JSON.stringify(run));
  save.run('other', JSON.stringify({ ...run, id: 'other', projectId: 'other' }));
  save.run('failed', JSON.stringify({ ...run, id: 'failed', status: 'failed' }));
  const app = Fastify();
  registerMemoryGraph(app, emptyMemory(), service);
  try {
    const knowledge = (await app.inject('/api/brain/graph')).json();
    assert.deepEqual(
      knowledge.nodes.map((node: { kind: string }) => node.kind),
      ['project'],
    );
    assert.equal(knowledge.nodes[0].analysisId, undefined);
    assert.match(knowledge.scope.description, /Current knowledge sources/);
    const response = await app.inject('/api/brain/graph?view=analysis');
    assert.equal(response.statusCode, 200);
    const graph = response.json();
    assert.equal(graph.scope.id, 'project:dashboard');
    assert.equal(graph.nodes[0].analysisId, 'success');
    assert.equal(
      graph.nodes[0].status,
      'historical',
      'legacy runs have no current memory generation',
    );
    assert.deepEqual(
      graph.scopes.map((scope: { id: string }) => scope.id),
      ['project:dashboard', 'shared'],
    );
    assert.ok(!response.body.includes(root), 'No local configuration paths are returned');
    assert.equal((await app.inject('/api/brain/graph?scope=project:other')).statusCode, 404);
    assert.equal((await app.inject('/api/brain/graph?scope=../bad')).statusCode, 400);
    assert.equal((await app.inject('/api/brain/graph?scope=demo')).statusCode, 400);
    assert.equal((await app.inject('/api/brain/graph?scope=shared')).json().scope.id, 'shared');
    await writeFile(projectsPath, JSON.stringify([{ ...project, scope: 'Changed scope' }]));
    const historical = (
      await app.inject('/api/brain/graph?scope=project:dashboard&view=analysis')
    ).json();
    assert.match(historical.scope.description, /Historical analysis/);
    assert.equal(historical.nodes[0].summary, 'Hook payloads');
  } finally {
    await app.close();
    database.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
