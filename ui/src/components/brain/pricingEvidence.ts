export type EvidenceRow = { fields: Array<{ label: string; value: string }> };

/** Reformat complete source rows only. Never guess labels for incomplete excerpts. */
export function pricingEvidenceRows(evidence: string): EvidenceRow[] {
  let headers: string[] | undefined;
  const rows: EvidenceRow[] = [];
  for (const line of evidence.split('\n')) {
    if (!line.includes('|')) {
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    if (/^\*{0,2}model\*{0,2}$/i.test(cells[0])) {
      headers = cells;
    } else if (
      headers &&
      headers.length === cells.length &&
      cells.slice(1).some((cell) => /\$\s*\d/.test(cell))
    ) {
      rows.push({ fields: headers.map((label, index) => ({ label, value: cells[index] })) });
    }
  }
  return rows;
}
