import { useState } from 'react';
import { ago, duration, tokens, usd } from '../format';
import { useBrainActivity, type BrainActivityRun } from './brain/useBrainActivity';
import { brainConfig } from './brain/config';
import './BrainActivityBoard.css';

const statusLabels: Record<BrainActivityRun['status'], string> = {
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
};
type RunFilter = 'all' | 'running' | 'review';

function AnalysisRow({ run }: { run: BrainActivityRun }) {
  const tokenCount = run.usage.inputTokens + run.usage.outputTokens;
  const tokenLabel =
    run.usageKnown || tokenCount > 0
      ? `${tokens(tokenCount)} tokens${run.usageKnown ? '' : ' · partial'}`
      : 'Tokens unavailable';
  const reviewCount = run.pendingReviewCount ?? 0;
  const outcome =
    run.status === 'running'
      ? 'In progress'
      : run.status !== 'succeeded'
        ? 'No conclusion'
        : `${run.differenceCount} difference${run.differenceCount === 1 ? '' : 's'}`;
  const workItem = run.ticket ?? run.workItemId;
  const elapsed = duration(
    (run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt),
  );
  const date = new Date(run.startedAt);
  return (
    <li>
      <a className="brain-run" href={`#brain/agents/${encodeURIComponent(run.id)}`}>
        <div className="brain-run-identity">
          <strong title={run.projectName}>{run.projectName}</strong>
          <div className="brain-run-context">
            <span className={workItem ? 'brain-run-ticket' : ''}>{workItem ?? 'No work item'}</span>
            <span aria-hidden="true">·</span>
            <span className="brain-run-stage" title={run.stage}>
              {run.status === 'running' ? (run.activeRole ?? run.stage) : run.model}
            </span>
          </div>
        </div>
        <div className="brain-run-result">
          <span className={`brain-run-status brain-run-status-${run.status}`}>
            <span aria-hidden="true" />
            {statusLabels[run.status]}
          </span>
          <span className={reviewCount ? 'brain-run-review' : 'brain-run-outcome'}>
            {reviewCount ? `${reviewCount} awaiting review` : outcome}
          </span>
        </div>
        <div className="brain-run-usage">
          <span>{tokenLabel}</span>
          <small
            title={
              run.costBasis === 'legacy_uncached'
                ? 'Estimated from archived token totals at uncached rates. Cache discounts are unknown. Excluded from call-level usage totals.'
                : undefined
            }
          >
            {run.costUsd == null ? 'Cost unavailable' : `${usd(run.costUsd)} estimated`}
            {run.costUsd != null && run.costBasis === 'legacy_uncached' ? ' · cache unknown' : ''}
          </small>
        </div>
        <div className="brain-run-time">
          <span>{elapsed}</span>
          <time dateTime={run.startedAt} title={date.toLocaleString()}>
            {date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </time>
        </div>
        <svg
          className="brain-run-chevron"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m6 4 4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    </li>
  );
}

export function BrainActivityBoard() {
  return <BrainActivityView {...useBrainActivity()} />;
}

export function BrainActivityView({
  runs,
  loaded,
  error,
  updatedAt,
}: ReturnType<typeof useBrainActivity>) {
  const [projectId, setProjectId] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const projects = [...new Map(runs.map((run) => [run.projectId, run.projectName])).entries()];
  const scoped = runs.filter((run) => !projectId || run.projectId === projectId);
  const running = scoped.filter((run) => run.status === 'running').length;
  const reviewRuns = scoped.filter((run) => (run.pendingReviewCount ?? 0) > 0).length;
  const visible = scoped.filter(
    (run) =>
      filter === 'all' ||
      (filter === 'running' ? run.status === 'running' : (run.pendingReviewCount ?? 0) > 0),
  );
  const ordered = [...visible].sort(
    (left, right) =>
      Number(right.status === 'running') - Number(left.status === 'running') ||
      Number((right.pendingReviewCount ?? 0) > 0) - Number((left.pendingReviewCount ?? 0) > 0) ||
      Date.parse(right.startedAt) - Date.parse(left.startedAt),
  );
  const displayed = expanded ? ordered : ordered.slice(0, brainConfig.ui.boardRecentRuns);
  const filters: { value: RunFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All analyses', count: scoped.length },
    { value: 'running', label: 'Running', count: running },
    { value: 'review', label: 'To review', count: reviewRuns },
  ];

  return (
    <section className="brain-activity" aria-labelledby="brain-activity-title">
      <header className="brain-activity-heading">
        <div className="brain-activity-title-group">
          <span className="brain-activity-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none">
              <path
                d="m10 2 7 4v8l-7 4-7-4V6l7-4Zm0 0v16M3 6l7 4 7-4M3 14l7-4 7 4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div>
            <h2 id="brain-activity-title">Brain analyses</h2>
            <p>Checks, findings and human review</p>
          </div>
        </div>
        <a className="brain-activity-open" href="#brain/agents">
          Open Brain <span aria-hidden="true">↗</span>
        </a>
      </header>
      <div className="brain-activity-toolbar">
        <div className="brain-activity-filters" role="group" aria-label="Filter analyses by status">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => {
                setFilter(item.value);
                setExpanded(false);
              }}
            >
              {item.label}
              <span>{item.count}</span>
            </button>
          ))}
        </div>
        <select
          aria-label="Filter analyses by project"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            setExpanded(false);
          }}
        >
          <option value="">All projects</option>
          {projects.map(([id, name]) => (
            <option value={id} key={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="status" className="brain-activity-error">
          {error}
        </p>
      )}
      {!loaded && !error && (
        <p role="status" className="brain-activity-empty">
          Loading Brain activity…
        </p>
      )}
      {loaded && visible.length === 0 && (
        <div className="brain-activity-empty">
          {scoped.length === 0 ? (
            <>
              <strong>No analyses yet</strong>
              <span>Run a check in Brain to see its progress here.</span>
            </>
          ) : (
            <>
              <strong>
                {filter === 'running' ? 'No analyses running' : 'No analyses awaiting review'}
              </strong>
              <span>Choose All analyses to browse the recent history.</span>
            </>
          )}
        </div>
      )}
      {displayed.length > 0 && (
        <>
          <div className="brain-activity-columns" aria-hidden="true">
            <span>Analysis</span>
            <span>Status / findings</span>
            <span>Usage</span>
            <span>Duration</span>
            <span />
          </div>
          <ul
            className="brain-activity-list"
            id="brain-activity-list"
            aria-label="Recent Brain analyses"
          >
            {displayed.map((run) => (
              <AnalysisRow key={run.id} run={run} />
            ))}
          </ul>
        </>
      )}
      {loaded && (
        <footer className="brain-activity-footer">
          <span>
            {displayed.length} of {visible.length} analyses
            {updatedAt ? ` · Updated ${ago(updatedAt)}` : ''}
          </span>
          {visible.length > brainConfig.ui.boardRecentRuns && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls="brain-activity-list"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show fewer' : `View all ${visible.length}`}
              <span aria-hidden="true">{expanded ? '↑' : '↓'}</span>
            </button>
          )}
        </footer>
      )}
      <p className="brain-activity-note">
        Completed means the analysis finished. Human decisions remain separate. Costs exclude memory
        indexing.
      </p>
    </section>
  );
}
