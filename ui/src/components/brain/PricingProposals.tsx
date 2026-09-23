import type { RefObject } from 'react';
import { formatDate } from './presentation';
import {
  comparisonRates,
  formatPrice,
  priceChange,
  pricingColumns,
  proposalReady,
} from './pricingPresentation';
import type { PricingState, PricingVerification } from './pricingTypes';

export function PricingProposals({
  state,
  busy,
  headingRef,
  detailsRef,
  onApply,
  onRetry,
  onVerify,
}: {
  state: PricingState;
  busy: boolean;
  headingRef: RefObject<HTMLHeadingElement>;
  detailsRef?: RefObject<HTMLDetailsElement>;
  onApply: (model: string) => void;
  onRetry: (models: string[]) => void;
  onVerify: (verification: PricingVerification) => void;
}) {
  const job = state.job;
  const tracked = new Set(
    state.models.filter((entry) => !entry.ignored).map((entry) => entry.model),
  );
  const models = job?.models.filter((model) => tracked.has(model)) ?? [];
  if (!job || !models.length) {
    return null;
  }
  const running = job.status === 'running';
  const proposals = job.proposals.filter((proposal) => models.includes(proposal.model));
  const ready = proposals.filter((proposal) => proposalReady(proposal, state.models)).length;
  const failures = proposals.filter((proposal) => proposal.error).length;
  return (
    <details
      className="brain-pricing-review-disclosure"
      ref={detailsRef}
      open={
        running ||
        ready > 0 ||
        failures > 0 ||
        job.status === 'interrupted' ||
        job.status === 'failed'
          ? true
          : undefined
      }
    >
      <summary>
        {running
          ? 'Price check in progress'
          : ready
            ? `${ready} ${ready === 1 ? 'proposal' : 'proposals'} to review`
            : failures || job.status === 'interrupted' || job.status === 'failed'
              ? 'Price check needs attention'
              : 'Latest price check · completed'}
      </summary>
      <section className="brain-pricing-proposals" aria-labelledby="pricing-proposals-title">
        <header className="brain-pricing-review-heading">
          <div>
            <span className="brain-eyebrow">AGENT REVIEW</span>
            <h3 id="pricing-proposals-title" ref={headingRef} tabIndex={-1}>
              {running
                ? 'Checking official sources'
                : ready
                  ? `${ready} ${ready === 1 ? 'proposal' : 'proposals'} to review`
                  : 'Latest price check'}
            </h3>
          </div>
          <span className="brain-pricing-badge neutral">
            {proposals.length} / {models.length} checked
          </span>
        </header>
        <p role="status" className="brain-pricing-review-summary">
          {running
            ? 'You can leave this page. The check continues in the background.'
            : `${ready} ready to review${failures ? ` · ${failures} ${failures === 1 ? 'check needs' : 'checks need'} attention` : ''}. Saved prices change only when you apply a proposal.`}
        </p>
        {running && (
          <progress aria-label="Models checked" max={models.length} value={proposals.length} />
        )}
        {(job.error || job.status === 'interrupted') && (
          <p role="alert" className="brain-pricing-inline-error">
            {job.error || 'This check was interrupted. Run it again to check the remaining models.'}
          </p>
        )}
        {proposals.map((proposal) => {
          const entry = state.models.find((entry) => entry.model === proposal.model);
          const stale = entry?.revision !== proposal.revision;
          const current = comparisonRates(proposal, entry);
          const unchanged = pricingColumns.every(
            ({ key }) => current?.[key] === proposal.rates?.[key],
          );
          return (
            <article
              key={proposal.model}
              className={`brain-pricing-proposal${proposal.appliedAt ? ' is-applied' : ''}`}
            >
              <div className="brain-pricing-proposal-heading">
                <h4>{proposal.model}</h4>
                <span
                  className={`brain-pricing-badge ${proposal.error ? 'attention' : proposal.appliedAt ? 'checked' : stale ? 'attention' : 'review'}`}
                >
                  {proposal.error
                    ? 'Check failed'
                    : proposal.appliedAt
                      ? 'Applied'
                      : stale
                        ? 'Out of date'
                        : unchanged
                          ? 'Prices unchanged'
                          : 'Proposed update'}
                </span>
              </div>
              {proposal.error ? (
                <p className="brain-pricing-inline-error">{proposal.error}</p>
              ) : (
                <>
                  <table className="brain-pricing-comparison">
                    <caption className="brain-pricing-sr-only">
                      Price comparison for {proposal.model}, USD per million tokens
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Token type</th>
                        <th scope="col">{proposal.appliedAt ? 'Previous' : 'Current'}</th>
                        <th scope="col">{proposal.appliedAt ? 'Applied' : 'Proposed'}</th>
                        <th scope="col">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pricingColumns.map(({ key, label }) => (
                        <tr key={key}>
                          <th scope="row">{label}</th>
                          <td>{formatPrice(current?.[key])}</td>
                          <td
                            className={
                              current?.[key] !== proposal.rates?.[key]
                                ? 'brain-pricing-changed'
                                : ''
                            }
                          >
                            {formatPrice(proposal.rates?.[key])}
                          </td>
                          <td>{priceChange(current?.[key], proposal.rates?.[key])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {proposal.notes && (
                    <p className="brain-pricing-proposal-notes">{proposal.notes}</p>
                  )}
                  <button
                    className="brain-pricing-link-button"
                    onClick={() => onVerify({ ...proposal, proposed: !proposal.appliedAt })}
                  >
                    Read source evidence ↗
                  </button>
                </>
              )}
              <footer className="brain-pricing-proposal-footer">
                {proposal.appliedAt ? (
                  <p role="status">
                    Applied {formatDate(proposal.appliedAt)}. Historical costs are preserved.
                  </p>
                ) : proposal.error || stale ? (
                  <>
                    <span>
                      {stale && !proposal.error
                        ? 'The model was edited after this check. Check again before applying.'
                        : 'Saved prices are unchanged.'}
                    </span>
                    <button
                      className="brain-button"
                      disabled={busy || running || !entry?.sourceUrl || !state.agent.configured}
                      onClick={() => onRetry([proposal.model])}
                    >
                      Check again
                    </button>
                  </>
                ) : (
                  <>
                    <span>
                      {unchanged
                        ? 'Confirm to record this source check.'
                        : 'Applies to future usage. Historical costs stay the same.'}
                    </span>
                    <button
                      className="brain-button primary"
                      disabled={busy}
                      onClick={() => onApply(proposal.model)}
                    >
                      {unchanged ? 'Confirm prices' : 'Apply prices'}
                    </button>
                  </>
                )}
              </footer>
              {proposal.usage && (
                <details className="brain-pricing-usage">
                  <summary>Agent usage</summary>
                  <p>
                    {proposal.usage.usageKnown
                      ? `${proposal.usage.inputTokens.toLocaleString()} input / ${proposal.usage.outputTokens.toLocaleString()} output tokens`
                      : 'Usage is unavailable for this check.'}
                  </p>
                </details>
              )}
            </article>
          );
        })}
      </section>
    </details>
  );
}
