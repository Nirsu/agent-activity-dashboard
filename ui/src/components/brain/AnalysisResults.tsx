import { formatDate, statusLabels } from './presentation';
import { CitationButton, ReviewDossier } from './ReviewDossier';
import type { Analysis, AnalysisRun, Finding, OpenSource } from './types';

export function AnalysisResults({
  projectName,
  configured,
  runs,
  selectedRun,
  detail,
  finding,
  busy,
  locked,
  onSelectRun,
  onSelectFinding,
  onOpenSource,
  onSaveReview,
}: {
  projectName?: string;
  configured: boolean;
  runs: AnalysisRun[];
  selectedRun?: AnalysisRun;
  detail: Analysis | null;
  finding?: Finding;
  busy: boolean;
  locked: boolean;
  onSelectRun: (runId: string) => void;
  onSelectFinding: (findingId: string) => void;
  onOpenSource: OpenSource;
  onSaveReview: (decision: string, note: string) => Promise<void>;
}) {
  return (
    <section className="brain-agents-results" aria-label="Analyses and results">
      <div className="brain-section-head">
        <div>
          <h2>Analyses for {projectName ?? 'this project'}</h2>
          <p>Each run preserves its sources and associated reviews.</p>
        </div>
      </div>
      {!runs.length ? (
        <div className="brain-empty">
          <h3>No analyses for this project</h3>
          <p>
            {configured
              ? 'Run an analysis on a commit to get findings backed by sources.'
              : 'Results will appear after setup and the first model call.'}
          </p>
        </div>
      ) : (
        <>
          <label className="brain-agents-run-picker" htmlFor="brain-agent-run">
            Run
            <select
              id="brain-agent-run"
              disabled={busy}
              value={selectedRun?.id ?? ''}
              onChange={(event) => onSelectRun(event.target.value)}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {formatDate(run.startedAt)} · {statusLabels[run.status]} ·{' '}
                  {run.commit?.slice(0, 8) ?? 'Capturing sources'}
                </option>
              ))}
            </select>
          </label>
          {selectedRun && <AnalysisProgress run={selectedRun} />}
          {!detail ? (
            <p role="status">Loading details…</p>
          ) : (
            <>
              {!detail.current && detail.status === 'succeeded' && (
                <p className="brain-warning">
                  Read-only historical analysis. Run a new analysis to review the current scope.
                </p>
              )}
              <AnalysisSources analysis={detail} onOpenSource={onOpenSource} />
              {detail.status === 'succeeded' && !detail.findings.length && (
                <div className="brain-empty">
                  <h3>No review cases produced</h3>
                  <p>
                    This result does not establish project compliance. Check the extracted
                    requirements and run log.
                  </p>
                </div>
              )}
              {detail.findings.length > 0 && (
                <div className="brain-review-layout">
                  <aside className="brain-finding-list" aria-label="AI analysis results">
                    {detail.findings.map((result) => (
                      <button
                        key={result.id}
                        className={finding?.id === result.id ? 'selected' : ''}
                        onClick={() => onSelectFinding(result.id)}
                      >
                        <span className={`brain-badge ${result.outcome}`}>
                          {statusLabels[result.outcome]}
                        </span>
                        <strong>{result.title}</strong>
                        <small>
                          {result.reviews[0]
                            ? statusLabels[result.reviews[0].decision]
                            : 'Needs examination'}
                        </small>
                      </button>
                    ))}
                  </aside>
                  {finding && (
                    <ReviewDossier
                      finding={finding}
                      sources={detail.sources}
                      variant="analysis"
                      reviewAllowed={detail.current && detail.status === 'succeeded'}
                      reviewKey={detail.id}
                      disabled={locked}
                      onOpenSource={onOpenSource}
                      onSaveReview={onSaveReview}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function AnalysisProgress({ run }: { run: AnalysisRun }) {
  return (
    <div className="brain-agents-progress">
      <span className={`brain-badge ${run.status}`}>{statusLabels[run.status]}</span>
      <strong role="status">{run.stage}</strong>
      {run.commit && (
        <small title={run.commit}>
          Commit {run.commit.slice(0, 12)}
          {run.baseCommit && ` · from ${run.baseCommit.slice(0, 12)}`}
        </small>
      )}
      <details open={run.status === 'running' || run.status === 'failed'}>
        <summary>Run log · {run.model}</summary>
        <ol>
          {run.events.map((event, index) => (
            <li key={index}>
              <time>{formatDate(event.at)}</time>
              {event.message}
            </li>
          ))}
        </ol>
        <p>
          {run.usage.inputTokens} input tokens · {run.usage.outputTokens} output tokens
        </p>
      </details>
      {run.error && (
        <p className="brain-warning" role="alert">
          {run.error}
        </p>
      )}
    </div>
  );
}

function AnalysisSources({
  analysis,
  onOpenSource,
}: {
  analysis: Analysis;
  onOpenSource: OpenSource;
}) {
  return (
    <>
      {analysis.sources.length > 0 && (
        <details className="brain-agents-sources">
          <summary>Sources for this analysis ({analysis.sources.length})</summary>
          <div>
            {analysis.sources.map((source) => (
              <button
                key={source.id}
                className="brain-button"
                onClick={() => onOpenSource(source.id)}
              >
                {source.status === 'published' ? 'Specification' : 'Code'} · {source.title} ↗
              </button>
            ))}
          </div>
        </details>
      )}
      {analysis.requirements.length > 0 && (
        <details className="brain-agents-sources">
          <summary>Extracted requirements ({analysis.requirements.length})</summary>
          {analysis.requirements.map((requirement) => (
            <article key={requirement.id}>
              <h3>{requirement.statement}</h3>
              <p>{requirement.scope}</p>
              <CitationButton
                citation={requirement.citation}
                sources={analysis.sources}
                onOpenSource={onOpenSource}
              />
            </article>
          ))}
        </details>
      )}
    </>
  );
}
