import { brainConfig } from './config';
import { formatDate, statusLabels } from './presentation';
import { CitationButton } from './ReviewDossier';
import type { BrainSource, DemoState, OpenSource, SearchResult } from './types';

export function SourceLibrary({
  sources,
  snapshot,
  repo,
  query,
  results,
  kind,
  busy,
  onQueryChange,
  onSearch,
  onFilterChange,
  onOpenSource,
}: {
  sources: BrainSource[];
  snapshot: NonNullable<DemoState['snapshot']>;
  repo: string;
  query: string;
  results: SearchResult[] | null;
  kind: string;
  busy: boolean;
  onQueryChange: (query: string) => void;
  onSearch: () => Promise<void>;
  onFilterChange: (kind: string) => void;
  onOpenSource: OpenSource;
}) {
  const matchesFilter = (source: { kind: string; status: string }) =>
    kind === 'all' || source.kind === kind || source.status === kind;
  const visibleSources = sources
    .filter(matchesFilter)
    .sort(
      (first, second) =>
        Number(second.status === 'published') - Number(first.status === 'published') ||
        first.title.localeCompare(second.title, 'en'),
    );
  const visibleResults = results?.filter(matchesFilter);

  return (
    <>
      <div className="brain-section-head">
        <div>
          <h2>Source library</h2>
          <p>
            {sources.filter((source) => source.kind === 'notion').length} Notion documents ·{' '}
            {sources.filter((source) => source.kind === 'code').length} Git files · captured on{' '}
            {formatDate(snapshot.importedAt, 'medium')}
          </p>
        </div>
      </div>
      <form
        className="brain-search"
        onSubmit={(event) => {
          event.preventDefault();
          void onSearch();
        }}
      >
        <input
          aria-label="Search memory"
          value={query}
          maxLength={brainConfig.search.maxQueryCharacters}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search sources… PostgreSQL, React, memory"
        />
        <button
          className="brain-button"
          disabled={busy || query.trim().length < brainConfig.search.minTermCharacters}
        >
          Search
        </button>
        {results && (
          <button type="button" className="brain-button" onClick={() => onQueryChange('')}>
            Clear
          </button>
        )}
      </form>
      <div className="brain-library-filters" aria-label="Filter sources">
        {[
          ['all', 'All'],
          ['notion', 'Notion'],
          ['code', 'Code'],
          ['published', 'Published'],
          ['draft', 'Proposals'],
        ].map(([value, label]) => (
          <button key={value} aria-pressed={kind === value} onClick={() => onFilterChange(value)}>
            {label}
            <span>
              {
                sources.filter(
                  (source) => value === 'all' || source.kind === value || source.status === value,
                ).length
              }
            </span>
          </button>
        ))}
        <small>
          {results
            ? `${visibleResults?.length ?? 0} source${(visibleResults?.length ?? 0) > 1 ? 's found' : ' found'}`
            : `${visibleSources.length} source${visibleSources.length > 1 ? 's' : ''}`}
        </small>
      </div>
      {visibleResults ? (
        <div className="brain-search-results">
          {visibleResults.length ? (
            visibleResults.map((result) => (
              <article key={result.sourceId}>
                <div className="brain-section-head">
                  <h3>{result.title}</h3>
                  <span className={`brain-badge ${result.status}`}>
                    {statusLabels[result.status]}
                  </span>
                </div>
                {result.matches.map((match) => (
                  <div key={match.line}>
                    <CitationButton
                      citation={{ sourceId: result.sourceId, ...match }}
                      sources={sources}
                      onOpenSource={onOpenSource}
                      missingSourceLabel="Archived source revision"
                    />
                  </div>
                ))}
              </article>
            ))
          ) : (
            <div className="brain-empty">
              <h3>No matching excerpts</h3>
              <p>Try a specific term. No results does not mean no decision exists.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="brain-library">
          {(['notion', 'code'] as const).map((group) => {
            const groupSources = visibleSources.filter((source) => source.kind === group);
            if (!groupSources.length) {
              return null;
            }
            return (
              <section key={group}>
                <header>
                  <h3>{group === 'notion' ? 'Notion documents' : 'Repository files'}</h3>
                  <span>
                    {group === 'notion' ? 'Decisions and proposals' : repo} · {groupSources.length}
                  </span>
                </header>
                {groupSources.map((source) => (
                  <button
                    className="brain-file-row"
                    key={source.id}
                    onClick={() => onOpenSource(source.id)}
                  >
                    <span className={`brain-file-icon ${source.kind}`} aria-hidden="true">
                      {fileIcon(source)}
                    </span>
                    <span className="brain-file-name">
                      <strong>{source.title}</strong>
                      <small>{source.topic}</small>
                    </span>
                    <span className={`brain-badge ${source.status}`}>
                      {statusLabels[source.status]}
                    </span>
                    <span className="brain-file-meta">{source.lines} lines</span>
                    <span className="brain-file-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                ))}
              </section>
            );
          })}
          {!visibleSources.length && (
            <div className="brain-empty">
              <h3>No sources match this filter</h3>
              <p>Select “All” to return to the library.</p>
            </div>
          )}
        </div>
      )}
      {snapshot.excluded.length > 0 && (
        <p className="brain-warning">Excluded from snapshot: {snapshot.excluded.join(' ; ')}</p>
      )}
    </>
  );
}

function fileIcon(source: BrainSource) {
  if (source.kind === 'notion') {
    return 'N';
  }
  if (source.path.endsWith('.json')) {
    return '{ }';
  }
  return source.path.endsWith('.md') ? 'MD' : '‹ ›';
}
