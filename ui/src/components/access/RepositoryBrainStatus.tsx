import { AccessStatus } from './AccessUI';
import type { Repository } from './useAccounts';

const labels = {
  ready: 'Brain ready',
  needs_access: 'GitHub access needed',
  needs_references: 'References needed',
  unverified: 'Brain check needed',
  disabled: 'Brain disabled',
  unsupported: 'GitHub required',
};

export function repositoryBrainStatus(repository: Repository) {
  const status = !repository.enabled
    ? { state: 'disabled' as const, message: 'Enable this repository to use Brain analyses.' }
    : (repository.brainStatus ?? {
        state: 'unverified' as const,
        message: 'Check code access and approved references before the first analysis.',
      });
  return { ...status, label: labels[status.state] };
}

export function RepositoryBrainStatus({ repository }: { repository: Repository }) {
  const status = repositoryBrainStatus(repository);
  const tone =
    status.state === 'ready' ? 'good' : status.state === 'disabled' ? 'muted' : 'warning';
  return (
    <div className="access-brain-status">
      <AccessStatus tone={tone}>{status.label}</AccessStatus>
      <p>{status.message}</p>
      {status.state === 'needs_references' && (
        <a href="#brain/memory">Manage approved references →</a>
      )}
      {status.state === 'needs_access' && (
        <small>
          An administrator can configure read access to this repository on the Brain server.
        </small>
      )}
    </div>
  );
}
