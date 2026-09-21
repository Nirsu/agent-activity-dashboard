import type { FastifyInstance } from 'fastify';
import type { BrainAgents } from './analysis/service.js';
import type { Citation } from './analysis/types.js';
import { fail } from './analysis/validation.js';
import { brainConfig } from './config.js';
import type { CogneeClient } from './cognee/client.js';
import type { MemoryStore } from './memory/store.js';
import type { SourceRegistration } from './memory/types.js';
import type { Source } from './sources.js';

export type MemoryGraphNode = {
  id: string;
  kind: 'project' | 'source' | 'requirement' | 'finding' | 'review' | 'entity';
  label: string;
  summary: string;
  status?: string;
  sourceId?: string;
  analysisId?: string;
  line?: number;
};

export type MemoryGraph = {
  scopes: { id: string; label: string }[];
  scope: { id: string; label: string; description: string };
  nodes: MemoryGraphNode[];
  edges: {
    id: string;
    source: string;
    target: string;
    label: string;
    origin: 'recorded' | 'extracted';
  }[];
  warning?: string;
  truncated?: boolean;
};

type ProjectSnapshot = Awaited<ReturnType<BrainAgents['graphSnapshots']>>[number];
const hiddenCogneeNodeTypes = new Set([
  'DocumentChunk',
  'TextDocument',
  'TextSummary',
  'EntityType',
]);
type GraphMemory = {
  store: Pick<MemoryStore, 'sources' | 'capture'>;
  options: { cognee: Pick<CogneeClient, 'graph'> };
};

function createGraph(scope: MemoryGraph['scope']): MemoryGraph {
  return { scope, scopes: [], nodes: [], edges: [] };
}

function addEdge(
  graph: MemoryGraph,
  source: string,
  target: string,
  label: string,
  origin: 'recorded' | 'extracted' = 'recorded',
) {
  // Old records may reference a source that is absent from the selected snapshot.
  if (
    !graph.nodes.some((node) => node.id === source) ||
    !graph.nodes.some((node) => node.id === target)
  ) {
    return;
  }
  const id = JSON.stringify([source, target, label, origin]);
  if (!graph.edges.some((edge) => edge.id === id)) {
    graph.edges.push({ id, source, target, label, origin });
  }
}

function addSources(graph: MemoryGraph, sources: Omit<Source, 'content'>[], analysisId?: string) {
  for (const source of sources) {
    const id = `source:${source.id}`;
    graph.nodes.push({
      id,
      kind: 'source',
      label: source.title,
      summary: source.summary,
      status: analysisId ? `${source.status} · analysis capture` : source.status,
      sourceId: source.id,
      analysisId,
    });
    addEdge(graph, graph.scope.id, id, 'captures');
  }
}

function sameCitation(left: Citation, right: Citation) {
  return left.sourceId === right.sourceId && left.line === right.line && left.quote === right.quote;
}

function addReview(
  graph: MemoryGraph,
  findingId: string,
  review: { id: string; decision: string; note: string } | undefined,
  analysisId?: string,
) {
  if (!review) {
    return;
  }
  const id = `review:${review.id}`;
  graph.nodes.push({
    id,
    kind: 'review',
    label: `Human review · ${review.decision.replaceAll('_', ' ')}`,
    summary: review.note,
    status: review.decision,
    analysisId,
  });
  addEdge(graph, id, findingId, 'reviews');
}

export function buildProjectGraph(snapshot: ProjectSnapshot): MemoryGraph {
  const { run } = snapshot;
  const description = !run
    ? 'Registered project memory. No successful analysis yet.'
    : `${snapshot.current ? 'Latest successful analysis' : 'Historical analysis · source or project configuration differs'} · ${run.finishedAt ?? run.startedAt}. Recorded citations and latest human reviews.`;
  const graph = createGraph({ id: `project:${snapshot.id}`, label: snapshot.name, description });
  graph.nodes.push({
    id: graph.scope.id,
    kind: 'project',
    label: snapshot.name,
    summary: run?.scope ?? snapshot.scope,
    status: !run ? 'empty' : snapshot.current ? 'current' : 'historical',
    analysisId: run?.id,
  });
  if (!run) {
    return graph;
  }
  addSources(graph, run.sources, run.id);

  for (const requirement of run.requirements) {
    const id = `requirement:${requirement.id}`;
    graph.nodes.push({
      id,
      kind: 'requirement',
      label: requirement.statement,
      summary: requirement.scope,
      sourceId: requirement.citation.sourceId,
      line: requirement.citation.line,
      analysisId: run.id,
    });
    addEdge(graph, id, `source:${requirement.citation.sourceId}`, 'cites');
  }

  for (const finding of run.findings) {
    const id = `finding:${finding.id}`;
    graph.nodes.push({
      id,
      kind: 'finding',
      label: finding.title,
      summary: `${finding.explanation}\n\n${finding.question}\n\n${finding.limitation}`,
      status: finding.outcome,
      analysisId: run.id,
      sourceId: finding.decision.sourceId,
      line: finding.decision.line,
    });
    const requirements = run.requirements.filter((requirement) =>
      finding.requirementId !== undefined
        ? requirement.id === finding.requirementId
        : sameCitation(requirement.citation, finding.decision),
    );
    // Legacy findings lack the identifier: only join an unambiguous citation.
    if (requirements.length === 1) {
      addEdge(graph, id, `requirement:${requirements[0].id}`, 'checks');
    }
    addEdge(graph, id, `source:${finding.decision.sourceId}`, 'cites');
    for (const evidence of finding.evidence) {
      addEdge(graph, id, `source:${evidence.sourceId}`, 'observes');
    }
    addReview(graph, id, finding.reviews[0], run.id);
  }
  return graph;
}

export async function addCurrentMemory(graph: MemoryGraph, memory: GraphMemory, concepts = true) {
  const projectId = graph.scope.id.startsWith('project:')
    ? graph.scope.id.slice('project:'.length)
    : undefined;
  const registrations = memory.store
    .sources()
    .filter((source) => source.approval !== 'withdrawn' && source.kind !== 'review')
    .filter((source) =>
      projectId ? source.shared || source.projectIds.includes(projectId) : source.shared,
    );
  const indexed = new Map<string, SourceRegistration>();
  for (const registration of registrations) {
    const source = registration.currentSourceId
      ? memory.store.capture(registration.currentSourceId)
      : undefined;
    const id = source ? `source:${source.id}` : `registration:${registration.id}`;
    const node: MemoryGraphNode = {
      id,
      kind: 'source',
      label: registration.title,
      summary: source?.summary ?? 'Waiting for the first source capture.',
      status: `${registration.approval} · ${registration.status}${registration.shared ? ' · shared' : ''}`,
      sourceId: source?.id,
    };
    const existing = graph.nodes.findIndex((value) => value.id === id);
    if (existing < 0) {
      graph.nodes.push(node);
    } else {
      graph.nodes[existing] = node;
    }
    graph.edges = graph.edges.filter(
      (edge) => !(edge.source === graph.scope.id && edge.target === id),
    );
    addEdge(
      graph,
      graph.scope.id,
      id,
      registration.shared ? 'includes shared source' : 'registers',
    );
    if (
      registration.approval === 'approved' &&
      registration.status === 'ready' &&
      registration.datasetId &&
      source
    ) {
      indexed.set(registration.datasetId, registration);
    }
  }
  for (const child of registrations) {
    const parent = registrations.find((source) => source.id === child.parentSourceId);
    if (parent && !child.approvalBeforeRemoval) {
      addEdge(
        graph,
        parent.currentSourceId ? `source:${parent.currentSourceId}` : `registration:${parent.id}`,
        child.currentSourceId ? `source:${child.currentSourceId}` : `registration:${child.id}`,
        'contains subpage',
      );
    }
  }
  const scopeNode = graph.nodes.find((node) => node.id === graph.scope.id);
  if (scopeNode && !scopeNode.analysisId && registrations.length) {
    scopeNode.status = 'registered memory';
  }
  graph.scope.description +=
    ' Current registered sources are shown with their synchronization status. Extracted concepts are not approved requirements.';
  if (concepts && indexed.size) {
    await addExtractedGraph(graph, memory, indexed);
  }
  limitGraph(graph);
  return graph;
}

async function addExtractedGraph(
  graph: MemoryGraph,
  memory: GraphMemory,
  indexed: Map<string, SourceRegistration>,
) {
  try {
    const extracted = await memory.options.cognee.graph([...indexed.keys()]);
    const nodes: MemoryGraphNode[] = [];
    const included = new Set<string>();
    for (const entity of extracted.nodes) {
      const registration = indexed.get(entity.datasetId);
      const source = registration && memory.store.capture(registration.currentSourceId!);
      if (!source || !entity.id.startsWith(`${entity.datasetId}:`)) {
        throw new Error('Unscoped extracted graph response.');
      }
      // Captures already have source nodes; storage records and type buckets are not concepts.
      if (hiddenCogneeNodeTypes.has(entity.type)) {
        continue;
      }
      const text = typeof entity.properties.text === 'string' ? entity.properties.text : '';
      const description =
        typeof entity.properties.description === 'string' ? entity.properties.description : '';
      const position = text ? source.content.indexOf(text) : -1;
      const id = `entity:${entity.id}`;
      included.add(id);
      nodes.push({
        id,
        kind: 'entity',
        label: entity.label,
        summary: `${entity.type} · Extracted from ${source.title}.\n${description || text}`.slice(
          0,
          brainConfig.analysis.maxTextCharacters,
        ),
        status: 'model extracted',
        sourceId: source.id,
        line: position < 0 ? undefined : source.content.slice(0, position).split('\n').length,
      });
    }
    for (const edge of extracted.edges) {
      if (
        !indexed.has(edge.datasetId) ||
        !edge.source.startsWith(`${edge.datasetId}:`) ||
        !edge.target.startsWith(`${edge.datasetId}:`)
      ) {
        throw new Error('Unscoped extracted graph edge.');
      }
    }
    graph.nodes.push(...nodes);
    for (const node of nodes) {
      addEdge(graph, `source:${node.sourceId}`, node.id, 'extracted from capture', 'extracted');
    }
    for (const edge of extracted.edges) {
      const source = `entity:${edge.source}`;
      const target = `entity:${edge.target}`;
      if (included.has(source) && included.has(target)) {
        addEdge(graph, source, target, edge.label, 'extracted');
      }
    }
    graph.truncated = extracted.truncated;
  } catch {
    graph.warning =
      'Extracted relationships are unavailable. Recorded memory links remain visible.';
    graph.scope.description += ` ${graph.warning}`;
  }
}

function limitGraph(graph: MemoryGraph) {
  if (graph.nodes.length > brainConfig.cognee.maxGraphNodes) {
    graph.nodes = graph.nodes.slice(0, brainConfig.cognee.maxGraphNodes);
    graph.truncated = true;
  }
  const included = new Set(graph.nodes.map((node) => node.id));
  graph.edges = graph.edges.filter(
    (edge) => included.has(edge.source) && included.has(edge.target),
  );
  if (graph.edges.length > brainConfig.cognee.maxGraphEdges) {
    graph.edges = graph.edges.slice(0, brainConfig.cognee.maxGraphEdges);
    graph.truncated = true;
  }
  if (graph.truncated) {
    graph.scope.description += ' The graph is limited to the configured display size.';
  }
}

function buildSharedGraph(): MemoryGraph {
  const graph = createGraph({
    id: 'shared',
    label: 'Shared memory',
    description: 'Sources explicitly registered for use across projects.',
  });
  graph.nodes.push({
    id: graph.scope.id,
    kind: 'project',
    label: graph.scope.label,
    summary: graph.scope.description,
  });
  return graph;
}

export function registerMemoryGraph(
  app: FastifyInstance,
  memory: GraphMemory,
  agentsService: Pick<BrainAgents, 'graphSnapshots'>,
) {
  app.get<{ Querystring: { scope?: string; view?: 'knowledge' | 'analysis'; concepts?: boolean } }>(
    '/api/brain/graph',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', pattern: '^(shared|project:[A-Za-z0-9_-]+)$' },
            view: { type: 'string', enum: ['knowledge', 'analysis'] },
            concepts: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const projects = await agentsService.graphSnapshots();
      const defaultProject = projects[0];
      const selected =
        request.query.scope ?? (defaultProject ? `project:${defaultProject.id}` : 'shared');
      let graph: MemoryGraph;
      if (selected === 'shared') {
        graph = buildSharedGraph();
      } else {
        const projectId = selected.slice('project:'.length);
        const project = projects.find((project) => project.id === projectId);
        if (!project) {
          fail('Graph project is not registered.', 404);
        }
        graph = buildProjectGraph(
          request.query.view === 'analysis' ? project : { ...project, run: undefined },
        );
        if (request.query.view !== 'analysis') {
          graph.scope.description =
            'Current knowledge sources and their page hierarchy. Code evidence is available in the analysis view.';
        }
      }
      graph.scopes = [
        ...projects.map((project) => ({ id: `project:${project.id}`, label: project.name })),
        { id: 'shared', label: 'Shared memory' },
      ];
      if (request.query.view === 'analysis') {
        limitGraph(graph);
        return graph;
      }
      return addCurrentMemory(graph, memory, request.query.concepts === true);
    },
  );
}
