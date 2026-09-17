import { MemorySourceForm } from './MemorySourceForm';
import { formatDate, memorySourceExplanation, memorySourceStatus } from './presentation';
import { canSyncSource } from './memoryView';
import type { MemorySource, MemoryState } from './memoryTypes';
import type { useBrainMemory } from './useBrainMemory';

export function MemorySourceCard({
  source,
  state,
  memory,
  editing,
  onEdit,
}: {
  source: MemorySource;
  state: MemoryState;
  memory: ReturnType<typeof useBrainMemory>;
  editing: string | null;
  onEdit: (id: string | null) => void;
}) {
  const activeJobs = state.jobs.filter(
    (job) => job.status === 'queued' || job.status === 'running',
  );
  const syncing =
    source.status === 'syncing' || activeJobs.some((job) => job.sourceId === source.id);
  const isEditing = editing === source.id;
  return (
    <article
      className={`brain-memory-source${isEditing ? ' editing' : ''}`}
      aria-label={source.title}
    >
      <div className="brain-memory-source-main">
        <SourceSummary source={source} state={state} />
        <button
          className="brain-button brain-memory-read"
          aria-label={`Read snapshot: ${source.title}`}
          disabled={!source.currentSourceId || memory.loadingSource}
          onClick={() => source.currentSourceId && void memory.openSource(source.currentSourceId)}
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
          {source.lastSyncedAt ? `Synced ${formatDate(source.lastSyncedAt)}` : 'No snapshot yet'}
          {source.revision && (
            <>
              {' '}
              · <code title={source.revision}>{source.revision.slice(0, 12)}</code>
            </>
          )}
        </p>
        <div className="brain-memory-actions">
          {source.includeSubpages &&
            source.approval !== 'withdrawn' &&
            state.sources.some((child) => child.parentSourceId === source.id) && (
              <button
                className="brain-memory-text-button"
                disabled={memory.busy || Boolean(activeJobs.length)}
                onClick={() => void memory.approveSubpages(source.id)}
              >
                Approve current subpages
              </button>
            )}
          <button
            className="brain-memory-text-button"
            disabled={memory.busy || syncing || !canSyncSource(source, state.notion.connected)}
            onClick={() => void memory.sync(source.id)}
          >
            {syncing ? 'Syncing…' : source.status === 'failed' ? 'Retry sync' : 'Sync'}
          </button>
          {source.kind !== 'review' && (
            <button
              className="brain-memory-text-button"
              aria-label={`Source settings: ${source.title}`}
              disabled={memory.busy || (editing !== null && !isEditing)}
              aria-expanded={isEditing}
              onClick={() => {
                onEdit(isEditing ? null : source.id);
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
          onSave={({ pageId: _pageId, title: _title, ...policy }) =>
            memory.updateSource(source.id, policy)
          }
          onCancel={() => {
            onEdit(null);
            memory.dismissError();
          }}
        />
      )}
    </article>
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
        {source.parentSourceId && (
          <span>
            Subpage of{' '}
            {state.sources.find((parent) => parent.id === source.parentSourceId)?.title ??
              'registered page'}
          </span>
        )}
        {source.includeSubpages && !source.parentSourceId && <span>Includes subpages</span>}
        {source.autoApproveSubpages && !source.parentSourceId && (
          <span>Automatic subpage approval</span>
        )}
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
