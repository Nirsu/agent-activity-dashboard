import { useRef, useState } from 'react';
import { setBrainAdminToken } from './brain/api';
import { AdministratorAccess } from './access/AdministratorAccess';
import { useAccounts, type Repository } from './access/useAccounts';
import {
  AccessEmpty,
  AccessHeader,
  AccessPolicy,
  AccessToolbar,
  type AccessFilter,
} from './access/AccessUI';
import { RepositoryEditor } from './access/RepositoryEditor';
import { repositoryBrainStatus } from './access/RepositoryBrainStatus';
import { RepositoryCard } from './access/RepositoryCard';
import './Accounts.css';

export function Projects() {
  const access = useAccounts();
  const [editor, setEditor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AccessFilter>('all');
  const [notice, setNotice] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const state = access.state;
  const repositories = state?.repositories ?? [];
  const enabled = repositories.filter((repository) => repository.enabled).length;
  const ready = repositories.filter(
    (repository) => repositoryBrainStatus(repository).state === 'ready',
  ).length;
  const visible = repositories.filter((repository) => {
    const projectName =
      state?.projects.find((project) => project.id === repository.brainProjectId)?.name ??
      repository.brainProjectId ??
      '';
    const brainStatus = repositoryBrainStatus(repository);
    return (
      (filter === 'all' || repository.enabled === (filter === 'enabled')) &&
      `${repository.name} ${repository.remote} ${projectName} ${brainStatus.label} ${brainStatus.message}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    );
  });
  const closeEditor = () => {
    setEditor(null);
    addButton.current?.focus();
  };
  const checkRepository = async (repository: Repository) => {
    setNotice('');
    const checked = await access.checkRepository(repository.id);
    if (checked) {
      setNotice(checked.brainStatus?.message ?? 'Brain access check completed.');
    }
  };
  const toggleRepository = (repository: Repository) =>
    access.saveRepository(
      {
        name: repository.name,
        remote: repository.remote,
        enabled: !repository.enabled,
        ...(repository.brainProjectId ? { brainProjectId: repository.brainProjectId } : {}),
        ...(repository.brainScope !== undefined ? { brainScope: repository.brainScope } : {}),
        ...(repository.brainCodePaths ? { brainCodePaths: repository.brainCodePaths } : {}),
      },
      repository.id,
    );
  return (
    <main className="access-page">
      <AccessHeader
        title="Projects"
        description="Connect repositories for agent activity and Harmony Brain analyses."
        busy={access.busy}
        unlocked={Boolean(state)}
        refresh={() => void access.refresh()}
        lock={() => {
          setBrainAdminToken('');
          access.lock();
          setEditor(null);
          setNotice('');
        }}
      >
        <button
          className="access-primary access-add"
          ref={addButton}
          disabled={access.busy}
          onClick={() => {
            setEditor('new');
            setNotice('');
          }}
        >
          Add project
        </button>
      </AccessHeader>
      {!state && !access.busy && (
        <AdministratorAccess section="projects" busy={access.busy} unlock={access.refresh} />
      )}
      {access.error && (
        <p className="access-error" role="alert">
          {access.error}
        </p>
      )}
      <div className="access-feedback" role="status">
        {access.busy ? 'Updating projects…' : state ? notice : ''}
      </div>
      {state && (
        <>
          <div className="access-summary">
            <div>
              <span>Repositories</span>
              <strong>
                {repositories.length}
                <small>in your workspace</small>
              </strong>
            </div>
            <div>
              <span>Enabled repositories</span>
              <strong>
                {enabled}
                <small>available for collection</small>
              </strong>
            </div>
            <div>
              <span>Brain ready</span>
              <strong>
                {ready}
                <small>code & references verified</small>
              </strong>
            </div>
          </div>
          <AccessPolicy
            title={
              state.filterRepositories ? 'Repository filter enabled' : 'Repository filter disabled'
            }
            enabled={state.filterRepositories}
            description={
              state.filterRepositories
                ? 'Only enabled repositories can send activity. An empty list blocks all incoming activity.'
                : 'All repositories can send activity. Add your repositories and update developer relays before enabling the filter.'
            }
            busy={access.busy}
            action={
              state.filterRepositories ? 'Disable repository filter' : 'Enable repository filter'
            }
            onChange={() => void access.filterRepositories(!state.filterRepositories)}
          />
          <div className={`access-project-layout${editor ? ' editing' : ''}`}>
            <section
              className="access-panel access-collection"
              aria-label="Authorized repositories"
            >
              <div className="access-collection-heading">
                <h2>
                  Repositories <span className="access-count">{repositories.length}</span>
                </h2>
                <span>Shared across all developers</span>
              </div>
              <AccessToolbar
                query={query}
                setQuery={setQuery}
                filter={filter}
                setFilter={setFilter}
                total={repositories.length}
                enabled={enabled}
                kind="projects"
              />
              {!repositories.length ? (
                <AccessEmpty
                  icon="folder"
                  title="Connect your first project"
                  action={
                    <button className="access-primary" onClick={() => setEditor('new')}>
                      Add your first project
                    </button>
                  }
                >
                  Add a GitHub repository to collect agent activity and register its Brain project
                  automatically.
                </AccessEmpty>
              ) : !visible.length ? (
                <AccessEmpty
                  icon="search"
                  title="No matching projects"
                  action={
                    <button
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      Clear filters
                    </button>
                  }
                >
                  Try another project name, remote URL or status.
                </AccessEmpty>
              ) : (
                <div className="access-repositories">
                  {visible.map((repository) => (
                    <RepositoryCard
                      key={repository.id}
                      repository={repository}
                      brainProjectName={
                        state.projects.find((project) => project.id === repository.brainProjectId)
                          ?.name
                      }
                      busy={access.busy}
                      selected={editor === repository.id}
                      edit={() => {
                        setEditor(repository.id);
                        setNotice('');
                      }}
                      check={() => void checkRepository(repository)}
                      toggle={() => void toggleRepository(repository)}
                    />
                  ))}
                </div>
              )}
              <div className="access-collection-footer">
                {visible.length} of {repositories.length} repositories
              </div>
            </section>
            {editor && (
              <aside className="access-panel access-detail">
                <RepositoryEditor
                  key={editor}
                  repository={repositories.find((repository) => repository.id === editor)}
                  projects={state.projects}
                  busy={access.busy}
                  close={closeEditor}
                  save={async (input, id) => {
                    const saved = await access.saveRepository(input, id);
                    if (saved) {
                      closeEditor();
                      setQuery('');
                      setFilter('all');
                      setNotice(
                        id
                          ? 'Repository updated.'
                          : 'Project registered for activity and Brain. Check Brain access to verify readiness.',
                      );
                    }
                  }}
                />
              </aside>
            )}
          </div>
          <details className="access-guide">
            <summary>
              Connecting workstations & enabling Brain analyses<span>Setup guide</span>
            </summary>
            <div className="access-guide-grid">
              <div>
                <h3>01 · Connect workstations</h3>
                <p>
                  Update the agent setup, select the local clones and restart each relay before
                  enabling the filter. The relay checks each Git origin against this shared list.
                </p>
                <a href="#accounts">Manage accounts & workstation tokens →</a>
              </div>
              <div>
                <h3>02 · Check Brain readiness</h3>
                <p>
                  Every project is registered with Brain automatically. Configure GitHub read access
                  once on the server, approve the project references in Memory, then check access.
                  The developer agent submits the ticket and local changes through MCP; Brain reads
                  related GitHub code when needed. All active developers share access.
                </p>
                <a href="#brain/memory">Manage approved references →</a>
              </div>
            </div>
          </details>
        </>
      )}
    </main>
  );
}
