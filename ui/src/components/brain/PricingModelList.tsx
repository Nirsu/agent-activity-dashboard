import { useEffect, useRef } from 'react';
import { formatDate } from './presentation';
import {
  formatPrice,
  modelPricingStatus,
  pricingColumns,
  proposalReady,
} from './pricingPresentation';
import type { PricingModel, PricingState, PricingVerification } from './pricingTypes';

export function PricingModelList({
  state,
  models = state.models.filter((entry) => !entry.ignored),
  busy,
  selected,
  onSelect,
  onEdit,
  onCheck,
  onReview,
  onVerify,
  onIgnore,
}: {
  state: PricingState;
  models?: PricingModel[];
  busy: boolean;
  selected: string[];
  onSelect: (models: string[]) => void;
  onEdit: (entry: PricingModel) => void;
  onCheck: (models: string[]) => void;
  onReview: () => void;
  onVerify: (verification: PricingVerification) => void;
  onIgnore: (entry: PricingModel, ignored: boolean) => void;
}) {
  const selectAll = useRef<HTMLInputElement>(null);
  const eligible = models.filter((entry) => entry.sourceUrl).map((entry) => entry.model);
  const allSelected = eligible.length > 0 && eligible.every((model) => selected.includes(model));
  const someSelected = eligible.some((model) => selected.includes(model));
  const running = state.job?.status === 'running';
  useEffect(() => {
    if (selectAll.current) {
      selectAll.current.indeterminate = someSelected && !allSelected;
    }
  }, [someSelected, allSelected]);

  return (
    <table className="brain-pricing-table">
      <caption className="brain-pricing-sr-only">
        Saved model prices in USD per million text tokens
      </caption>
      <thead>
        <tr>
          <th className="brain-pricing-select">
            <input
              ref={selectAll}
              type="checkbox"
              aria-label="Select visible models with a source"
              checked={allSelected}
              disabled={busy || running || !eligible.length}
              onChange={() =>
                onSelect(
                  allSelected
                    ? selected.filter((model) => !eligible.includes(model))
                    : [...new Set([...selected, ...eligible])],
                )
              }
            />
          </th>
          <th scope="col">Model</th>
          {pricingColumns.map((column) => (
            <th scope="col" className="brain-pricing-number" key={column.key}>
              {column.label}
            </th>
          ))}
          <th scope="col">Source & status</th>
          <th scope="col">
            <span className="brain-pricing-sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {models.map((entry) => {
          const version = entry.versions.at(-1);
          const status = modelPricingStatus(entry);
          const proposal = state.job?.proposals.find((item) => item.model === entry.model);
          const needsReview = proposal && proposalReady(proposal, state.models);
          const checking =
            entry.automatic?.status === 'checking' ||
            (running && state.job?.models.includes(entry.model) && !proposal);
          return (
            <tr key={entry.model}>
              <td className="brain-pricing-select">
                <input
                  type="checkbox"
                  aria-label={`Select ${entry.model}`}
                  checked={selected.includes(entry.model)}
                  disabled={busy || running || !entry.sourceUrl}
                  onChange={(event) =>
                    onSelect(
                      event.target.checked
                        ? [...selected, entry.model]
                        : selected.filter((model) => model !== entry.model),
                    )
                  }
                />
              </td>
              <th scope="row" className="brain-pricing-identity">
                <strong>{entry.model}</strong>
                <small>{entry.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</small>
                {entry.detectedAt && <small>Detected from activity</small>}
              </th>
              {pricingColumns.map((column) => (
                <td className="brain-pricing-number" key={column.key}>
                  <span className="brain-pricing-mobile-label">{column.label}</span>
                  <span
                    className={version?.rates?.[column.key] == null ? 'brain-pricing-unset' : ''}
                  >
                    {formatPrice(version?.rates?.[column.key])}
                  </span>
                </td>
              ))}
              <td className="brain-pricing-status-cell">
                <span
                  className={`brain-pricing-badge ${checking || needsReview ? 'review' : status.tone}`}
                >
                  {checking ? 'Checking…' : needsReview ? 'Review ready' : status.label}
                </span>
                {entry.sourceUrl ? (
                  <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
                    Official source ↗
                    <span className="brain-pricing-sr-only"> for {entry.model}</span>
                  </a>
                ) : (
                  <small>Add a link to enable checks</small>
                )}
                {version?.checkedAt && <small>Last check {formatDate(version.checkedAt)}</small>}
                {!version?.rates && entry.automatic?.error && (
                  <small className="brain-pricing-discovery-error">{entry.automatic.error}</small>
                )}
                {version?.evidence && (
                  <button
                    className="brain-pricing-link-button"
                    aria-label={`View verification for ${entry.model}`}
                    onClick={() => onVerify({ model: entry.model, ...version })}
                  >
                    View verification ↗
                  </button>
                )}
              </td>
              <td className="brain-pricing-row-actions">
                {!entry.sourceUrl ? (
                  <button
                    className="brain-button"
                    aria-label={`Add source for ${entry.model}`}
                    disabled={busy}
                    onClick={() => onEdit(entry)}
                  >
                    Add source<span className="brain-pricing-sr-only"> for {entry.model}</span>
                  </button>
                ) : (
                  <>
                    <button
                      className="brain-button"
                      aria-label={`${needsReview ? 'Review prices' : checking ? 'Checking' : 'Check prices'} for ${entry.model}`}
                      disabled={
                        busy ||
                        (state.automation?.checking && !needsReview) ||
                        (running && !needsReview) ||
                        (!state.agent.configured && !needsReview)
                      }
                      onClick={() => (needsReview ? onReview() : onCheck([entry.model]))}
                    >
                      {needsReview ? 'Review prices' : checking ? 'Checking…' : 'Check prices'}
                      <span className="brain-pricing-sr-only"> for {entry.model}</span>
                    </button>
                    <button
                      className="brain-pricing-link-button"
                      disabled={busy}
                      onClick={() => onEdit(entry)}
                    >
                      Edit<span className="brain-pricing-sr-only"> {entry.model}</span>
                    </button>
                  </>
                )}
                <button
                  className="brain-pricing-link-button"
                  disabled={busy}
                  onClick={() => onIgnore(entry, true)}
                >
                  Ignore<span className="brain-pricing-sr-only"> {entry.model}</span>
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
