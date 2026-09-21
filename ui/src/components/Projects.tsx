import { useRef, useState } from 'react';
import { setBrainAdminToken } from './brain/api';
import { AdministratorAccess } from './access/AdministratorAccess';
import { useAccounts } from './access/useAccounts';
import './Accounts.css';

export function Projects() {
  const access = useAccounts();
  const [name, setName] = useState('');
  const [remote, setRemote] = useState('');
  const [brainProjectId, setBrainProjectId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const state = access.state;
  const editing = state?.repositories.find((repository) => repository.id === editingId);
  function resetEditor() {
    setEditingId(null);
    setName('');
    setRemote('');
    setBrainProjectId('');
  }
  return (
    <main className="access-page">
      <div className="access-heading">
        <div>
          <span className="access-eyebrow">ADMINISTRATION</span>
          <h1>Projects</h1>
          <p>
            Choose which Git repositories can send agent activity. This list applies to every
            developer.
          </p>
        </div>
        <div className="access-actions">
          <button disabled={access.busy} onClick={() => void access.refresh()}>
            Refresh
          </button>
          {state && (
            <button
              disabled={access.busy}
              onClick={() => {
                setBrainAdminToken('');
                access.lock();
                resetEditor();
              }}
            >
              Lock page
            </button>
          )}
        </div>
      </div>
      {!state && (
        <AdministratorAccess section="projects" busy={access.busy} unlock={access.refresh} />
      )}
      {access.error && (
        <p className="access-error" role="alert">
          {access.error}
        </p>
      )}
      {access.busy && <p role="status">Updating projects…</p>}
      {state && (
        <>
          <section className="access-panel access-policy">
            <div>
              <h2>
                {state.filterRepositories
                  ? 'Repository filter enabled'
                  : 'Repository filter disabled'}
              </h2>
              <p>
                {state.filterRepositories
                  ? 'Only enabled repositories below can send activity. An empty list blocks all incoming activity.'
                  : 'Add your repositories, update developer relays, then enable the filter. While disabled, this list does not restrict incoming activity.'}
              </p>
            </div>
            <button
              disabled={access.busy}
              onClick={() => void access.filterRepositories(!state.filterRepositories)}
            >
              {state.filterRepositories ? 'Disable repository filter' : 'Enable repository filter'}
            </button>
          </section>
          <div className="access-grid">
            <section className="access-panel">
              <form
                className="access-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const saved = await access.saveRepository(
                    {
                      name,
                      remote,
                      enabled: editing?.enabled ?? true,
                      ...(brainProjectId ? { brainProjectId } : {}),
                    },
                    editingId ?? undefined,
                  );
                  if (saved) {
                    resetEditor();
                  }
                }}
              >
                <h2>{editingId ? 'Edit authorized repository' : 'Add authorized repository'}</h2>
                <label>
                  Project name
                  <input
                    ref={nameInput}
                    disabled={access.busy}
                    required
                    maxLength={160}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label>
                  Git remote URL
                  <input
                    required
                    maxLength={1000}
                    placeholder="https://github.com/organization/project.git"
                    disabled={access.busy}
                    value={remote}
                    onChange={(event) => setRemote(event.target.value)}
                  />
                </label>
                <p>
                  Use the repository's origin URL, in HTTPS or SSH format, without an access token.
                </p>
                <label>
                  Brain project (optional)
                  <select
                    disabled={access.busy}
                    value={brainProjectId}
                    onChange={(event) => setBrainProjectId(event.target.value)}
                  >
                    <option value="">Activity only</option>
                    {brainProjectId &&
                      !state.projects.some((project) => project.id === brainProjectId) && (
                        <option value={brainProjectId}>
                          {brainProjectId} (no longer registered)
                        </option>
                      )}
                    {state.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="access-actions">
                  <button disabled={access.busy}>
                    {editingId ? 'Save repository' : 'Add repository'}
                  </button>
                  {editingId && (
                    <button type="button" disabled={access.busy} onClick={resetEditor}>
                      Cancel editing
                    </button>
                  )}
                </div>
              </form>
            </section>
            <section className="access-panel">
              <h2>Authorized repositories</h2>
              {!state.repositories.length && <p>No repositories added yet.</p>}
              {state.repositories.map((repository) => (
                <div className="access-token" key={repository.id}>
                  <div>
                    <strong>{repository.name}</strong>
                    <span className="repository-remote">{repository.remote}</span>
                    <small>
                      {repository.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                      {repository.brainProjectId
                        ? `Brain: ${state.projects.find((project) => project.id === repository.brainProjectId)?.name ?? repository.brainProjectId}`
                        : 'Activity only'}
                    </small>
                  </div>
                  <div className="access-actions">
                    <button
                      disabled={access.busy}
                      onClick={() => {
                        setEditingId(repository.id);
                        setName(repository.name);
                        setRemote(repository.remote);
                        setBrainProjectId(repository.brainProjectId ?? '');
                        nameInput.current?.focus();
                      }}
                    >
                      Edit repository
                    </button>
                    <button
                      disabled={access.busy}
                      onClick={() =>
                        void access.saveRepository(
                          {
                            name: repository.name,
                            remote: repository.remote,
                            enabled: !repository.enabled,
                            ...(repository.brainProjectId
                              ? { brainProjectId: repository.brainProjectId }
                              : {}),
                          },
                          repository.id,
                        )
                      }
                    >
                      {repository.enabled ? 'Disable repository' : 'Enable repository'}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          </div>
          <section className="access-panel">
            <h2>Connect developer workstations</h2>
            <p>
              Update the agent setup and restart each relay before enabling the filter. Each
              workstation must also select its local clones during setup. The relay reads their Git
              origin and checks this shared list before sending activity.
            </p>
            <p>
              Manage developer identities and revoke workstation tokens in{' '}
              <a href="#accounts">Accounts</a>.
            </p>
            <h2>Enable Brain analyses</h2>
            <p>
              Adding a repository here authorizes activity collection. To analyze its code, register
              its server-side Git checkout and approved references in the Brain project
              configuration. All active developers share access to those registered Brain projects.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
