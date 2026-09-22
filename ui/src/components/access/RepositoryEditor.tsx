import { useState } from 'react';
import { brainConfig } from '../brain/config';
import type { Repository, RepositoryInput } from './useAccounts';

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
  save: (input: RepositoryInput, id?: string) => Promise<void>;
  close: () => void;
}) {
  const [name, setName] = useState(repository?.name ?? '');
  const [remote, setRemote] = useState(repository?.remote ?? '');
  const [brainProjectId, setBrainProjectId] = useState(repository?.brainProjectId ?? '');
  const [scope, setScope] = useState(repository?.brainScope ?? '');
  const [codePaths, setCodePaths] = useState(repository?.brainCodePaths?.join('\n') ?? '**');
  const [scopeEdited, setScopeEdited] = useState(false);
  const [pathsEdited, setPathsEdited] = useState(false);
  const [validationError, setValidationError] = useState('');
  const linkedProject = projects.find((project) => project.id === brainProjectId);
  return (
    <form
      className="access-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const paths = codePaths
          .split(/\r?\n/)
          .map((path) => path.trim())
          .filter(Boolean);
        const configureScope = !brainProjectId || Boolean(repository?.brainProjectId);
        if (configureScope && ((!repository && !brainProjectId) || pathsEdited)) {
          if (!paths.length || paths.length > brainConfig.projects.maxCodePaths) {
            setValidationError(
              `Enter between 1 and ${brainConfig.projects.maxCodePaths} code paths, one per line.`,
            );
            return;
          }
        }
        setValidationError('');
        await save(
          {
            name,
            remote,
            enabled: repository?.enabled ?? true,
            ...(brainProjectId ? { brainProjectId } : {}),
            ...(configureScope && ((!repository && !brainProjectId) || scopeEdited)
              ? { brainScope: scope }
              : {}),
            ...(configureScope && ((!repository && !brainProjectId) || pathsEdited)
              ? { brainCodePaths: paths }
              : {}),
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
      <p>Add a GitHub repository once for activity collection and Harmony Brain analyses.</p>
      <label>
        Project name
        <input
          autoFocus
          disabled={busy}
          required
          maxLength={brainConfig.projects.maxNameCharacters}
          placeholder="e.g. Customer portal"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        GitHub repository URL
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
      <div className="access-brain-registration">
        <strong>Harmony Brain is included</strong>
        <p>
          Brain reads GitHub code when an analysis needs it. Your agent can submit local changes
          through MCP before committing.
        </p>
      </div>
      {repository?.brainProjectId ? (
        <p className="access-field-hint">
          Brain project: <strong>{linkedProject?.name ?? repository.brainProjectId}</strong>. Its
          identity and analysis history are retained.
        </p>
      ) : projects.length > 0 ? (
        <label>
          Brain project
          <select
            disabled={busy}
            value={brainProjectId}
            onChange={(event) => {
              setBrainProjectId(event.target.value);
              setValidationError('');
            }}
          >
            <option value="">Create automatically</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                Use existing: {project.name}
              </option>
            ))}
          </select>
          <span className="access-field-hint">
            Select an existing project to retain its references and analysis history.
          </span>
        </label>
      ) : null}
      {brainProjectId && !repository?.brainProjectId ? (
        <p className="access-field-hint">
          The existing project keeps its analysis scope and code paths. You can edit these after
          connecting the repository.
        </p>
      ) : (
        <details className="access-analysis-scope">
          <summary>Analysis scope</summary>
          <div>
            <label>
              Project description
              <textarea
                disabled={busy}
                maxLength={brainConfig.analysis.maxTextCharacters}
                rows={3}
                placeholder="What does this project do?"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  setScopeEdited(true);
                }}
              />
              <span className="access-field-hint">
                Help Brain understand the project. Defaults to the project name.
              </span>
            </label>
            <label>
              Allowed code paths
              <textarea
                required
                disabled={busy}
                rows={3}
                value={codePaths}
                onChange={(event) => {
                  setCodePaths(event.target.value);
                  setPathsEdited(true);
                }}
              />
              <span className="access-field-hint">
                One file or folder per line (up to {brainConfig.projects.maxCodePaths}), such as
                src/ or package.json. ** allows repository code, excluding sensitive files,
                generated files and approved references.
              </span>
            </label>
          </div>
        </details>
      )}
      {validationError && (
        <p className="access-error" role="alert">
          {validationError}
        </p>
      )}
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
