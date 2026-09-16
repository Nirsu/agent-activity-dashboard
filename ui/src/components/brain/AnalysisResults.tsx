import { formatDate, statusLabels } from './presentation';
import { CitationButton, ReviewDossier } from './ReviewDossier';
import type { Analysis, AnalysisRun, Finding, OpenSource } from './types';

export function AnalysisResults({
  projectName,
  configured,
  runs,
  selectedRun,
  detail,
  detailError,
  finding,
  busy,
  savingReview = false,
  locked,
  onSelectRun,
  onSelectFinding,
  onOpenSource,
  onSaveReview,
  onRetryDetail,
  onPrepareRetry,
}: {
  projectName?: string;
  configured: boolean;
  runs: AnalysisRun[];
  selectedRun?: AnalysisRun;
  detail: Analysis | null;
  detailError?: string;
  finding?: Finding;
  busy: boolean;
  savingReview?: boolean;
  locked: boolean;
  onSelectRun: (runId: string) => void;
  onSelectFinding: (findingId: string) => void;
  onOpenSource: OpenSource;
  onSaveReview: (decision: string, note: string) => Promise<void>;
  onRetryDetail: () => Promise<void>;
  onPrepareRetry: () => void;
}) {
  const completedRuns = runs.filter(
    (run) => run.status === 'succeeded' || run.status === 'running',
  );
  const stoppedRuns = runs.filter((run) => run.status === 'failed' || run.status === 'interrupted');
  return (
    <section
      className="brain-agents-results"
      id="brain-analysis-results"
      tabIndex={-1}
      aria-label="Analyses and results"
    >
      <div className="brain-section-head">
        <div>
          <h2>Results for {projectName ?? 'this project'}</h2>
          <p>AI findings are scoped to the captured sources. They do not approve a release.</p>
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
            Analysis history ({runs.length})
            <select
              id="brain-agent-run"
              disabled={busy}
              value={selectedRun?.id ?? ''}
              onChange={(event) => onSelectRun(event.target.value)}
            >
              {(
                [
                  ['Completed and running', completedRuns],
                  ['Failed and interrupted', stoppedRuns],
                ] as const
              ).map(
                ([label, items]) =>
                  items.length > 0 && (
                    <optgroup key={label} label={label}>
                      {items.map((run) => (
                        <option key={run.id} value={run.id}>
                          {formatDate(run.startedAt)} · {statusLabels[run.status]} ·{' '}
                          {run.commit?.slice(0, 8) ?? 'No commit captured'}
                        </option>
                      ))}
                    </optgroup>
                  ),
              )}
            </select>
          </label>
          {selectedRun && <AnalysisProgress run={selectedRun} />}
          {selectedRun && ['failed', 'interrupted'].includes(selectedRun.status) && (
            <div className="brain-agents-stopped">
              <p>This analysis did not finish. No result can be used as a completed review.</p>
              <button
                className="brain-button"
                type="button"
                disabled={locked}
                onClick={onPrepareRetry}
              >
                Reuse this setup
              </button>
            </div>
          )}
          {selectedRun?.feature && (
            <p className="brain-notice">Change under review: {selectedRun.feature}</p>
          )}
          {detail?.retrieval && (
            <p className="brain-agents-retrieval">
              Memory retrieved {formatDate(detail.retrieval.retrievedAt)} ·{' '}
              {detail.retrieval.sourceIds.length} source versions preserved with this analysis.
            </p>
          )}
          {detailError && (
            <div className="brain-agents-detail-error" role="alert">
              <p>
                {detailError}
                {detail &&
                  ' Showing the last loaded details; reviews are paused until they refresh.'}
              </p>
              <button
                className="brain-button"
                type="button"
                disabled={busy}
                onClick={() => void onRetryDetail()}
              >
                Retry loading details
              </button>
            </div>
          )}
          {!detail ? (
            !detailError && <p role="status">Loading details…</p>
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
                  <h3>
                    {detail.requirements.length
                      ? 'No review cases produced'
                      : 'No applicable requirements found'}
                  </h3>
                  <p>
                    {detail.requirements.length
                      ? 'This does not establish project compliance. Check the extracted requirements and run log.'
                      : 'There was nothing to compare against the code. Check the approved sources in Memory and narrow the feature description.'}
                  </p>
                </div>
              )}
              {detail.status === 'running' && (
                <p className="brain-agents-help" role="status">
                  Findings will appear when all analysis stages finish. You can leave this page and
                  return to the run.
                </p>
              )}
              {detail.status === 'succeeded' && detail.findings.length > 0 && (
                <>
                  <OutcomeSummary findings={detail.findings} />
                  <div className="brain-review-layout">
                    <aside className="brain-finding-list" aria-label="AI analysis results">
                      {detail.findings.map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          className={finding?.id === result.id ? 'selected' : ''}
                          aria-pressed={finding?.id === result.id}
                          aria-controls="brain-analysis-dossier"
                          onClick={() => onSelectFinding(result.id)}
                        >
                          <span className={`brain-badge ${result.outcome}`}>
                            {statusLabels[result.outcome]}
                          </span>
                          <strong>{result.title}</strong>
                          <small>
                            {result.reviews[0]
                              ? statusLabels[result.reviews[0].decision]
                              : result.outcome === 'difference'
                                ? detail.current
                                  ? 'Awaiting human review'
                                  : 'Historical finding'
                                : result.outcome === 'insufficient'
                                  ? 'More evidence needed'
                                  : 'Match in the captured sources'}
                          </small>
                        </button>
                      ))}
                    </aside>
                    {finding && (
                      <ReviewDossier
                        finding={finding}
                        sources={detail.sources}
                        reviewAllowed={detail.current && detail.status === 'succeeded'}
                        reviewKey={detail.id}
                        disabled={locked || Boolean(detailError)}
                        savingReview={savingReview}
                        onOpenSource={onOpenSource}
                        onSaveReview={onSaveReview}
                      />
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function AnalysisProgress({ run }: { run: AnalysisRun }) {
  const steps = [
    {
      title: 'Sources',
      description: 'Capture code and retrieve memory',
      stage: 'Capturing sources',
    },
    {
      title: 'Reader',
      description: 'Extract applicable requirements',
      stage: 'Reading project specifications',
    },
    {
      title: 'Comparison',
      description: 'Check code against each requirement',
      stage: 'Comparing captured code',
    },
    {
      title: 'Arbitration',
      description: 'Prepare findings for human review',
      stage: 'Preparing human review',
    },
  ];
  const reached = Math.max(
    0,
    ...steps.map((step, index) =>
      run.stage === step.stage || run.events.some((event) => event.message === step.stage)
        ? index
        : -1,
    ),
  );
  return (
    <div className="brain-agents-progress">
      <span className={`brain-badge ${run.status}`}>{statusLabels[run.status]}</span>
      <strong role="status">
        {run.status === 'succeeded'
          ? 'Analysis complete'
          : run.status === 'failed' || run.status === 'interrupted'
            ? 'Analysis stopped before completion'
            : run.stage}
      </strong>
      {run.commit && (
        <small title={run.commit}>
          Commit {run.commit.slice(0, 12)}
          {run.baseCommit && ` · from ${run.baseCommit.slice(0, 12)}`}
        </small>
      )}
      <ol className="brain-agents-steps" aria-label="Analysis stages">
        {steps.map((step, index) => {
          const status =
            index < reached || (index === reached && run.status === 'succeeded')
              ? 'Complete'
              : index === reached
                ? run.status === 'running'
                  ? 'In progress'
                  : 'Stopped'
                : run.status === 'running'
                  ? 'Waiting'
                  : 'Not run';
          return (
            <li
              key={step.title}
              className={
                status === 'In progress' ? 'active' : status === 'Complete' ? 'complete' : ''
              }
              aria-current={status === 'In progress' ? 'step' : undefined}
            >
              <span className="brain-agents-step-status">
                {status === 'Complete' ? '✓' : index + 1} · {status}
              </span>
              <strong>{step.title}</strong>
              <span>{step.description}</span>
            </li>
          );
        })}
      </ol>
      <details className="brain-agents-log">
        <summary>Run log · {run.model}</summary>
        <ol>
          {run.events.map((event, index) => (
            <li key={index}>
              <time dateTime={event.at}>{formatDate(event.at)}</time>
              {event.message}
            </li>
          ))}
        </ol>
        <p>
          {run.usage.inputTokens.toLocaleString()} input tokens ·{' '}
          {run.usage.outputTokens.toLocaleString()} output tokens
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

function OutcomeSummary({ findings }: { findings: Finding[] }) {
  return (
    <ul className="brain-agents-outcomes" aria-label="Findings by outcome">
      {(
        [
          ['difference', 'Suspected differences'],
          ['insufficient', 'Insufficient evidence'],
          ['aligned', 'Observed matches'],
        ] as const
      ).map(([outcome, label]) => (
        <li key={outcome}>
          <strong className={outcome}>
            {findings.filter((finding) => finding.outcome === outcome).length}
          </strong>
          <span>{label}</span>
        </li>
      ))}
    </ul>
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
                type="button"
                className="brain-button"
                onClick={() => onOpenSource(source.id)}
              >
                {source.kind === 'review'
                  ? 'Human decision'
                  : source.status === 'published'
                    ? 'Specification'
                    : 'Code'}{' '}
                · {source.title} ↗
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
