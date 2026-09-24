import { useState } from 'react';
import { tokens, usd } from '../../format';
import { comparisonLabel } from './SummaryCards';
import type { TrendsReport, TrendsSelection } from './useTrends';

export function AudienceTable({
  data,
  selection,
  onChange,
}: {
  data: TrendsReport;
  selection: TrendsSelection;
  onChange: (selection: TrendsSelection) => void;
}) {
  const [dimension, setDimension] = useState<'team' | 'person'>(
    selection.team || selection.person ? 'person' : 'team',
  );
  const [comparison, setComparison] = useState<'cost' | 'tokens' | 'prompts' | 'sessions'>('cost');
  const rows = dimension === 'team' ? data.byTeam : data.byPerson;
  const rowLabel =
    dimension === 'team'
      ? rows.length === 1
        ? 'team'
        : 'teams'
      : rows.length === 1
        ? 'person'
        : 'people';
  return (
    <section className="trends-chart-card trends-audience-card" aria-label="Team and person usage">
      <div className="trends-card-heading">
        <div>
          <h2 className="trends-chart-title">Usage by team and person</h2>
          <p className="trends-chart-caption">
            Select a row to explore its activity over time and the models behind it.
          </p>
        </div>
        <div className="trends-segmented" role="group" aria-label="Audience dimension">
          <button
            type="button"
            aria-pressed={dimension === 'team'}
            onClick={() => setDimension('team')}
          >
            Teams
          </button>
          <button
            type="button"
            aria-pressed={dimension === 'person'}
            onClick={() => setDimension('person')}
          >
            People
          </button>
        </div>
      </div>
      <div className="trends-audience-toolbar">
        <span>
          {rows.length} {rowLabel} in the selected or previous period
        </span>
        <label>
          Compare
          <select
            value={comparison}
            onChange={(event) => setComparison(event.target.value as typeof comparison)}
          >
            <option value="cost">Cost</option>
            <option value="tokens">Tokens</option>
            <option value="prompts">Prompts</option>
            <option value="sessions">Sessions</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="trends-empty-inline">No activity matches these filters.</p>
      ) : (
        <div
          className="trends-audience-scroll"
          tabIndex={0}
          role="region"
          aria-label="Audience usage table"
        >
          <table className="trends-audience-table">
            <caption className="sr-only">
              Usage by {dimension === 'team' ? 'team' : 'person'} for the selected period
            </caption>
            <thead>
              <tr>
                <th scope="col">{dimension === 'team' ? 'Team' : 'Person'}</th>
                <th scope="col">Known cost</th>
                <th scope="col">Tokens</th>
                <th scope="col">Known cached tokens</th>
                <th scope="col">Prompts</th>
                <th scope="col">Sessions</th>
                <th scope="col">{comparison[0].toUpperCase() + comparison.slice(1)} change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const current = row.current;
                return (
                  <tr key={row.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="trends-audience-link"
                        onClick={() => {
                          setDimension('person');
                          onChange(
                            dimension === 'team'
                              ? { ...selection, team: row.id, person: undefined }
                              : { ...selection, person: row.id },
                          );
                        }}
                      >
                        {row.name}
                        <span aria-hidden="true">↗</span>
                      </button>
                    </th>
                    <td>
                      {current.costKnown ? usd(current.costUsd) : 'Unavailable'}
                      {current.unknownUsageCount > 0 && <small>Partial cost</small>}
                    </td>
                    <td>
                      {current.tokensKnown ? tokens(current.tokens) : 'Unavailable'}
                      <small>
                        {current.tokensInKnown ? tokens(current.tokensIn) : 'Unknown'} in ·{' '}
                        {current.tokensOutKnown ? tokens(current.tokensOut) : 'Unknown'} out
                      </small>
                    </td>
                    <td>{current.cacheKnown ? tokens(current.cachedTokens) : 'Unavailable'}</td>
                    <td>{current.prompts.toLocaleString()}</td>
                    <td>{current.sessions.toLocaleString()}</td>
                    <td className="trends-audience-change">
                      {comparisonLabel(
                        { ...data, summary: current, previous: row.previous },
                        comparison,
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="trends-chart-footnote">
        Teams reflect membership recorded with the activity. Shared activity appears in each team;
        overall totals count it once. Unassigned activity has no reliable person attribution. Cached
        tokens are included in input tokens.
      </p>
    </section>
  );
}
