import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { GraphCanvas } from './brain/GraphCanvas';
import { connectedNodes, filterGraph, graphKinds } from './brain/graph';
import type { GraphKind, MemoryGraph } from './brain/graph';
import { useMemoryGraph } from './brain/useMemoryGraph';
import './BrainGraph.css';

const BrainSourceViewer = lazy(() => import('./BrainSourceViewer'));
const allKinds = graphKinds.map((item) => item.kind);

export default function BrainGraph() {
  const brain = useMemoryGraph();
  const currentGraph = brain.graph && (!brain.scope || brain.scope === brain.graph.scope.id);
  return (
    <section className="brain-graph" aria-labelledby="memory-graph-title">
      <header className="brain-graph-header">
        <div>
          <h1 id="memory-graph-title">Memory graph</h1>
          <p>Follow connections from a concept back to its source.</p>
        </div>
        <div className="brain-graph-header-actions">
          {brain.graph && (
            <label className="brain-graph-scope">
              Scope
              <select
                value={brain.scope || brain.graph.scope.id}
                onChange={(event) => brain.setScope(event.target.value)}
              >
                {brain.graph.scopes.map((scope) => (
                  <option key={scope.id} value={scope.id}>
                    {scope.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button onClick={brain.refresh} disabled={brain.loading}>
            {brain.loading ? 'Refreshing…' : brain.error ? 'Try again' : 'Refresh'}
          </button>
        </div>
      </header>
      {brain.error && (
        <p role="alert" className="brain-graph-error">
          {brain.error}
          {currentGraph && ' The last loaded graph is still shown.'}
        </p>
      )}
      {brain.loading && !currentGraph && (
        <p className="brain-graph-loading" role="status">
          Loading memory connections…
        </p>
      )}
      {currentGraph && brain.graph && (
        <GraphExplorer
          key={brain.graph.scope.id}
          graph={brain.graph}
          openNode={brain.openNode}
          loadingSource={brain.loadingSource}
          sourceError={brain.sourceError}
          refreshing={brain.loading}
        />
      )}
      {brain.document && (
        <Suspense fallback={<p role="status">Opening source…</p>}>
          <BrainSourceViewer
            source={brain.document.source}
            sources={brain.sources}
            line={brain.document.line}
            loading={brain.loadingSource}
            error={brain.sourceError}
            onSelect={brain.openSource}
            onClose={brain.closeSource}
          />
        </Suspense>
      )}
    </section>
  );
}

function GraphExplorer({
  graph,
  openNode,
  loadingSource,
  sourceError,
  refreshing,
}: {
  graph: MemoryGraph;
  openNode: ReturnType<typeof useMemoryGraph>['openNode'];
  loadingSource: boolean;
  sourceError: string;
  refreshing: boolean;
}) {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<GraphKind[]>(allKinds);
  const [selectedId, setSelectedId] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const inspector = useRef<HTMLElement>(null);
  const filtered = useMemo(() => filterGraph(graph, query, kinds), [graph, query, kinds]);
  const selected = filtered.nodes.find((node) => node.id === selectedId);
  const neighbors = connectedNodes(selected?.id ?? '', graph.edges);
  const visible = filtered.nodes.filter(
    (node) => !localOnly || !selected || neighbors.has(node.id),
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const visibleEdges = filtered.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  );
  const links = graph.edges.filter(
    (edge) => edge.source === selected?.id || edge.target === selected?.id,
  );
  const hasMemory = graph.nodes.some((node) => node.kind !== 'project');
  const searching = Boolean(query.trim());
  const filteredView = searching || kinds.length !== allKinds.length || localOnly;

  function resetFilters() {
    setQuery('');
    setKinds(allKinds);
    setLocalOnly(false);
  }

  function showDetails() {
    inspector.current?.focus({ preventScroll: true });
    inspector.current?.scrollIntoView({ block: 'nearest' });
  }

  return (
    <>
      {graph.warning && (
        <p className="brain-graph-notice" role="status">
          {graph.warning}
        </p>
      )}
      {graph.truncated && (
        <p className="brain-graph-notice">
          This graph shows a limited subset of this scope’s connections.
        </p>
      )}
      <div className="brain-graph-filters">
        <label className="brain-graph-search">
          Search nodes
          <input
            type="search"
            placeholder="Find a source or concept…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLocalOnly(false);
            }}
          />
        </label>
        <div className="brain-graph-legend" role="group" aria-label="Visible node types">
          {graphKinds.map(({ kind, label, color }) => {
            const count = graph.nodes.filter((node) => node.kind === kind).length;
            return (
              <button
                key={kind}
                aria-pressed={kinds.includes(kind)}
                disabled={count === 0}
                onClick={() =>
                  setKinds(
                    kinds.includes(kind)
                      ? kinds.filter((value) => value !== kind)
                      : [...kinds, kind],
                  )
                }
              >
                <i style={{ background: color }} aria-hidden="true" />
                {label}
                <span>{count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="brain-graph-workspace" aria-busy={refreshing}>
        <div className="brain-graph-map">
          <div className="brain-graph-map-heading">
            <span role="status">
              {searching
                ? `${filtered.matchingIds.size} ${filtered.matchingIds.size === 1 ? 'match' : 'matches'} + direct connections`
                : `${visible.length} nodes · ${visibleEdges.length} links`}
              {refreshing && ' · Refreshing…'}
            </span>
            <div className="brain-graph-view-controls">
              {filteredView && <button onClick={resetFilters}>Reset filters</button>}
              <label>
                <input
                  type="checkbox"
                  checked={localOnly && Boolean(selected)}
                  disabled={!selected}
                  onChange={(event) => setLocalOnly(event.target.checked)}
                />
                Focus selection
              </label>
            </div>
          </div>
          {!hasMemory || !visible.length ? (
            <div className="brain-graph-empty">
              <h2>{hasMemory ? 'No matching nodes' : 'No sources in this scope yet'}</h2>
              <p>
                {hasMemory
                  ? 'Try another search or show more node types.'
                  : 'Add reference sources in Memory to start exploring their connections.'}
              </p>
              {hasMemory ? (
                <button onClick={resetFilters}>Reset filters</button>
              ) : (
                <a href="#brain/memory">Open Memory →</a>
              )}
            </div>
          ) : (
            <GraphCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              visibleIds={visibleIds}
              matchingIds={searching ? filtered.matchingIds : undefined}
              selectedId={selected?.id ?? ''}
              onSelect={setSelectedId}
            />
          )}
          {selected && (
            <button className="brain-graph-mobile-details" onClick={showDetails}>
              <span>{selected.label}</span>View details ↓
            </button>
          )}
        </div>
        <aside
          ref={inspector}
          id="graph-node-details"
          className="brain-graph-inspector"
          tabIndex={-1}
          aria-labelledby="graph-detail-title"
        >
          {selected ? (
            <>
              <div className="brain-graph-detail-heading">
                <span className="brain-eyebrow">
                  {graphKinds.find((item) => item.kind === selected.kind)?.label}
                </span>
                <button aria-label="Clear selection" onClick={() => setSelectedId('')}>
                  ×
                </button>
              </div>
              <h2 id="graph-detail-title">{selected.label}</h2>
              <span className="brain-graph-sr-only" role="status">
                Selected: {selected.label}
              </span>
              {selected.status && (
                <span className="brain-graph-status">{selected.status.replaceAll('_', ' ')}</span>
              )}
              {selected.kind === 'entity' && (
                <p className="brain-graph-origin">Extracted by Cognee. Not human validated.</p>
              )}
              {selected.analysisId && (
                <p className="brain-graph-origin">Snapshot preserved from a recorded analysis.</p>
              )}
              <p className="brain-graph-summary">{selected.summary}</p>
              {selected.sourceId && (
                <button
                  className="brain-graph-open"
                  disabled={loadingSource}
                  onClick={() => openNode(selected)}
                >
                  {loadingSource
                    ? 'Opening source…'
                    : `Open captured source${selected.line ? ` · L${selected.line}` : ''}`}
                </button>
              )}
              {sourceError && (
                <p className="brain-graph-error" role="alert">
                  {sourceError}
                </p>
              )}
              <h3>
                Connections <span>{links.length}</span>
              </h3>
              {links.length === 0 && (
                <p className="brain-graph-muted">No recorded connections yet.</p>
              )}
              <ul className="brain-graph-links">
                {links.map((edge) => {
                  const otherId = edge.source === selected.id ? edge.target : edge.source;
                  const other = graph.nodes.find((node) => node.id === otherId);
                  if (!other) {
                    return null;
                  }
                  return (
                    <li key={edge.id}>
                      <button
                        onClick={() => {
                          setQuery('');
                          setKinds(allKinds);
                          setSelectedId(other.id);
                        }}
                      >
                        <small>
                          {edge.source === selected.id ? '→' : '←'} {edge.label}
                        </small>
                        <span>{other.label}</span>
                        <em>
                          {edge.origin === 'extracted'
                            ? '┄ Extracted · not validated'
                            : '— Recorded reference'}
                        </em>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <>
              <span className="brain-eyebrow">NODE DETAILS</span>
              <h2 id="graph-detail-title">Select a connection</h2>
              <p className="brain-graph-summary">
                Select a node to inspect its source and follow the records linked to it.
              </p>
              <p className="brain-graph-muted">
                You can also browse the node list below the graph.
              </p>
            </>
          )}
        </aside>
      </div>
      <div className="brain-graph-footer">
        <p className="brain-graph-provenance">
          <span>— Recorded reference</span>
          <span>┄ Extracted · not human validated</span>
        </p>
        <details className="brain-graph-about">
          <summary>About this scope</summary>
          <p>{graph.scope.description}</p>
        </details>
      </div>
      {visible.length > 0 && hasMemory && (
        <details className="brain-graph-list">
          <summary>Browse nodes as a list ({visible.length})</summary>
          <ul>
            {visible.map((node) => (
              <li key={node.id}>
                <button
                  aria-pressed={selectedId === node.id}
                  onClick={() => setSelectedId(node.id)}
                >
                  <span>{graphKinds.find((item) => item.kind === node.kind)?.label}</span>
                  {node.label}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
