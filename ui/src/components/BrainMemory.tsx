import { lazy, Suspense, useState } from 'react';
import { MemorySourceForm } from './brain/MemorySourceForm';
import { formatDate, memorySourceExplanation, memorySourceStatus } from './brain/presentation';
import { useBrainMemory } from './brain/useBrainMemory';
import { canSyncSource, filterMemorySources, sourceViews } from './brain/memoryView';
import type { SourceView } from './brain/memoryView';
import type { MemorySource, MemoryState } from './brain/memoryTypes';
import './BrainMemory.css';

const BrainSourceViewer = lazy(() => import('./BrainSourceViewer'));

export default function BrainMemory() {
  const memory = useBrainMemory();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [view, setView] = useState<SourceView>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const { state } = memory;
  const sources = filterMemorySources(state?.sources ?? [], query, scope, view);
  const activeJobs =
    state?.jobs.filter((job) => job.status === 'queued' || job.status === 'running') ?? [];
  const readyCount =
    state?.sources.filter((source) => source.status === 'ready' && source.approval === 'approved')
      .length ?? 0;
  const syncable =
    state?.sources.some((source) => canSyncSource(source, state.notion.connected)) ?? false;
  const allSourcesCanSync =
    state?.sources
      .filter((source) => source.approval !== 'withdrawn')
      .every((source) => canSyncSource(source, state.notion.connected)) ?? false;

  function clearFilters() {
    setQuery('');
    setScope('all');
    setView('all');
  }

  return (
    <section className="brain-memory" aria-labelledby="brain-memory-title">
      <header className="brain-live-header">
        <div>
          <div className="brain-eyebrow">PROJECT KNOWLEDGE</div>
          <h1 id="brain-memory-title">Memory</h1>
          <p>Manage project references and the versions used in each analysis.</p>
        </div>
        <div className="brain-memory-actions">
          <button
            className="brain-button"
            disabled={memory.busy || Boolean(activeJobs.length) || !syncable || !allSourcesCanSync}
            onClick={() => void memory.sync()}
            title={
              !allSourcesCanSync && syncable
                ? 'Reconnect Notion to sync all sources. Individual Git sources can still be synced below.'
                : undefined
            }
          >
            {activeJobs.length ? `Syncing ${activeJobs.length}…` : 'Sync all sources'}
          </button>
          <button
            className="brain-button primary"
            disabled={!state || editing !== null}
            onClick={() => setEditing('new')}
          >
            Add Notion page
          </button>
        </div>
      </header>
      {(memory.connectionError || (memory.error && !editing)) && (
        <div className="brain-error" role="alert">
          <div>
            {memory.error || memory.connectionError}
            {memory.adminRequired && (
              <p>
                <a href="#brain/settings">Set administrator access in Settings →</a>
              </p>
            )}
            {memory.connectionError && state && (
              <p className="brain-memory-help">
                Showing the last loaded state. Updates will resume when Brain reconnects.
              </p>
            )}
          </div>
          <div className="brain-memory-actions">
            {memory.connectionError && <button onClick={memory.retry}>Retry</button>}
            <button onClick={memory.dismissError} aria-label="Dismiss error">
              ×
            </button>
          </div>
        </div>
      )}
      {memory.notice && (
        <p className="brain-notice" role="status">
          {memory.notice}
        </p>
      )}
      {memory.loadingSource && (
        <p className="brain-notice" role="status">
          Opening source snapshot…
        </p>
      )}
      {!state ? (
        <div className="brain-memory-empty" role="status">
          <h2>{memory.connectionError ? 'Memory is unavailable' : 'Loading memory…'}</h2>
          <p>
            {memory.connectionError
              ? 'Check that Brain is running, then retry the connection.'
              : 'Reading sources and synchronization status.'}
          </p>
          {memory.connectionError && (
            <button className="brain-button" onClick={memory.retry}>
              Try again
            </button>
          )}
        </div>
      ) : (
        <>
          <MemoryHealth state={state} readyCount={readyCount} />
          {editing === 'new' && (
            <MemorySourceForm
              projects={state.projects}
              busy={memory.busy}
              saveError={memory.error}
              adminRequired={memory.adminRequired}
              onSave={memory.addSource}
              onCancel={() => {
                setEditing(null);
                memory.dismissError();
              }}
            />
          )}
          <div className="brain-memory-filters">
            <label>
              Search sources
              <input
                type="search"
                value={query}
                disabled={editing !== null}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Title or Notion page ID"
              />
            </label>
            <label>
              Project
              <select
                value={scope}
                disabled={editing !== null}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="all">All projects</option>
                <option value="shared">Shared references only</option>
                {state.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} + shared
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="brain-memory-list-heading">
            <div className="brain-memory-status-filters" aria-label="Source status">
              {sourceViews.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={view === item.id}
                  disabled={editing !== null}
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                  <span>{filterMemorySources(state.sources, query, scope, item.id).length}</span>
                </button>
              ))}
            </div>
            <span aria-live="polite">
              {sources.length} {sources.length === 1 ? 'source' : 'sources'}
            </span>
          </div>
          {!sources.length ? (
            <div className="brain-memory-empty">
              <h2>
                {state.sources.length
                  ? 'No sources match these filters'
                  : 'Add your first reference'}
              </h2>
              <p>
                {state.sources.length
                  ? 'Clear the filters to see every source.'
                  : 'Add a Notion page and choose the project it belongs to. You can inspect it before approving it for analysis.'}
              </p>
              {state.sources.length ? (
                <button className="brain-button" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : !state.notion.connected ? (
                <a href="#brain/settings">Connect Notion →</a>
              ) : (
                <button
                  className="brain-button primary"
                  disabled={editing !== null}
                  onClick={() => setEditing('new')}
                >
                  Add Notion page
                </button>
              )}
            </div>
          ) : (
            <div className="brain-memory-sources">
              {sources.map((source) => {
                const syncing =
                  source.status === 'syncing' ||
                  activeJobs.some((job) => job.sourceId === source.id);
                const isEditing = editing === source.id;
                return (
                  <article
                    key={source.id}
                    className={`brain-memory-source${isEditing ? ' editing' : ''}`}
                    aria-label={source.title}
                  >
                    <div className="brain-memory-source-main">
                      <SourceSummary source={source} state={state} />
                      <button
                        className="brain-button brain-memory-read"
                        aria-label={`Read snapshot: ${source.title}`}
                        disabled={!source.currentSourceId || memory.loadingSource}
                        onClick={() =>
                          source.currentSourceId && void memory.openSource(source.currentSourceId)
                        }
                        title={
                          !source.currentSourceId
                            ? 'A snapshot becomes available after the first successful capture.'
                            : undefined
                        }
                      >
                        Read snapshot ↗
                      </button>
                    </div>
                    {source.error && (
                      <p className="brain-memory-inline-error" role="status">
                        {source.error}
                      </p>
                    )}
                    {memorySourceExplanation(source) && (
                      <p className="brain-memory-help">{memorySourceExplanation(source)}</p>
                    )}
                    <div className="brain-memory-source-footer">
                      <p className="brain-memory-version">
                        {source.lastSyncedAt
                          ? `Synced ${formatDate(source.lastSyncedAt)}`
                          : 'No snapshot yet'}
                        {source.revision && (
                          <>
                            {' '}
                            · <code title={source.revision}>{source.revision.slice(0, 12)}</code>
                          </>
                        )}
                      </p>
                      <div className="brain-memory-actions">
                        <button
                          className="brain-memory-text-button"
                          disabled={
                            memory.busy || syncing || !canSyncSource(source, state.notion.connected)
                          }
                          onClick={() => void memory.sync(source.id)}
                        >
                          {syncing
                            ? 'Syncing…'
                            : source.status === 'failed'
                              ? 'Retry sync'
                              : 'Sync'}
                        </button>
                        {source.kind !== 'review' && (
                          <button
                            className="brain-memory-text-button"
                            aria-label={`Source settings: ${source.title}`}
                            disabled={memory.busy || (editing !== null && !isEditing)}
                            aria-expanded={isEditing}
                            onClick={() => {
                              setEditing(isEditing ? null : source.id);
                              memory.dismissError();
                            }}
                          >
                            {isEditing ? 'Close settings' : 'Settings'}
                          </button>
                        )}
                        {source.url && /^https?:\/\//.test(source.url) && (
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.kind === 'notion' ? 'Notion' : 'Original'} ↗
                          </a>
                        )}
                      </div>
                    </div>
                    {isEditing && (
                      <MemorySourceForm
                        key={source.id}
                        source={source}
                        projects={state.projects}
                        busy={memory.busy}
                        saveError={memory.error}
                        adminRequired={memory.adminRequired}
                        onSave={({ projectIds, shared, mandatory, approval }) =>
                          memory.updateSource(source.id, {
                            projectIds,
                            shared,
                            mandatory,
                            approval,
                          })
                        }
                        onCancel={() => {
                          setEditing(null);
                          memory.dismissError();
                        }}
                      />
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {state.jobs.length > 0 && (
            <details className="brain-memory-jobs">
              <summary>
                Recent synchronization{' '}
                <span>
                  {activeJobs.length
                    ? `${activeJobs.length} in progress`
                    : `${state.jobs.length} jobs`}
                </span>
              </summary>
              <ul>
                {state.jobs.map((job) => (
                  <li key={job.id}>
                    <div>
                      <strong>
                        {state.sources.find((source) => source.id === job.sourceId)?.title ??
                          'Source'}
                      </strong>
                      <span className={`brain-memory-status ${job.status}`}>
                        {job.status === 'succeeded' ? 'Completed' : job.status}
                      </span>
                    </div>
                    <small>
                      {job.finishedAt || job.startedAt
                        ? formatDate(job.finishedAt ?? job.startedAt!)
                        : 'Waiting to start'}
                    </small>
                    {job.error && <p className="brain-memory-inline-error">{job.error}</p>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {memory.document && (
        <Suspense fallback={<p role="status">Opening source…</p>}>
          <BrainSourceViewer
            source={memory.document.source}
            sources={[memory.document.source]}
            line={memory.document.line}
            loading={memory.loadingSource}
            error={memory.error}
            onSelect={memory.openSource}
            onClose={memory.closeSource}
          />
        </Suspense>
      )}
    </section>
  );
}

function MemoryHealth({ state, readyCount }: { state: MemoryState; readyCount: number }) {
  return (
    <div className="brain-memory-health">
      <div className="brain-memory-health-services">
        <div>
          <span className={`brain-memory-dot ${state.notion.connected ? 'ready' : ''}`} />
          <strong>Notion</strong>
          <span>{state.notion.connected ? 'Connected' : 'Connection required'}</span>
        </div>
        <div>
          <span className={`brain-memory-dot ${state.cognee.available ? 'ready' : ''}`} />
          <strong>Memory index</strong>
          <span>{state.cognee.available ? 'Available' : 'Unavailable'}</span>
        </div>
        <a href="#brain/settings">Connection settings →</a>
      </div>
      <div className="brain-memory-health-summary">
        <strong>{readyCount} ready for analysis</strong>
        <span>
          {state.syncIntervalMs > 0
            ? `Auto-sync every ${Math.max(1, Math.round(state.syncIntervalMs / 60000))} min`
            : 'Manual sync'}
        </span>
      </div>
      {!state.cognee.available && state.cognee.reason && (
        <p className="brain-memory-inline-error">{state.cognee.reason}</p>
      )}
    </div>
  );
}

function SourceSummary({ source, state }: { source: MemorySource; state: MemoryState }) {
  return (
    <div className="brain-memory-source-info">
      <div className="brain-memory-source-heading">
        <span className="brain-eyebrow">
          {source.kind === 'review'
            ? 'HUMAN DECISION'
            : source.kind === 'notion'
              ? 'NOTION'
              : 'GIT'}
        </span>
        <span className={`brain-memory-status ${source.status}`}>{memorySourceStatus(source)}</span>
      </div>
      <h3>{source.title}</h3>
      <div className="brain-memory-tags">
        <span>
          {source.shared
            ? 'Shared with all projects'
            : source.projectIds
                .map((id) => state.projects.find((project) => project.id === id)?.name ?? id)
                .join(' · ')}
        </span>
        {source.mandatory && source.approval === 'approved' && <span>Required reference</span>}
        {source.status === 'failed' && <span>{source.approval}</span>}
      </div>
    </div>
  );
}
