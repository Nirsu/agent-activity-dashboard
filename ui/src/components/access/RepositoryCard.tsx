import { AccessIcon, AccessStatus } from './AccessUI';
import { RepositoryBrainStatus } from './RepositoryBrainStatus';
import type { Repository } from './useAccounts';

export function RepositoryCard({
  repository,
  brainProjectName,
  busy,
  selected,
  edit,
  check,
  toggle,
}: {
  repository: Repository;
  brainProjectName?: string;
  busy: boolean;
  selected: boolean;
  edit: () => void;
  check: () => void;
  toggle: () => void;
}) {
  return (
    <article className={`access-repository${selected ? ' selected' : ''}`}>
      <span className="access-repository-icon">
        <AccessIcon name="folder" />
      </span>
      <div className="access-repository-main">
        <div className="access-repository-title">
          <h3>{repository.name}</h3>
          <AccessStatus tone={repository.enabled ? 'good' : 'muted'}>
            {repository.enabled ? 'Enabled' : 'Disabled'}
          </AccessStatus>
        </div>
        <p className="repository-remote">{repository.remote}</p>
        {repository.brainProjectId && (
          <span className="access-project-link linked">
            Brain: {brainProjectName ?? repository.brainProjectId}
          </span>
        )}
        <RepositoryBrainStatus repository={repository} />
      </div>
      <div className="access-repository-actions">
        <button
          disabled={busy || !repository.enabled || repository.brainStatus?.state === 'unsupported'}
          aria-label={`Check Brain access for ${repository.name}`}
          onClick={check}
        >
          Check Brain access
        </button>
        <button disabled={busy} aria-label={`Edit repository ${repository.name}`} onClick={edit}>
          Edit repository
        </button>
        <button
          className="access-quiet"
          disabled={busy}
          aria-label={`${repository.enabled ? 'Disable' : 'Enable'} repository ${repository.name}`}
          onClick={toggle}
        >
          {repository.enabled ? 'Disable repository' : 'Enable repository'}
        </button>
      </div>
    </article>
  );
}
