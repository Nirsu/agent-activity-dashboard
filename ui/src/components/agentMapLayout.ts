export const MAP_NODE_WIDTH = 156;
export const MAP_NODE_HEIGHT = 48;
export const MAP_HEADING_HEIGHT = 48;

/** Pack spatial clusters on one canvas. Reserve actual pill bounds before placing centres. */
export function agentMapLayout(counts: number[], width: number) {
  const columns = Math.max(
    1,
    Math.min(Math.ceil(Math.sqrt(counts.length || 1)), Math.floor(width / 240)),
  );
  const cellWidth = width / columns;
  const padding = 16;
  const nodeWidth = Math.min(MAP_NODE_WIDTH, Math.max(1, cellWidth - padding * 2));
  const nodeGap = 24;
  const rowStep = MAP_NODE_HEIGHT + nodeGap;
  const slots = Math.max(
    1,
    Math.floor((cellWidth - padding * 2 + nodeGap) / (nodeWidth + nodeGap)),
  );
  const local = counts.map((count) => {
    const nodes: Array<{ x: number; y: number }> = [];
    let row = 0;
    while (nodes.length < count) {
      // Alternating rows form a loose honeycomb without boxes around teams.
      const capacity = Math.max(1, slots - (row % 2 === 0 && slots > 1 ? 1 : 0));
      const inRow = Math.min(capacity, count - nodes.length);
      const drift =
        slots === 1 && count > 1
          ? (row % 2 === 0 ? -1 : 1) * Math.min(28, (cellWidth - nodeWidth) / 2 - padding)
          : 0;
      for (let index = 0; index < inRow; index++) {
        nodes.push({
          x: cellWidth / 2 + (index - (inRow - 1) / 2) * (nodeWidth + nodeGap) + drift,
          y: MAP_HEADING_HEIGHT + 32 + MAP_NODE_HEIGHT / 2 + row * rowStep,
        });
      }
      row++;
    }
    return { nodes, height: MAP_HEADING_HEIGHT + 64 + Math.max(1, row) * rowStep };
  });
  const rowHeights: number[] = [];
  local.forEach((cluster, index) => {
    const row = Math.floor(index / columns);
    rowHeights[row] = Math.max(rowHeights[row] || 0, cluster.height);
  });
  const minimumHeight = width <= 620 ? 480 : 620;
  const packedHeight = rowHeights.reduce((sum, height) => sum + height, 0);
  const extra = Math.max(0, minimumHeight - packedHeight) / Math.max(1, rowHeights.length);
  const offsets: number[] = [];
  let top = 0;
  rowHeights.forEach((height) => {
    offsets.push(top);
    top += height + extra;
  });
  return {
    height: Math.max(minimumHeight, packedHeight),
    nodeWidth,
    clusters: local.map((cluster, index) => {
      const x = (index % columns) * cellWidth;
      const row = Math.floor(index / columns);
      const y = offsets[row] + (rowHeights[row] + extra - cluster.height) / 2 + 16;
      return {
        cx: x + cellWidth / 2,
        headingY: y,
        headingWidth: Math.min(180, cellWidth - padding * 2),
        nodes: cluster.nodes.map((node) => ({ x: x + node.x, y: y + node.y })),
      };
    }),
  };
}
