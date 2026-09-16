import type { AnalysesState, Project } from './types';

export function AnalysisSetup({
  state,
  projectId,
  project,
  commit,
  baseCommit,
  busy,
  locked,
  onSelectProject,
  onCommitChange,
  onBaseCommitChange,
  onStart,
}: {
  state: AnalysesState;
  projectId: string;
  project?: Project;
  commit: string;
  baseCommit: string;
  busy: boolean;
  locked: boolean;
  onSelectProject: (projectId: string) => void;
  onCommitChange: (commit: string) => void;
  onBaseCommitChange: (commit: string) => void;
  onStart: () => Promise<void>;
}) {
  const launchLabel = state.activeRunId
    ? 'An analysis is running…'
    : busy
      ? 'Starting…'
      : 'Run AI analysis';
  return (
    <>
      <div className="brain-agents-connection">
        <strong>{state.configured ? `OpenAI API · ${state.model}` : 'AI calls unavailable'}</strong>
        <p>
          {state.configured
            ? 'Selected specification and code excerpts are sent to this model. Results remain proposals for human review.'
            : state.reason || 'Configure model access on the server to run a real analysis.'}
        </p>
      </div>
      <form
        className="brain-agents-setup"
        onSubmit={(event) => {
          event.preventDefault();
          void onStart();
        }}
      >
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
          <div className="brain-agents-scope">
            <strong>Scope</strong>
            <p>{project.scope}</p>
            <small>
              {project.specifications} specification{project.specifications > 1 ? 's' : ''}{' '}
              configured
            </small>
            <details>
              <summary>Allowed code files and folders ({project.codePaths.length})</summary>
              <ul>
                {project.codePaths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <details className="brain-agents-revisions">
          <summary>Choose commits (optional)</summary>
          <div>
            <label htmlFor="brain-agent-commit">Commit to review — defaults to HEAD</label>
            <input
              id="brain-agent-commit"
              value={commit}
              onChange={(event) => onCommitChange(event.target.value)}
              placeholder="Full commit SHA"
              pattern="[a-fA-F0-9]{40}"
              maxLength={40}
            />
            <label htmlFor="brain-agent-base">Base commit — to focus on changes</label>
            <input
              id="brain-agent-base"
              value={baseCommit}
              onChange={(event) => onBaseCommitChange(event.target.value)}
              placeholder="Full base commit SHA"
              pattern="[a-fA-F0-9]{40}"
              maxLength={40}
            />
          </div>
        </details>
        <div className="brain-agents-launch">
          <small>Read-only sources · final decision by a human</small>
          <button
            className="brain-button primary"
            disabled={locked || !state.configured || !project || !project.specifications}
          >
            {launchLabel}
          </button>
        </div>
      </form>
    </>
  );
}
