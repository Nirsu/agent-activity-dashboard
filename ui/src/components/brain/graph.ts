import { brainConfig } from './config';

export type GraphKind = 'project' | 'source' | 'requirement' | 'finding' | 'review' | 'entity';
export type GraphNode = {
  id: string;
  kind: GraphKind;
  label: string;
  summary: string;
  status?: string;
  sourceId?: string;
  analysisId?: string;
  line?: number;
};
export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  origin?: 'recorded' | 'extracted';
};
export type MemoryGraph = {
  scopes: { id: string; label: string }[];
  scope: { id: string; label: string; description: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  warning?: string;
  truncated?: boolean;
};
export type GraphPoint = { x: number; y: number };
export const graphKinds: { kind: GraphKind; label: string; color: string }[] = [
  { kind: 'project', label: 'Project', color: '#b2a0f4' },
  { kind: 'source', label: 'Source', color: '#71dbc6' },
  { kind: 'requirement', label: 'Requirement', color: '#e6ba72' },
  { kind: 'finding', label: 'Finding', color: '#79aff3' },
  { kind: 'review', label: 'Human review', color: '#ed98b5' },
  { kind: 'entity', label: 'Extracted concept', color: '#b9c59a' },
];

// Graph summaries are truncated previews. Keep captured sources untouched and
// strip only recognized Notion block markup, never arbitrary angle brackets.
export function sourcePreview(summary: string): string {
  if (!/^\s*<(?:callout|aside|table|empty-block|page)\b/i.test(summary)) {
    return summary;
  }
  return summary
    .replace(/<\/?(?:callout|aside|table|tr|td|th|br|empty-block|page)\b[^>]*>/gi, ' ')
    .replace(/<\/?(?:callout|aside|table|tr|td|th|br|empty-block|page)\b[^>]*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function connectedNodes(nodeId: string, edges: GraphEdge[]) {
  const ids = new Set([nodeId]);
  for (const edge of edges) {
    if (edge.source === nodeId) {
      ids.add(edge.target);
    }
    if (edge.target === nodeId) {
      ids.add(edge.source);
    }
  }
  return ids;
}

export function filterGraph(graph: MemoryGraph, query: string, kinds: GraphKind[]) {
  const term = query.trim().toLocaleLowerCase();
  const eligible = graph.nodes.filter((node) => kinds.includes(node.kind));
  const matches = eligible.filter((node) =>
    `${node.label} ${node.summary}`.toLocaleLowerCase().includes(term),
  );
  const matchingIds = new Set(matches.map((node) => node.id));
  const contextIds = new Set(matchingIds);
  if (term) {
    for (const edge of graph.edges) {
      if (matchingIds.has(edge.source) || matchingIds.has(edge.target)) {
        contextIds.add(edge.source);
        contextIds.add(edge.target);
      }
    }
  }
  const nodes = eligible.filter((node) => contextIds.has(node.id));
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    matchingIds,
  };
}

export function graphViewport(positions: Map<string, GraphPoint>, visibleIds: Set<string>) {
  const points = [...positions].filter(([id]) => visibleIds.has(id)).map(([, point]) => point);
  if (points.length === 0) {
    return { x: 0, y: 0, size: brainConfig.graph.linkDistance * 4 };
  }
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    size:
      Math.max(brainConfig.graph.linkDistance, right - left, bottom - top) +
      brainConfig.graph.linkDistance * 2,
  };
}

// A deterministic layout: the same captured graph keeps its position when filtering.
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Map<string, GraphPoint> {
  const settings = brainConfig.graph;
  const points = nodes.map((_, index) => {
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const radius = settings.linkDistance * Math.sqrt(index);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  for (let iteration = 0; iteration < settings.layoutIterations; iteration++) {
    const forces = points.map((point) => ({
      x: -point.x * settings.gravity,
      y: -point.y * settings.gravity,
    }));
    for (let first = 0; first < points.length; first++) {
      for (let second = first + 1; second < points.length; second++) {
        const dx = points[first].x - points[second].x;
        const dy = points[first].y - points[second].y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = settings.repulsion / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        forces[first].x += fx;
        forces[first].y += fy;
        forces[second].x -= fx;
        forces[second].y -= fy;
      }
    }
    for (const edge of edges) {
      const first = indices.get(edge.source);
      const second = indices.get(edge.target);
      if (first === undefined || second === undefined) {
        continue;
      }
      const dx = points[second].x - points[first].x;
      const dy = points[second].y - points[first].y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - settings.linkDistance) * settings.springStrength;
      forces[first].x += (dx / distance) * force;
      forces[first].y += (dy / distance) * force;
      forces[second].x -= (dx / distance) * force;
      forces[second].y -= (dy / distance) * force;
    }
    points.forEach((point, index) => {
      const force = forces[index];
      const scale = Math.min(1, settings.maxStep / Math.max(1, Math.hypot(force.x, force.y)));
      point.x += force.x * scale;
      point.y += force.y * scale;
    });
  }
  return new Map(nodes.map((node, index) => [node.id, points[index]]));
}
