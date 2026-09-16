import { useEffect, useId, useRef, useState } from 'react';
import type { MemorySource, SourceApproval, SourceRegistration } from './memoryTypes';
import { notionPageId } from './notionPageId';
import { brainConfig } from './config';

export function MemorySourceForm({
  source,
  projects,
  busy,
  saveError = '',
  adminRequired = false,
  onSave,
  onCancel,
}: {
  source?: MemorySource;
  projects: { id: string; name: string }[];
  busy: boolean;
  saveError?: string;
  adminRequired?: boolean;
  onSave: (value: SourceRegistration) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [pageId, setPageId] = useState(source?.pageId ?? '');
  const [projectIds, setProjectIds] = useState(source?.projectIds ?? []);
  const [shared, setShared] = useState(source?.shared ?? false);
  const [mandatory, setMandatory] = useState(source?.mandatory ?? false);
  const [approval, setApproval] = useState<SourceApproval>(source?.approval ?? 'draft');
  const [error, setError] = useState('');
  const messageId = useId();
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error || saveError) {
      feedback.current?.focus();
    }
  }, [error, saveError]);

  return (
    <form
      className="brain-memory-form"
      aria-label={source ? 'Edit source settings' : 'Add a Notion page'}
      aria-busy={busy}
      aria-describedby={error || saveError ? messageId : undefined}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!shared && !projectIds.length) {
          setError('Choose at least one project or make this a shared source.');
          return;
        }
        setError('');
        let normalizedId;
        try {
          normalizedId = source ? (source.pageId ?? '') : notionPageId(pageId);
        } catch (error) {
          setError(error instanceof Error ? error.message : 'Invalid Notion page ID.');
          return;
        }
        const saved = await onSave({
          pageId: normalizedId,
          projectIds: shared ? [] : projectIds,
          shared,
          mandatory,
          approval,
        });
        if (saved) {
          onCancel();
        }
      }}
    >
      <h2>{source ? 'Source settings' : 'Add a Notion page'}</h2>
      <fieldset className="brain-memory-form-fields" disabled={busy}>
        {!source && (
          <>
            <label>
              Notion page link or ID
              <input
                required
                autoFocus
                maxLength={brainConfig.projects.maxLocalPathCharacters}
                value={pageId}
                onChange={(event) => setPageId(event.target.value)}
                placeholder="https://www.notion.so/…"
              />
            </label>
          </>
        )}
        <fieldset disabled={source?.kind === 'git'}>
          <legend>Use for</legend>
          <label className="brain-memory-checkbox">
            <input
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            All projects (shared reference)
          </label>
          {!shared && (
            <div className="brain-memory-project-options">
              {projects.length ? (
                projects.map((project) => (
                  <label key={project.id} className="brain-memory-checkbox">
                    <input
                      type="checkbox"
                      checked={projectIds.includes(project.id)}
                      onChange={(event) =>
                        setProjectIds(
                          event.target.checked
                            ? [...projectIds, project.id]
                            : projectIds.filter((id) => id !== project.id),
                        )
                      }
                    />
                    {project.name}
                  </label>
                ))
              ) : (
                <p>
                  No project registered. Configure a project on the server before assigning
                  project-specific sources.
                </p>
              )}
            </div>
          )}
        </fieldset>
        {source?.kind === 'git' && (
          <p className="brain-memory-help">
            Git scope follows its registered repository and project. Approval and inclusion can be
            changed here.
          </p>
        )}
        <label>
          Approval
          <select
            value={approval}
            onChange={(event) => setApproval(event.target.value as SourceApproval)}
          >
            <option value="draft">Draft</option>
            <option value="approved">Approved</option>
            {source && <option value="withdrawn">Withdrawn</option>}
          </select>
        </label>
        <p className="brain-memory-help">
          {approval === 'draft'
            ? 'Capture the page for inspection. Drafts are excluded from analyses.'
            : approval === 'approved'
              ? 'Use this reference in analyses after it has been indexed.'
              : 'Exclude this source from future analyses. Previous evidence is kept.'}
        </p>
        <label className="brain-memory-checkbox">
          <input
            type="checkbox"
            checked={mandatory}
            onChange={(event) => setMandatory(event.target.checked)}
          />
          Always include when approved
        </label>
        <p className="brain-memory-help">
          {source?.kind === 'git'
            ? 'This changes Brain’s use of the source, not the repository.'
            : 'The original Notion page is never changed. New or updated pages sync automatically.'}
        </p>
      </fieldset>
      {(error || saveError) && (
        <p
          ref={feedback}
          tabIndex={-1}
          id={messageId}
          role="alert"
          className="brain-memory-inline-error"
        >
          {error || saveError}
          {adminRequired && (
            <>
              <br />
              <a href="#brain/settings">Set administrator access in Settings →</a>
            </>
          )}
        </p>
      )}
      <div className="brain-memory-actions">
        <button className="brain-button primary" disabled={busy}>
          {busy ? 'Saving…' : source ? 'Save settings' : 'Add page'}
        </button>
        <button type="button" className="brain-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
