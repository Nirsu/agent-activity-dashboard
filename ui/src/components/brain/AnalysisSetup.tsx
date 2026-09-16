import type { AnalysesState, Project } from './types';
import { brainConfig } from './config';

export function AnalysisSetup({
  state,
  projectId,
  project,
  commit,
  baseCommit,
  feature,
  busy,
  locked,
  onSelectProject,
  onCommitChange,
  onBaseCommitChange,
  onFeatureChange,
  onStart,
  onShowActiveRun,
}: {
  state: AnalysesState;
  projectId: string;
  project?: Project;
  commit: string;
  baseCommit: string;
  feature: string;
  busy: boolean;
  locked: boolean;
  onSelectProject: (projectId: string) => void;
  onCommitChange: (commit: string) => void;
  onBaseCommitChange: (commit: string) => void;
  onFeatureChange: (feature: string) => void;
  onStart: () => Promise<void>;
  onShowActiveRun: () => void;
}) {
  const activeRun = state.runs.find((run) => run.id === state.activeRunId);
  const launchLabel = state.activeRunId
    ? 'An analysis is running…'
    : busy
      ? 'Please wait…'
      : 'Run AI analysis';
  return (
    <>
      <form
        id="brain-analysis-setup"
        className="brain-agents-setup"
        onSubmit={(event) => {
          event.preventDefault();
          void onStart();
        }}
      >
        <div className="brain-agents-setup-heading">
          <h2>Check a change</h2>
          <p>Choose a project and describe the feature you want Brain to examine.</p>
        </div>
        {!state.configured && (
          <p className="brain-warning">
            {state.reason || 'Configure model access on the server to run an analysis.'}{' '}
            <a href="#brain/settings">Open settings</a>
          </p>
        )}
        <label htmlFor="brain-agent-project">Project to check</label>
        <select
          id="brain-agent-project"
          value={projectId}
          disabled={busy || !state.projects.length}
          onChange={(event) => onSelectProject(event.target.value)}
        >
          {!state.projects.length && <option value="">No projects configured</option>}
          {state.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {project && (
          <details className="brain-agents-scope">
            <summary>Project scope and sources</summary>
            <p>{project.scope}</p>
            <p>
              {project.specifications} configured Git specification
              {project.specifications !== 1 ? 's' : ''}. Approved Notion pages and shared references
              are retrieved from <a href="#brain/memory">Memory</a>.
            </p>
            <strong>Allowed code files and folders ({project.codePaths.length})</strong>
            <ul>
              {project.codePaths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
        <label htmlFor="brain-agent-feature">Feature or change to check (optional)</label>
        <textarea
          id="brain-agent-feature"
          rows={3}
          value={feature}
          maxLength={brainConfig.analysis.maxTextCharacters}
          disabled={locked}
          aria-describedby="brain-agent-feature-help"
          onChange={(event) => onFeatureChange(event.target.value)}
          placeholder="For example: Preserve export dates in the activity report."
        />
        <p className="brain-agents-help" id="brain-agent-feature-help">
          The description guides the analysis. To restrict code to changed files, add a base commit
          below. Uncommitted edits are not included.
        </p>
        <details className="brain-agents-revisions">
          <summary>Commit range (optional) · defaults to the latest local commit</summary>
          <p className="brain-agents-help">
            Commits must exist in the server checkout. Leave the base empty to inspect the
            configured code scope.
          </p>
          <div>
            <label htmlFor="brain-agent-commit">Commit to review</label>
            <input
              id="brain-agent-commit"
              value={commit}
              onChange={(event) => onCommitChange(event.target.value)}
              placeholder="Latest local commit (HEAD)"
              pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"
              title="Use a full 40- or 64-character Git commit ID."
              maxLength={64}
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
            />
            <label htmlFor="brain-agent-base">Compare changes since</label>
            <input
              id="brain-agent-base"
              value={baseCommit}
              onChange={(event) => onBaseCommitChange(event.target.value)}
              placeholder="Full base commit ID"
              pattern="[a-fA-F0-9]{40}|[a-fA-F0-9]{64}"
              title="Use a full 40- or 64-character Git commit ID."
              maxLength={64}
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </details>
        {state.activeRunId && (
          <div className="brain-agents-active" role="status">
            <span>
              An analysis is running{activeRun ? ` for ${activeRun.projectName}` : ''}. Its progress
              updates automatically.
            </span>
            <button
              className="brain-button"
              type="button"
              onClick={onShowActiveRun}
              disabled={!activeRun}
            >
              View running analysis
            </button>
          </div>
        )}
        <div className="brain-agents-launch">
          <small>
            {state.configured && (
              <strong>
                {state.model} · OpenAI API
                <br />
              </strong>
            )}
            Selected source excerpts are sent to the model. A human makes the final decision.
          </small>
          <button
            className="brain-button primary"
            disabled={locked || !state.configured || !project}
          >
            {launchLabel}
          </button>
        </div>
      </form>
    </>
  );
}
