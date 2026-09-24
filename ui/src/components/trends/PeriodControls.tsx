import { useId, useState } from 'react';
import type { TrendsReport, TrendsSelection } from './useTrends';
import { trendDateAt, trendDayLabel } from './format';

const PERIODS: Array<{ period: TrendsSelection['period']; label: string }> = [
  { period: 'today', label: 'Today' },
  { period: '7d', label: '7 days' },
  { period: '14d', label: '14 days' },
  { period: 'month', label: 'This month' },
  { period: '30d', label: '30 days' },
  { period: '90d', label: '90 days' },
];

export function PeriodControls({
  selection,
  data,
  onChange,
}: {
  selection: TrendsSelection;
  data: TrendsReport | null;
  onChange: (selection: TrendsSelection) => void;
}) {
  const formId = useId();
  const [customOpen, setCustomOpen] = useState(selection.period === 'custom');
  const [start, setStart] = useState(selection.start ?? '');
  const [end, setEnd] = useState(selection.end ?? '');
  const [error, setError] = useState('');
  const today = data ? trendDateAt(Date.now(), data.period.timeZone) : undefined;

  function applyCustom(event: React.FormEvent) {
    event.preventDefault();
    if (!start || !end) {
      setError('Choose a start and end date.');
      return;
    }
    if (start > end) {
      setError('The end date must be on or after the start date.');
      return;
    }
    if (today && end > today) {
      setError('Choose an end date no later than today in the server time zone.');
      return;
    }
    const dayCount = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
    if (!Number.isFinite(dayCount) || dayCount > 90) {
      setError('Choose a range of up to 90 days, including both dates.');
      return;
    }
    setError('');
    onChange({ ...selection, period: 'custom', start, end });
  }

  return (
    <section className="trends-period-section" aria-label="Reporting period">
      <div className="trends-period-row">
        <div className="trends-period-options" role="group" aria-label="Choose reporting period">
          {PERIODS.map((item) => (
            <button
              key={item.period}
              type="button"
              aria-pressed={selection.period === item.period}
              onClick={() => {
                setCustomOpen(false);
                setError('');
                onChange({ ...selection, period: item.period });
              }}
            >
              {item.label}
            </button>
          ))}
          <button
            className="trends-period-custom"
            type="button"
            aria-pressed={selection.period === 'custom'}
            aria-expanded={customOpen}
            aria-controls={formId}
            onClick={() => {
              if (!customOpen && data) {
                setStart(selection.start ?? data.period.startDate);
                setEnd(selection.end ?? data.period.endDate);
              }
              setCustomOpen(!customOpen);
            }}
          >
            Custom <span className="trends-chevron" aria-hidden="true" />
          </button>
        </div>
        <div className="trends-period-meta">
          <span className="trends-period-range">
            {data
              ? `${trendDayLabel(data.period.startDate)} – ${trendDayLabel(data.period.endDate, true)}`
              : 'Loading period…'}
          </span>
          {data?.enabled && (
            <span className="trends-history-start">
              {data.coverage.earliestAvailableAt !== null
                ? `History since ${trendDayLabel(trendDateAt(data.coverage.earliestAvailableAt, data.period.timeZone), true)}`
                : 'No activity recorded yet'}
            </span>
          )}
        </div>
      </div>
      {customOpen && (
        <form id={formId} className="trends-custom-range" onSubmit={applyCustom} noValidate>
          <label>
            Start date
            <input
              type="date"
              value={start}
              max={today}
              aria-describedby={error ? `${formId}-error` : `${formId}-hint`}
              aria-invalid={Boolean(error)}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            End date
            <input
              type="date"
              value={end}
              max={today}
              aria-describedby={error ? `${formId}-error` : `${formId}-hint`}
              aria-invalid={Boolean(error)}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
          <button className="dashboard-button trends-apply" type="submit">
            Apply dates
          </button>
          <p id={`${formId}-hint`}>Up to 90 days · dates follow the server time zone.</p>
          {error && (
            <p id={`${formId}-error`} className="trends-form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
