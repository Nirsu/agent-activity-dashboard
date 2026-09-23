import type { ComponentProps } from 'react';
import { PricingModelList } from './PricingModelList';
import { pricingAttentionModels } from './pricingPresentation';

export function PricingCatalogue({
  attentionOnly,
  onAttentionOnly,
  query,
  onQuery,
  ...props
}: ComponentProps<typeof PricingModelList> & {
  attentionOnly: boolean;
  onAttentionOnly: (value: boolean) => void;
  query: string;
  onQuery: (value: string) => void;
}) {
  const attention = pricingAttentionModels(props.state);
  const tracked = props.state.models.filter((entry) => !entry.ignored);
  const ignored = props.state.models.filter((entry) => entry.ignored);
  const models = tracked.filter(
    (entry) =>
      (!attentionOnly || attention.includes(entry.model)) &&
      `${entry.model} ${entry.provider}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="brain-pricing-filters">
        <label>
          <span>Find a model</span>
          <input
            type="search"
            placeholder="Model name or provider…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <button
          className="brain-button"
          aria-pressed={attentionOnly}
          onClick={() => onAttentionOnly(!attentionOnly)}
        >
          Needs attention ({attention.length})
        </button>
        <span className="brain-pricing-filter-count">
          {models.length} of {tracked.length} models
        </span>
      </div>
      {models.length ? (
        <PricingModelList {...props} models={models} />
      ) : (
        <div className="brain-pricing-empty-results">
          <p>
            {!tracked.length
              ? 'All saved models are ignored. Restore one below or add a model.'
              : attentionOnly && !query
                ? 'No models need attention.'
                : 'No models match these filters.'}
          </p>
          <button
            className="brain-pricing-link-button"
            onClick={() => {
              onQuery('');
              onAttentionOnly(false);
            }}
          >
            Show all models
          </button>
        </div>
      )}
      {ignored.length > 0 && (
        <details className="brain-pricing-ignored">
          <summary>Ignored models ({ignored.length})</summary>
          <p>
            These models are excluded from price checks and review alerts, even when new activity is
            detected. Saved prices and historical usage are preserved.
          </p>
          <ul>
            {ignored.map((entry) => (
              <li key={entry.model}>
                <div>
                  <strong>{entry.model}</strong>
                  <small>{entry.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</small>
                </div>
                <button
                  className="brain-button"
                  disabled={props.busy}
                  onClick={() => props.onIgnore(entry, false)}
                >
                  Restore<span className="brain-pricing-sr-only"> {entry.model}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
