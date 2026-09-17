import { brainConfig } from '../config.js';
import { fail } from '../analysis/validation.js';
import type { CogneeHit } from '../cognee/types.js';
import type { Source } from '../sources.js';
import type { SourceExcerpt } from './types.js';

export function selectCapturedEvidence(
  captures: { source: Source; datasetId: string; mandatory: boolean }[],
  hits: CogneeHit[],
) {
  const selected = new Map<string, { source: Source; excerpts: SourceExcerpt[] }>();
  function include(source: Source, startLine: number, endLine: number) {
    const entry = selected.get(source.id) ?? { source, excerpts: [] };
    entry.excerpts.push({ sourceId: source.id, startLine, endLine });
    selected.set(source.id, entry);
  }
  for (const { source } of captures.filter((entry) => entry.mandatory)) {
    include(source, 1, source.lines);
  }
  for (const hit of hits) {
    const capture = captures.find((entry) => entry.datasetId === hit.datasetId)?.source;
    const position = capture?.content.indexOf(hit.text) ?? -1;
    if (!capture || !hit.text.trim() || position < 0) {
      fail('Retrieved evidence could not be verified against its captured source.');
    }
    const startLine = capture.content.slice(0, position).split('\n').length;
    const endLine =
      capture.content.slice(0, position + hit.text.length).split('\n').length -
      (hit.text.endsWith('\n') ? 1 : 0);
    include(capture, startLine, endLine);
  }
  const sources = [...selected.values()].map((entry) => entry.source);
  const excerpts: SourceExcerpt[] = [];
  let selectedBytes = 0;
  for (const entry of selected.values()) {
    const merged: SourceExcerpt[] = [];
    for (const excerpt of entry.excerpts.sort((left, right) => left.startLine - right.startLine)) {
      const previous = merged.at(-1);
      if (previous && excerpt.startLine <= previous.endLine + 1) {
        previous.endLine = Math.max(previous.endLine, excerpt.endLine);
      } else {
        merged.push({ ...excerpt });
      }
    }
    const lines = entry.source.content.split('\n');
    for (const excerpt of merged) {
      selectedBytes += Buffer.byteLength(
        lines.slice(excerpt.startLine - 1, excerpt.endLine).join('\n'),
      );
    }
    excerpts.push(...merged);
  }
  if (!sources.length) {
    fail('No applicable evidence was retrieved. This change has not been validated.', 409);
  }
  if (
    sources.length > brainConfig.analysis.maxSources ||
    selectedBytes > brainConfig.analysis.maxSourceBytes
  ) {
    fail(
      'Retrieved context exceeds the analysis budget. Narrow the project scope or mandatory sources.',
    );
  }
  return { sources, excerpts };
}
