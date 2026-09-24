import type { TrendsAudienceOptions } from '../../../../server/src/trends/types';
import type { TrendsSelection } from './useTrends';

export function AudienceFilters({
  selection,
  options,
  onChange,
}: {
  selection: TrendsSelection;
  options: TrendsAudienceOptions;
  onChange: (selection: TrendsSelection) => void;
}) {
  const people = options.people.filter(
    (person) => !selection.team || person.teamIds.includes(selection.team),
  );
  const team = options.teams.find((item) => item.id === selection.team);
  const person = options.people.find((item) => item.id === selection.person);
  return (
    <section className="trends-audience-filters" aria-label="Filter activity">
      <label>
        Team
        <select
          aria-label="Team"
          value={selection.team ?? ''}
          onChange={(event) =>
            onChange({ ...selection, team: event.target.value || undefined, person: undefined })
          }
        >
          <option value="">All teams</option>
          {selection.team && !team && (
            <option value={selection.team}>Selected team · no activity</option>
          )}
          {options.teams.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Person
        <select
          aria-label="Person"
          value={selection.person ?? ''}
          onChange={(event) => onChange({ ...selection, person: event.target.value || undefined })}
        >
          <option value="">All people</option>
          {selection.person && !people.some((item) => item.id === selection.person) && (
            <option value={selection.person}>
              {person?.name ?? 'Selected person'} · no activity
            </option>
          )}
          {people.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <div className="trends-audience-scope" role="status">
        <strong>
          {person?.name ??
            team?.name ??
            (selection.person || selection.team ? 'Selected activity' : 'Everyone')}
        </strong>
        <span>
          {selection.person || selection.team
            ? 'All figures follow these filters.'
            : 'Explore a team or person to see their usage.'}
        </span>
      </div>
      {(selection.team || selection.person) && (
        <button
          className="dashboard-button"
          type="button"
          onClick={() => onChange({ ...selection, team: undefined, person: undefined })}
        >
          Clear filters
        </button>
      )}
    </section>
  );
}
