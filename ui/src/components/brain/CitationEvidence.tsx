import { brainConfig } from './config';
import type { BrainSource, Citation, OpenSource } from './types';

type EvidenceLine = { number: number; text: string; cited: boolean };

// Context for historical single-line citations comes from the saved snapshot only.
// It improves readability without changing the evidence selected by the model.
function contextRange(citation: Citation, lines: string[], specification: boolean) {
  let start = citation.line;
  let end = citation.endLine ?? citation.line;
  if (citation.endLine !== undefined) {
    return { start, end };
  }
  const limit = brainConfig.ui.citationContextLines;
  const startsParagraph = (line: string) => /^\s*(?:#{1,6}\s|(?:[-*+]|\d+\.)\s)/.test(line);
  while (
    start > 1 &&
    citation.line - start < limit &&
    lines[start - 2].trim() &&
    !(specification && startsParagraph(lines[start - 1]))
  ) {
    start -= 1;
  }
  while (
    end < lines.length &&
    end - citation.line < limit &&
    lines[end].trim() &&
    !(specification && startsParagraph(lines[end]))
  ) {
    end += 1;
  }
  return { start, end };
}

export function citationGroups(citations: Citation[], sources: BrainSource[]) {
  return [...new Set(citations.map((citation) => citation.sourceId))].map((sourceId) => {
    const source = sources.find((source) => source.id === sourceId);
    const references = citations.filter((citation) => citation.sourceId === sourceId);
    const content = source?.content?.split('\n');
    const rows = new Map<number, EvidenceLine>();
    for (const citation of references) {
      const quoteLines = citation.quote.split('\n');
      const lastCitedLine = citation.endLine ?? citation.line;
      const range = content
        ? contextRange(citation, content, source?.status === 'published')
        : { start: citation.line, end: lastCitedLine };
      for (let number = range.start; number <= range.end; number += 1) {
        rows.set(number, {
          number,
          text: content?.[number - 1] ?? quoteLines[number - citation.line] ?? '',
          cited:
            Boolean(rows.get(number)?.cited) ||
            (number >= citation.line && number <= lastCitedLine),
        });
      }
    }
    return {
      sourceId,
      title: source?.title ?? 'Archived source',
      anchorLine: references[0].line,
      lines: [...rows.values()].sort((left, right) => left.number - right.number),
    };
  });
}

export function CitationEvidence({
  citations,
  sources,
  onOpenSource,
}: {
  citations: Citation[];
  sources: BrainSource[];
  onOpenSource: OpenSource;
}) {
  return (
    <div className="brain-citation-evidence">
      {citationGroups(citations, sources).map((group) => {
        const hasContext = group.lines.some((line) => !line.cited);
        return (
          <div className="brain-evidence-source" key={group.sourceId}>
            <button
              className="brain-evidence-source-link"
              type="button"
              onClick={() => onOpenSource(group.sourceId, group.anchorLine)}
            >
              <strong>{group.title}</strong>
              <span>Open captured source ↗</span>
            </button>
            {hasContext && (
              <p className="brain-evidence-legend">
                Highlighted lines were cited by the AI. Other lines are surrounding context.
              </p>
            )}
            <div
              className="brain-evidence-code"
              tabIndex={0}
              role="region"
              aria-label={`Excerpt from ${group.title}`}
            >
              {group.lines.map((line, index) => (
                <div key={line.number}>
                  {index > 0 && line.number > group.lines[index - 1].number + 1 && (
                    <div className="brain-evidence-gap" aria-label="Omitted lines">
                      …
                    </div>
                  )}
                  <div className={`brain-evidence-line${line.cited ? ' cited' : ''}`}>
                    <span className="brain-evidence-number" aria-hidden="true">
                      {line.number}
                    </span>
                    <code>{line.text || '\u00a0'}</code>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
