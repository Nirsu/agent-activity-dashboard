import { useEffect, useMemo, useRef, useState } from 'react';
import { brainConfig } from './config';
import { connectedNodes, graphKinds, graphViewport, layoutGraph } from './graph';
import type { GraphEdge, GraphNode, GraphPoint } from './graph';

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  visibleIds: Set<string>;
  matchingIds?: Set<string>;
  selectedId: string;
  onSelect: (id: string) => void;
};

export function GraphCanvas({
  nodes,
  edges,
  visibleIds,
  matchingIds,
  selectedId,
  onSelect,
}: Props) {
  const positions = useMemo(() => layoutGraph(nodes, edges), [nodes, edges]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<GraphPoint>({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; pan: GraphPoint }>();
  const neighbors = useMemo(() => connectedNodes(selectedId, edges), [selectedId, edges]);
  const viewport = graphViewport(positions, visibleIds);
  const viewSize = viewport.size / zoom;
  const visibleKey = JSON.stringify([...visibleIds].sort());
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [visibleKey]);
  const labelBounds: { x: number; y: number; width: number }[] = [];
  const visibleLabels = new Set<string>();
  const labelCandidates = nodes.filter((node) => visibleIds.has(node.id));
  labelCandidates.sort(
    (first, second) => Number(second.id === selectedId) - Number(first.id === selectedId),
  );
  for (const node of labelCandidates) {
    const point = positions.get(node.id)!;
    const width = Math.min(node.label.length, brainConfig.graph.labelCharacters) * 7;
    const overlaps = labelBounds.some(
      (bound) =>
        Math.abs(point.y - bound.y) < 20 &&
        Math.abs(point.x - bound.x) < (width + bound.width) / 2 + 10,
    );
    if (!overlaps) {
      visibleLabels.add(node.id);
      labelBounds.push({ ...point, width });
    }
  }

  return (
    <div className="brain-graph-canvas">
      <div className="brain-graph-zoom" aria-label="Graph controls">
        <button
          aria-label="Zoom out"
          disabled={zoom <= brainConfig.graph.minZoom}
          onClick={() =>
            setZoom(Math.max(brainConfig.graph.minZoom, zoom - brainConfig.graph.zoomStep))
          }
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          aria-label="Zoom in"
          disabled={zoom >= brainConfig.graph.maxZoom}
          onClick={() =>
            setZoom(Math.min(brainConfig.graph.maxZoom, zoom + brainConfig.graph.zoomStep))
          }
        >
          +
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          Fit view
        </button>
      </div>
      <svg
        viewBox={`${viewport.x - viewSize / 2 + pan.x} ${viewport.y - viewSize / 2 + pan.y} ${viewSize} ${viewSize}`}
        aria-label="Memory connections. Select a node to inspect links and their provenance."
        aria-describedby="graph-keyboard-help"
        role="group"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onSelect('');
          }
          if (event.target !== event.currentTarget || !event.key.startsWith('Arrow')) {
            return;
          }
          event.preventDefault();
          const step = brainConfig.graph.linkDistance / zoom;
          setPan((position) => ({
            x:
              position.x +
              (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
            y:
              position.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
          }));
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget || event.button !== 0 || !event.isPrimary) {
            return;
          }
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || drag.current.pointerId !== event.pointerId) {
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          const scale = viewSize / Math.min(bounds.width, bounds.height);
          setPan({
            x: drag.current.pan.x - (event.clientX - drag.current.x) * scale,
            y: drag.current.pan.y - (event.clientY - drag.current.y) * scale,
          });
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
      >
        <g className="brain-graph-edges" aria-hidden="true">
          {edges
            .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
            .map((edge) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) {
                return null;
              }
              const related = edge.source === selectedId || edge.target === selectedId;
              return (
                <line
                  key={edge.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  className={`${related ? 'selected' : ''}${edge.origin === 'extracted' ? ' extracted' : ''}`}
                  opacity={selectedId && !related ? 0.16 : 1}
                >
                  <title>{`${edge.label} · ${edge.origin === 'extracted' ? 'Extracted by Cognee' : 'Recorded reference'}`}</title>
                </line>
              );
            })}
        </g>
        {nodes
          .filter((node) => visibleIds.has(node.id))
          .map((node) => {
            const point = positions.get(node.id)!;
            const color = graphKinds.find((item) => item.kind === node.kind)!.color;
            const selected = selectedId === node.id;
            const label =
              node.label.length > brainConfig.graph.labelCharacters
                ? `${node.label.slice(0, brainConfig.graph.labelCharacters)}…`
                : node.label;
            return (
              <g
                key={node.id}
                transform={`translate(${point.x},${point.y})`}
                className={`brain-graph-node${selected ? ' selected' : ''}`}
                style={{ color }}
                role="button"
                tabIndex={0}
                aria-label={`${node.kind}: ${node.label}`}
                aria-pressed={selected}
                aria-controls="graph-node-details"
                opacity={selectedId && !neighbors.has(node.id) ? 0.3 : 1}
                onClick={() => onSelect(selected ? '' : node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(selected ? '' : node.id);
                  }
                }}
              >
                <title>{node.label}</title>
                <circle className="brain-graph-hit" r="23" />
                {(selected || matchingIds?.has(node.id)) && (
                  <circle className="brain-graph-halo" r="22" />
                )}
                <circle r={node.kind === 'project' ? 12 : 8} fill="currentColor" />
                <text
                  y="32"
                  textAnchor="middle"
                  className={visibleLabels.has(node.id) ? '' : 'decluttered'}
                >
                  {label}
                </text>
              </g>
            );
          })}
      </svg>
      <p className="brain-graph-hint">Drag to pan · Select a node to explore</p>
      <span id="graph-keyboard-help" className="brain-graph-sr-only">
        Arrow keys pan the focused graph. Tab to a node, then press Enter to select it. Escape
        clears the selection. The node list below offers the same connections.
      </span>
    </div>
  );
}
