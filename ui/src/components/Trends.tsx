import { useMemo } from 'react';
import { tokens, usd } from '../format';
import { useTrends } from './trends/useTrends';
import { DailyCostChart, trendDayLabel } from './trends/DailyCostChart';

export function Trends() {
  const { data: d, error, loading, refresh } = useTrends();

  const totals = useMemo(() => {
    const days = d?.days ?? [];
    return {
      cost: days.reduce((a, x) => a + x.costUsd, 0),
      tokens: days.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0),
      prompts: days.reduce((a, x) => a + x.prompts, 0),
      sessions: days.reduce((a, x) => a + x.sessions, 0),
      costKnown: days.some((x) => x.costKnown),
      tokensKnown: days.some((x) => x.tokensKnown),
      unknown: days.reduce((a, x) => a + x.unknownUsageCount, 0),
      unattributed: days.reduce((a, x) => a + x.unattributedCostUsd, 0),
    };
  }, [d]);

  const heading = (
    <header className="activity-page-heading trends-heading">
      <div>
        <h1>Usage trends</h1>
        <p>Last 14 days · all providers and streams</p>
      </div>
      <button className="dashboard-button" disabled={loading} onClick={refresh}>
        {loading ? 'Refreshing…' : error ? 'Retry loading' : 'Refresh'}
      </button>
    </header>
  );
  if (d && !d.enabled) {
    return (
      <div className="trends">
        {heading}
        <div className="trends-empty" role="status">
          History is unavailable. Trends will appear when activity history is enabled.
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="trends">
        {heading}
        <div className="trends-empty" role="status">
          {error
            ? 'History could not be loaded. Try again using Retry loading.'
            : 'Loading activity history…'}
        </div>
      </div>
    );
  }

  const days = d.days;
  const maxStreamCost = Math.max(0.0001, ...d.byStream.map((s) => s.costUsd));

  return (
    <div className="trends">
      {heading}
      {error && <p role="status">History refresh failed. Showing the last received data.</p>}
      {totals.unknown > 0 && (
        <p className="trends-coverage-note">
          {totals.unknown.toLocaleString()} usage observations have unknown costs. The totals below
          include known usage only. <a href="#settings/brain">Review model pricing →</a>
        </p>
      )}
      <div className="trends-tiles">
        <Tile
          label="Known cost · 14d"
          value={totals.costKnown ? usd(totals.cost) : 'Unavailable'}
          accent
        />
        <Tile
          label="Known tokens · 14d"
          value={totals.tokensKnown ? tokens(totals.tokens) : 'Unavailable'}
        />
        <Tile label="Prompts · 14d" value={String(totals.prompts)} />
        <Tile label="Session appearances · 14d" value={String(totals.sessions)} />
      </div>

      <div className="trends-chart-card">
        <h2 className="trends-chart-title">Known cost per day</h2>
        <p className="trends-chart-caption">
          USD · Missing usage is excluded. Exact values are available in the daily figures below.
        </p>
        <DailyCostChart days={days} />
        {!totals.costKnown && (
          <p className="trends-empty-inline">
            No known costs for this period. Unknown costs are not treated as zero.
          </p>
        )}
        <details className="trends-daily">
          <summary>View daily figures</summary>
          <div
            className="trends-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Daily usage figures"
          >
            <table>
              <caption>Daily usage · unavailable values are excluded from known totals</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Known cost</th>
                  <th scope="col">Known tokens</th>
                  <th scope="col">Prompts</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">Unknown costs</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.day}>
                    <th scope="row">
                      <time dateTime={day.day}>{trendDayLabel(day.day)}</time>
                    </th>
                    <td>{day.costKnown ? usd(day.costUsd) : 'Unavailable'}</td>
                    <td>
                      {day.tokensKnown
                        ? (day.tokensIn + day.tokensOut).toLocaleString()
                        : 'Unavailable'}
                    </td>
                    <td>{day.prompts}</td>
                    <td>{day.sessions}</td>
                    <td>{day.unknownUsageCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      <div className="trends-chart-card">
        <h2 className="trends-chart-title">Cost by team · 14 days</h2>
        <p className="trends-empty-inline">
          Shared activity appears in each team. Overall totals count it once.
        </p>
        {d.byStream.length === 0 && <div className="trends-empty-inline">No data yet.</div>}
        {d.byStream.map((s) => (
          <div key={s.teamId} className="trends-stream-row">
            <span className="trends-stream-name">{s.teamName ?? s.teamId}</span>
            <div className="trends-stream-bar">
              <div
                className="trends-stream-fill"
                style={{ width: `${(s.costUsd / maxStreamCost) * 100}%` }}
              />
            </div>
            <span className="trends-stream-val">
              {s.costKnown ? usd(s.costUsd) : 'Unavailable'}
            </span>
          </div>
        ))}
      </div>
      <details className="trends-notes">
        <summary>How to read these estimates</summary>
        <p>
          Session appearances count a session on each day it is active, so they are not unique
          sessions over the whole period. Costs include known usage only; missing observations are
          not zero-cost activity.
        </p>
        <p>
          Dates follow the server’s time zone. {usd(totals.unattributed)} is not linked to a ticket
          or work item.
        </p>
      </details>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="trends-tile">
      <div className={`trends-tile-value ${accent ? 'accent' : ''}`}>{value}</div>
      <div className="trends-tile-label">{label}</div>
    </div>
  );
}
