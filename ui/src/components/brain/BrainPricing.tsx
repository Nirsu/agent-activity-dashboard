import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { usePricing } from './usePricing';
import { brainConfig } from './config';
import { PricingModelForm, type PricingModelInput } from './PricingModelForm';
import { PricingCatalogue } from './PricingCatalogue';
import { PricingProposals } from './PricingProposals';
import { pricingAttentionModels, proposalReady } from './pricingPresentation';
import type { PricingModel, PricingVerification as Verification } from './pricingTypes';

const PricingVerification = lazy(() => import('./PricingVerification'));

export function BrainPricing({ onAdminRequired }: { onAdminRequired: () => void }) {
  const pricing = usePricing(onAdminRequired);
  const [expanded, setExpanded] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [focusReview, setFocusReview] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [editing, setEditing] = useState<PricingModel | 'new' | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingLookup, setPendingLookup] = useState<string[] | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewDetails = useRef<HTMLDetailsElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const restoreEditorFocus = useRef(false);
  const { state, error, loadError, notice, busy } = pricing;
  const tracked = state?.models.filter((entry) => !entry.ignored) ?? [];
  const ignoredCount = state ? state.models.length - tracked.length : 0;
  const jobError = state?.job?.models.some((id) => tracked.some((entry) => entry.model === id))
    ? state.job.error
    : undefined;
  const running = state?.job?.status === 'running' || state?.automation?.checking;
  const selectedModels = selected.filter((id) =>
    tracked.some((entry) => entry.model === id && entry.sourceUrl),
  );
  const ready =
    state?.job?.proposals.filter((proposal) => proposalReady(proposal, state.models)).length ?? 0;
  const missingSources = tracked.filter((entry) => !entry.sourceUrl).length;
  const attentionCount = state ? pricingAttentionModels(state).length - ready : 0;
  const waiting =
    tracked.filter(
      (entry) =>
        !entry.versions.at(-1)?.rates &&
        entry.automatic &&
        ['queued', 'checking'].includes(entry.automatic.status),
    ).length ?? 0;

  useEffect(() => {
    if (expanded && focusReview) {
      if (reviewDetails.current) {
        reviewDetails.current.open = true;
      }
      reviewHeading.current?.focus({ preventScroll: true });
      reviewHeading.current?.scrollIntoView({ block: 'nearest' });
      setFocusReview(false);
    }
  }, [expanded, focusReview]);

  useEffect(() => {
    if (!editing && restoreEditorFocus.current) {
      restoreEditorFocus.current = false;
      const target = editorOpener.current?.isConnected ? editorOpener.current : addButton.current;
      target?.focus({ preventScroll: true });
    }
  }, [editing]);

  function openEditor(entry: PricingModel | 'new') {
    editorOpener.current =
      typeof document === 'undefined' ? null : (document.activeElement as HTMLElement);
    pricing.clearFeedback();
    setEditing(entry);
  }
  function closeEditor() {
    restoreEditorFocus.current = true;
    setEditing(null);
  }
  function showReview() {
    setExpanded(true);
    setFocusReview(true);
  }
  async function runLookup(models: string[]) {
    setPendingLookup(null);
    const started = await pricing.action(
      'lookup',
      { models },
      'Price check started. Review the results below before applying.',
    );
    if (started) {
      setSelected([]);
    }
    return started;
  }
  async function requestLookup(models: string[]) {
    const unapplied = state?.job?.proposals.some((proposal) =>
      proposalReady(proposal, state.models),
    );
    if (unapplied) {
      setPendingLookup(models);
      return false;
    }
    return runLookup(models);
  }
  async function saveModel(input: PricingModelInput, checkPrices: boolean) {
    const saved = await pricing.action(
      'models',
      input,
      input.rates
        ? 'Prices saved. Historical costs are preserved.'
        : 'Model saved. Its source is ready for a price check.',
    );
    if (saved && checkPrices) {
      await requestLookup([input.model]);
    }
    return saved;
  }
  async function ignoreModel(entry: PricingModel, ignored: boolean) {
    const saved = await pricing.action(
      'ignore',
      { model: entry.model, revision: entry.revision, ignored },
      ignored
        ? `${entry.model} ignored. Price checks are disabled; you can restore it below.`
        : `${entry.model} restored to tracked models.`,
    );
    if (saved) {
      setSelected((models) => models.filter((model) => model !== entry.model));
      setPendingLookup(null);
    }
  }

  return (
    <article className="brain-settings-card brain-pricing" aria-labelledby="brain-pricing-title">
      <header className="brain-pricing-header brain-pricing-disclosure-header">
        <div className="brain-pricing-disclosure-title">
          <span className="brain-eyebrow">COST ESTIMATES</span>
          <h2 id="brain-pricing-title">
            <button
              className="brain-pricing-toggle"
              aria-expanded={expanded}
              aria-controls="brain-pricing-content"
              onClick={() => setExpanded(!expanded)}
            >
              Model pricing
              <span className="brain-pricing-toggle-action" aria-hidden="true">
                {expanded ? 'Hide details' : 'Manage prices'}
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
                  <path
                    d="m6 9 6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>
          </h2>
          <p>Automatic discovery and official pricing sources.</p>
        </div>
      </header>
      {state && state.models.length > 0 && (
        <div className="brain-pricing-overview">
          <span>
            {tracked.length} {tracked.length === 1 ? 'model' : 'models'} tracked
          </span>
          {ignoredCount > 0 && <span>{ignoredCount} ignored</span>}
          {ready > 0 && (
            <button className="brain-pricing-badge review" onClick={showReview}>
              {ready} to review
            </button>
          )}
          {attentionCount > 0 && (
            <button
              className="brain-pricing-badge attention"
              onClick={() => {
                setExpanded(true);
                setAttentionOnly(true);
                setSearchQuery('');
              }}
            >
              {attentionCount} {attentionCount === 1 ? 'needs' : 'need'} attention
            </button>
          )}
          {waiting > 0 && state.automation?.enabled && state.agent.configured && (
            <span className="brain-pricing-badge neutral">{waiting} awaiting prices</span>
          )}
          {!ready && !attentionCount && !waiting && !state.automation?.error && !jobError && (
            <span className="brain-pricing-badge checked">No review needed</span>
          )}
          {(state.automation?.error || jobError) && (
            <button className="brain-pricing-badge attention" onClick={() => setExpanded(true)}>
              Check needs attention
            </button>
          )}
        </div>
      )}
      {loadError && (
        <div className="brain-error" role="alert">
          <span>{loadError}</span>
          <button className="brain-button" disabled={busy} onClick={() => void pricing.refresh()}>
            Retry loading
          </button>
        </div>
      )}
      <div id="brain-pricing-content" hidden={!expanded}>
        <div className="brain-pricing-expanded-toolbar">
          <span>USD / 1M text tokens</span>
          <button
            ref={addButton}
            className="brain-button primary"
            disabled={busy || !state || Boolean(editing)}
            onClick={() => openEditor('new')}
          >
            ＋ Add model
          </button>
        </div>
        {error && !editing && (
          <p role="alert" className="brain-pricing-inline-error">
            {error}
          </p>
        )}
        {notice && (
          <p className="brain-pricing-notice" role="status">
            {notice}
          </p>
        )}
        {!state ? (
          <p role="status">{loadError ? 'Pricing is unavailable.' : 'Loading your models…'}</p>
        ) : (
          <>
            {editing && (
              <PricingModelForm
                key={editing === 'new' ? 'new' : editing.model + ':' + editing.revision}
                entry={editing === 'new' ? undefined : editing}
                existingModels={state.models.map((entry) => entry.model)}
                agentConfigured={state.agent.configured && !running}
                error={error}
                busy={busy}
                onSave={saveModel}
                onCancel={closeEditor}
              />
            )}
            {pendingLookup && (
              <div
                className="brain-pricing-replace"
                role="group"
                aria-label="Replace unapplied proposals"
              >
                <div>
                  <strong>Replace the pending proposals?</strong>
                  <p>
                    A new check replaces the previous proposals. Your saved prices stay the same.
                  </p>
                </div>
                <div className="brain-memory-actions">
                  <button
                    className="brain-button"
                    disabled={busy || running}
                    onClick={() => void runLookup(pendingLookup)}
                  >
                    Replace & check
                  </button>
                  <button
                    className="brain-pricing-link-button"
                    onClick={() => setPendingLookup(null)}
                  >
                    Keep proposals
                  </button>
                </div>
              </div>
            )}
            {!state.models.length && !editing && (
              <div className="brain-pricing-empty">
                <h3>Start with the models you use</h3>
                <p>
                  Models appear automatically when they are used. You can also add a model before
                  its first session.
                </p>
                <ol>
                  <li>
                    <span>1</span>Detect a model
                  </li>
                  <li>
                    <span>2</span>Check its official source
                  </li>
                  <li>
                    <span>3</span>Save verified prices
                  </li>
                </ol>
              </div>
            )}
            {state.models.length > 0 && (
              <>
                {tracked.length > 0 && (
                  <div className="brain-pricing-list-toolbar">
                    <span>
                      {selectedModels.length
                        ? selectedModels.length + ' selected'
                        : missingSources === tracked.length
                          ? 'Add a source link to check prices with the agent'
                          : 'Select models to check them together'}
                    </span>
                    {selectedModels.length > 0 && (
                      <div className="brain-memory-actions">
                        <button
                          className="brain-pricing-link-button"
                          disabled={busy || running}
                          onClick={() => setSelected([])}
                        >
                          Clear selection
                        </button>
                        <button
                          className="brain-button primary"
                          disabled={busy || running || !state.agent.configured || Boolean(editing)}
                          onClick={() => void requestLookup(selectedModels)}
                        >
                          Check selected ({selectedModels.length})
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <PricingCatalogue
                  query={searchQuery}
                  onQuery={setSearchQuery}
                  attentionOnly={attentionOnly}
                  onAttentionOnly={setAttentionOnly}
                  state={state}
                  busy={busy || Boolean(editing)}
                  selected={selectedModels}
                  onSelect={setSelected}
                  onEdit={openEditor}
                  onCheck={(models) => void requestLookup(models)}
                  onReview={showReview}
                  onVerify={setVerification}
                  onIgnore={(entry, ignored) => void ignoreModel(entry, ignored)}
                />
              </>
            )}
            <div className="brain-pricing-agent">
              <span
                className={'brain-pricing-dot' + (state.agent.configured ? ' is-ready' : '')}
                aria-hidden="true"
              />
              <p>
                {state.agent.configured ? (
                  <>
                    <strong>Pricing agent connected</strong>
                    <span>
                      {state.agent.model} ·{' '}
                      {state.automation?.enabled
                        ? 'Missing prices are checked automatically.'
                        : 'Runs only when you ask.'}{' '}
                      API usage charges apply.
                    </span>
                  </>
                ) : (
                  <>
                    <strong>Pricing agent is not configured</strong>
                    <span>You can still save models and enter prices manually.</span>
                  </>
                )}
              </p>
            </div>
            {state.automation?.enabled && (
              <div className="brain-pricing-automatic">
                <p>
                  New models are detected from activity and history. Their first verified prices are
                  saved automatically. Changes to existing prices require your review.
                </p>
                <p>
                  Official pricing sources:{' '}
                  <a
                    href={brainConfig.pricing.officialSources.openai}
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenAI ↗
                  </a>{' '}
                  ·{' '}
                  <a
                    href={brainConfig.pricing.officialSources.anthropic}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Anthropic ↗
                  </a>
                </p>
                {!state.agent.configured && (
                  <p>Detected models stay queued until the pricing agent is connected.</p>
                )}
                {state.automation.error && <p role="alert">{state.automation.error}</p>}
              </div>
            )}
            {!state.agent.configured && (
              <details className="brain-pricing-scope">
                <summary>Connect the pricing agent</summary>
                <p>
                  An administrator can set BRAIN_MODEL and OPENAI_API_KEY on the server, then
                  restart the dashboard.
                </p>
              </details>
            )}
            <PricingProposals
              state={state}
              busy={busy || Boolean(editing)}
              headingRef={reviewHeading}
              detailsRef={reviewDetails}
              onVerify={setVerification}
              onApply={(model) =>
                void pricing.action(
                  'apply',
                  { jobId: state.job!.id, model },
                  'Prices applied for ' + model + '. Historical costs are preserved.',
                )
              }
              onRetry={(models) => void requestLookup(models)}
            />
            <details className="brain-pricing-scope">
              <summary>What these estimates include</summary>
              <p>
                Standard, short-context text usage at API rates. Long-context, fast, regional and
                cache-write charges are not included. These estimates do not represent subscription
                billing.
              </p>
              <p>
                Prices and their sources stay in your database across restarts. New rates apply to
                future usage; historical costs are preserved. A missing price stays unknown.
              </p>
            </details>
          </>
        )}
      </div>
      {verification && (
        <Suspense fallback={<p role="status">Opening verification…</p>}>
          <PricingVerification verification={verification} onClose={() => setVerification(null)} />
        </Suspense>
      )}
    </article>
  );
}
