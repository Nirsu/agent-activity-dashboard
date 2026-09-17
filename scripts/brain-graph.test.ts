import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GraphCanvas } from '../ui/src/components/brain/GraphCanvas';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectedNodes,
  filterGraph,
  graphViewport,
  layoutGraph,
} from '../ui/src/components/brain/graph';
import type { MemoryGraph } from '../ui/src/components/brain/graph';

const graph: MemoryGraph = {
  scopes: [{ id: 'demo', label: 'Demo' }],
  scope: { id: 'demo', label: 'Demo', description: '' },
  nodes: [
    { id: 'a', kind: 'source', label: 'Specification', summary: 'User login' },
    { id: 'b', kind: 'requirement', label: 'Require login', summary: '' },
    { id: 'c', kind: 'finding', label: 'Login verified', summary: '' },
    { id: 'd', kind: 'source', label: 'Unlinked document', summary: '' },
  ],
  edges: [
    { id: 'ab', source: 'a', target: 'b', label: 'contains' },
    { id: 'bc', source: 'b', target: 'c', label: 'checked by' },
  ],
};

test('search and type filters keep only links whose endpoints are both visible', () => {
  const filtered = filterGraph(graph, 'LOGIN', ['source', 'requirement']);
  assert.deepEqual(
    filtered.nodes.map((node) => node.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    filtered.edges.map((edge) => edge.id),
    ['ab'],
  );
  assert.deepEqual(filterGraph(graph, 'missing', ['source']).edges, []);
  assert.deepEqual([...connectedNodes('a', graph.edges)], ['a', 'b']);
});

test('layout is stable, finite, and preserves disconnected nodes without inventing links', () => {
  const positions = layoutGraph(graph.nodes, graph.edges);
  assert.deepEqual(positions, layoutGraph(graph.nodes, graph.edges));
  assert.equal(positions.size, graph.nodes.length);
  for (const point of positions.values()) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
  assert.equal(
    new Set([...positions.values()].map((point) => `${point.x},${point.y}`)).size,
    graph.nodes.length,
  );
  assert.equal(layoutGraph([], []).size, 0);
  assert.deepEqual(layoutGraph([graph.nodes[0]], []).get('a'), { x: 0, y: 0 });
});

test('search preserves only direct context, respects hidden types, and identifies matches', () => {
  const filtered = filterGraph(graph, 'Specification', ['source', 'requirement', 'finding']);
  assert.deepEqual([...filtered.matchingIds], ['a']);
  assert.deepEqual(
    filtered.nodes.map((node) => node.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    filtered.edges.map((edge) => edge.id),
    ['ab'],
  );
  assert.deepEqual(
    filterGraph(graph, 'Specification', ['source']).nodes.map((node) => node.id),
    ['a'],
  );
  assert.deepEqual(filterGraph(graph, 'missing', ['source', 'requirement']).nodes, []);
  assert.equal(filterGraph(graph, '', ['source', 'requirement', 'finding']).nodes.length, 4);
});

test('the viewport fits visible nodes without moving the layout or including hidden outliers', () => {
  const positions = new Map([
    ['a', { x: 400, y: -200 }],
    ['b', { x: 700, y: 400 }],
    ['hidden', { x: -10_000, y: -10_000 }],
  ]);
  const viewport = graphViewport(positions, new Set(['a', 'b']));
  assert.equal(viewport.x, 550);
  assert.equal(viewport.y, 100);
  assert.ok(viewport.size > 600 && viewport.size < 10_000);
  for (const id of ['a', 'b']) {
    const point = positions.get(id)!;
    assert.ok(Math.abs(point.x - viewport.x) < viewport.size / 2);
    assert.ok(Math.abs(point.y - viewport.y) < viewport.size / 2);
  }
  assert.deepEqual(positions.get('a'), { x: 400, y: -200 });
  assert.ok(graphViewport(positions, new Set()).size > 0);
  assert.equal(graphViewport(positions, new Set(['a'])).x, 400);
});

test('graph marks extracted relations separately from recorded references', () => {
  const nodes = [
    { id: 'source', kind: 'source' as const, label: 'Approved source', summary: '' },
    { id: 'entity', kind: 'entity' as const, label: 'Extracted concept', summary: '' },
    { id: 'review', kind: 'review' as const, label: 'Human decision', summary: '' },
  ];
  const html = renderToStaticMarkup(
    React.createElement(GraphCanvas, {
      nodes,
      edges: [
        {
          id: 'extracted',
          source: 'source',
          target: 'entity',
          label: 'mentions',
          origin: 'extracted',
        },
        {
          id: 'recorded',
          source: 'source',
          target: 'review',
          label: 'reviewed by',
          origin: 'recorded',
        },
      ],
      visibleIds: new Set(nodes.map((node) => node.id)),
      selectedId: '',
      onSelect: () => {},
    }),
  );
  assert.match(html, /mentions · Extracted by Cognee/);
  assert.match(html, /reviewed by · Recorded reference/);
  assert.match(html, /aria-label="entity: Extracted concept"/);
});
