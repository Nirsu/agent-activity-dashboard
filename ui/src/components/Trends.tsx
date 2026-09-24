import { useTrends } from './trends/useTrends';
import { PeriodControls } from './trends/PeriodControls';
import { SummaryCards } from './trends/SummaryCards';
import { UsageChart } from './trends/UsageChart';
import { UsageBreakdown } from './trends/UsageBreakdown';
import { ReportContext } from './trends/ReportContext';
import { AudienceFilters } from './trends/AudienceFilters';
import { AudienceTable } from './trends/AudienceTable';
import './trends/trends.css';

export function Trends() {
  const { data, error, loading, selection, audience, setSelection, refresh } = useTrends();
  return (
    <div className="trends trends-page" aria-busy={loading}>
      <header className="activity-page-heading trends-heading">
        <div>
          <p className="trends-eyebrow">Activity analytics</p>
          <h1>Usage trends</h1>
          <p>Understand your activity, follow spending, and see what changes over time.</p>
        </div>
        <button className="dashboard-button" disabled={loading} onClick={refresh}>
          {loading ? 'Refreshing…' : error ? 'Retry loading' : 'Refresh'}
        </button>
      </header>
      <PeriodControls selection={selection} data={data} onChange={setSelection} />
      <AudienceFilters selection={selection} options={audience} onChange={setSelection} />
      {!data ? (
        <div className="trends-empty trends-loading-state" role="status">
          <span className="trends-state-icon" aria-hidden="true">
            {error ? '!' : '…'}
          </span>
          <strong>{error ? 'History could not be loaded' : 'Loading activity history'}</strong>
          <p>
            {error
              ? 'Try again using Retry loading, or choose another period.'
              : 'Gathering your usage and comparison period…'}
          </p>
        </div>
      ) : !data.enabled ? (
        <div className="trends-empty trends-loading-state" role="status">
          <strong>History is unavailable</strong>
          <p>Trends will appear when activity history is enabled.</p>
        </div>
      ) : (
        <>
          {error && (
            <p className="trends-coverage-note" role="status">
              History refresh failed. Showing the last received data for this period.
            </p>
          )}
          <ReportContext data={data} section="coverage" />
          <SummaryCards data={data} />
          <UsageChart data={data} />
          <AudienceTable data={data} selection={selection} onChange={setSelection} />
          <div className="trends-detail-grid">
            <UsageBreakdown data={data} />
            <ReportContext data={data} section="insights" />
          </div>
          <ReportContext data={data} section="notes" />
        </>
      )}
    </div>
  );
}
