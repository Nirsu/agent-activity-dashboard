import { usd } from '../../format';
import type { TrendsReport } from './useTrends';
import { trendDayLabel, trendTimestamp } from './format';

export function ReportContext({
  data,
  section,
}: {
  data: TrendsReport;
  section: 'coverage' | 'insights' | 'notes';
}) {
  const { summary, period, coverage, insights } = data;
  const ignoredCostCount = coverage.ignoredCostCount ?? 0;
  const missingCostCount = Math.max(0, summary.unknownUsageCount - ignoredCostCount);
  const costObservations = summary.knownCostCount + summary.unknownUsageCount;
  const knownPercent =
    costObservations > 0 ? (summary.knownCostCount / costObservations) * 100 : null;
  if (section === 'coverage') {
    const missingUsage = missingCostCount > 0 || summary.unknownTokenCount > 0;
    if (!missingUsage) {
      return null;
    }
    return (
      <aside className="trends-coverage-note trends-coverage-summary" aria-label="Data coverage">
        <h2>Some data is incomplete</h2>
        <dl className="trends-coverage-details">
          {missingUsage && (
            <div>
              <dt>
                {summary.unknownTokenCount > 0
                  ? 'Unavailable costs or tokens'
                  : 'Unavailable costs'}
              </dt>
              {missingCostCount > 0 && (
                <dd>
                  <strong>{missingCostCount.toLocaleString()}</strong> usage observations have
                  unknown costs.
                </dd>
              )}
              {summary.unknownTokenCount > 0 && (
                <dd>
                  <strong>{summary.unknownTokenCount.toLocaleString()}</strong> observations have
                  unknown tokens.
                </dd>
              )}
              <dd>Only known values are included in the totals.</dd>
              {missingCostCount > 0 && (
                <dd className="trends-coverage-action">
                  <a href="#settings/brain">
                    Review model pricing <span aria-hidden="true">→</span>
                  </a>
                </dd>
              )}
            </div>
          )}
        </dl>
      </aside>
    );
  }
  if (section === 'insights') {
    return (
      <aside className="trends-chart-card trends-insights-card" aria-label="Period insights">
        <h2 className="trends-chart-title">At a glance</h2>
        <p className="trends-chart-caption">A few useful reference points.</p>
        <div className="trends-insight">
          <span>Average known cost / day</span>
          <strong>{summary.costKnown ? usd(insights.averageDailyCostUsd) : 'Unavailable'}</strong>
          <small>
            Across {period.dayCount} calendar {period.dayCount === 1 ? 'day' : 'days'} in this range
            {!coverage.currentComplete ? ' · partial history' : ''}.
          </small>
        </div>
        <div className="trends-insight">
          <span>Most expensive day</span>
          <strong>{insights.peakDay ? usd(insights.peakDay.costUsd) : 'Unavailable'}</strong>
          <small>
            {insights.peakDay
              ? `${trendDayLabel(insights.peakDay.day, true)} · known cost`
              : 'No known costs in this period.'}
          </small>
        </div>
        <div className="trends-insight trends-coverage-insight">
          <div className="trends-coverage-heading">
            <span>Cost coverage</span>
            <strong>
              {knownPercent === null
                ? '—'
                : `${knownPercent.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`}
            </strong>
          </div>
          <div className="trends-coverage-track" aria-hidden="true">
            <div style={{ width: `${knownPercent ?? 0}%` }} />
          </div>
          <small>
            {knownPercent === null
              ? 'No cost observations in this period.'
              : `${summary.knownCostCount.toLocaleString()} of ${costObservations.toLocaleString()} cost observations have a known cost.`}
          </small>
        </div>
      </aside>
    );
  }
  return (
    <details className="trends-notes">
      <summary>
        About these numbers{' '}
        <span className="trends-notes-timezone">
          {period.timeZone} · {coverage.retentionDays}-day retention
        </span>
      </summary>
      <div className="trends-notes-body">
        <p>
          <strong>Reporting period:</strong> {trendTimestamp(period.start, period.timeZone)} to{' '}
          {trendTimestamp(period.end, period.timeZone)}. Dates follow the server time zone (
          {period.timeZone}). Today and the current day include activity recorded so far.
        </p>
        <p>
          <strong>Comparison period:</strong>{' '}
          {trendTimestamp(period.previousStart, period.timeZone)} to{' '}
          {trendTimestamp(period.previousEnd, period.timeZone)}. Today compares with yesterday at
          the same local time. Other ranges compare with the preceding period covering the same
          number of calendar days, ending at the same local time for an ongoing period. This month
          starts on the first day of the month; 30 days is a rolling calendar range.
        </p>
        <p>
          <strong>Sessions and usage:</strong> unique sessions are counted once across the selected
          period. Costs and tokens include known observations only. Missing observations are never
          assumed to be zero, and percentages are unavailable when a comparable baseline is missing
          or incomplete. Model-based costs, including historical recalculations, are estimates
          rather than provider billing amounts.
        </p>
        {ignoredCostCount > 0 && (
          <p>
            <strong>Ignored models:</strong> {ignoredCostCount.toLocaleString()} unpriced
            observations belong to models ignored in pricing. Their tokens remain included; their
            costs remain unavailable. They do not trigger pricing reminders.
          </p>
        )}
        <p>
          <strong>History:</strong> {coverage.retentionDays} days are retained.{' '}
          {coverage.earliestAvailableAt
            ? `Earliest available observation: ${trendTimestamp(coverage.earliestAvailableAt, period.timeZone)}. `
            : 'No recorded history yet. '}
          Increasing retention cannot restore data already removed.{' '}
          {usd(summary.unattributedCostUsd)} of known cost is not linked to a ticket or work item.
        </p>
      </div>
    </details>
  );
}
