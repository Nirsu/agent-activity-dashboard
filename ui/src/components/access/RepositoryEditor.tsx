import { useState } from 'react';
import type { Repository } from './useAccounts';

export function RepositoryEditor({
  repository,
  projects,
  busy,
  save,
  close,
}: {
  repository?: Repository;
  projects: { id: string; name: string }[];
  busy: boolean;
  save: (input: Omit<Repository, 'id'>, id?: string) => Promise<void>;
  close: () => void;
}) {
  const [name, setName] = useState(repository?.name ?? '');
  const [remote, setRemote] = useState(repository?.remote ?? '');
  const [brainProjectId, setBrainProjectId] = useState(repository?.brainProjectId ?? '');
  return (
    <form
      className="access-form"
      onSubmit={async (event) => {
        event.preventDefault();
        await save(
          {
            name,
            remote,
            enabled: repository?.enabled ?? true,
            ...(brainProjectId ? { brainProjectId } : {}),
          },
          repository?.id,
        );
      }}
    >
      <div className="access-section-heading">
        <div>
          <span className="access-eyebrow">Repository settings</span>
          <h2>{repository ? 'Edit repository' : 'Add a project'}</h2>
        </div>
        <button
          type="button"
          className="access-close"
          aria-label="Close project editor"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </div>
      <p>Connect a Git repository to your workspace.</p>
      <label>
        Project name
        <input
          autoFocus
          disabled={busy}
          required
          maxLength={160}
          placeholder="e.g. Customer portal"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Git remote URL
        <input
          required
          maxLength={1000}
          placeholder="git@github.com:team/project.git"
          disabled={busy}
          value={remote}
          onChange={(event) => setRemote(event.target.value)}
        />
        <span className="access-field-hint">HTTPS or SSH origin URL, without an access token.</span>
      </label>
      <label>
        Brain project (optional)
        <select
          disabled={busy}
          value={brainProjectId}
          onChange={(event) => setBrainProjectId(event.target.value)}
        >
          <option value="">Activity only</option>
          {brainProjectId && !projects.some((project) => project.id === brainProjectId) && (
            <option value={brainProjectId}>{brainProjectId} (no longer registered)</option>
          )}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <span className="access-field-hint">
          Link a registered Brain project to identify its code analyses.
        </span>
      </label>
      <div className="access-form-footer">
        <button className="access-primary" disabled={busy}>
          {repository ? 'Save repository' : 'Add repository'}
        </button>
        <button type="button" disabled={busy} onClick={close}>
          {repository ? 'Cancel editing' : 'Cancel'}
        </button>
      </div>
    </form>
  );
}
