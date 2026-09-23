import { useEffect, useRef, useState } from 'react';
import { brainConfig } from './config';
import type { PricingModel, Rates } from './pricingTypes';

export type PricingModelInput = {
  model: string;
  provider: 'openai' | 'anthropic';
  sourceUrl: string;
  revision: number;
  rates?: Rates;
};
const providerPages = {
  openai: 'https://developers.openai.com/api/docs/pricing',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
};

export function PricingModelForm({
  entry,
  busy,
  error,
  agentConfigured = false,
  existingModels = [],
  onSave,
  onCancel,
}: {
  entry?: PricingModel;
  busy: boolean;
  error?: string;
  agentConfigured?: boolean;
  existingModels?: string[];
  onSave: (input: PricingModelInput, checkPrices: boolean) => Promise<boolean>;
  onCancel: () => void;
}) {
  const current = entry?.versions.at(-1)?.rates;
  const [model, setModel] = useState(entry?.model ?? '');
  const [provider, setProvider] = useState(entry?.provider ?? 'openai');
  const [sourceUrl, setSourceUrl] = useState(entry?.sourceUrl ?? '');
  const [manual, setManual] = useState(false);
  const [inputPrice, setInputPrice] = useState(current?.inputPerMillionUsd.toString() ?? '');
  const [outputPrice, setOutputPrice] = useState(current?.outputPerMillionUsd.toString() ?? '');
  const [cachePrice, setCachePrice] = useState(current?.cachedInputPerMillionUsd?.toString() ?? '');
  const [modelError, setModelError] = useState('');
  const modelField = useRef<HTMLInputElement>(null);
  const sourceField = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const field = entry ? sourceField.current : modelField.current;
    field?.focus({ preventScroll: true });
    form.current?.scrollIntoView({ block: 'nearest' });
  }, [entry]);
  useEffect(() => {
    if (error) {
      feedback.current?.focus();
    }
  }, [error]);

  return (
    <form
      ref={form}
      className="brain-pricing-form"
      aria-labelledby="pricing-form-title"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!entry && existingModels.includes(model.trim())) {
          setModelError('This model is already in your list. Edit its existing entry.');
          modelField.current?.focus();
          return;
        }
        setModelError('');
        const submitter = (event.nativeEvent as SubmitEvent | undefined)
          ?.submitter as HTMLButtonElement | null;
        const checkPrices = agentConfigured && !manual && submitter?.value !== 'save-only';
        const saved = await onSave(
          {
            model: model.trim(),
            provider,
            sourceUrl: sourceUrl.trim(),
            revision: entry?.revision ?? 0,
            ...(manual
              ? {
                  rates: {
                    inputPerMillionUsd: Number(inputPrice),
                    outputPerMillionUsd: Number(outputPrice),
                    ...(cachePrice !== '' ? { cachedInputPerMillionUsd: Number(cachePrice) } : {}),
                  },
                }
              : {}),
          },
          checkPrices,
        );
        if (saved) {
          onCancel();
        }
      }}
    >
      <div className="brain-pricing-form-heading">
        <div>
          <span className="brain-eyebrow">{entry ? 'MODEL SETTINGS' : 'NEW MODEL'}</span>
          <h3 id="pricing-form-title">{entry ? entry.model : 'Add a model to your list'}</h3>
        </div>
      </div>
      <p>Choose the model and the official page the agent should read.</p>
      {error && (
        <p ref={feedback} tabIndex={-1} role="alert" className="brain-pricing-inline-error">
          {error}
        </p>
      )}
      <fieldset disabled={busy}>
        <div className="brain-pricing-fields">
          <label>
            Model ID
            <input
              ref={modelField}
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9._:\/\-]*"
              readOnly={Boolean(entry)}
              value={model}
              maxLength={brainConfig.pricing.maxModelCharacters}
              aria-invalid={Boolean(modelError)}
              aria-describedby={modelError ? 'pricing-model-error' : 'pricing-model-hint'}
              onChange={(event) => {
                setModel(event.target.value);
                setModelError('');
              }}
              placeholder="e.g. the model ID shown in your agent"
            />
            <small id="pricing-model-hint">Use the exact ID reported in your usage.</small>
            {modelError && (
              <small id="pricing-model-error" className="brain-pricing-field-error" role="alert">
                {modelError}
              </small>
            )}
          </label>
          <label>
            Provider
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as 'openai' | 'anthropic')}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="brain-pricing-source">
            Official pricing link
            <input
              ref={sourceField}
              type="url"
              required
              value={sourceUrl}
              maxLength={brainConfig.pricing.maxUrlCharacters}
              aria-describedby="pricing-source-hint"
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="Paste a model announcement or pricing page URL"
            />
            <small id="pricing-source-hint">
              The page must list prices on {provider === 'openai' ? 'OpenAI’s' : 'Anthropic’s'}{' '}
              official website.
            </small>
          </label>
          <button
            className="brain-pricing-link-button"
            type="button"
            onClick={() => {
              setSourceUrl(providerPages[provider]);
              sourceField.current?.focus();
            }}
          >
            Use {provider === 'openai' ? 'OpenAI' : 'Anthropic'} pricing page
          </button>
        </div>
        <label className="brain-pricing-checkbox">
          <input
            type="checkbox"
            checked={manual}
            onChange={(event) => setManual(event.target.checked)}
          />{' '}
          Enter prices manually instead
        </label>
        {manual && (
          <div className="brain-pricing-manual">
            <p>
              USD per million text tokens. Saved manual prices apply to future usage immediately.
            </p>
            <div className="brain-pricing-fields">
              <label>
                Input
                <input
                  type="number"
                  min="0"
                  step="any"
                  required
                  value={inputPrice}
                  onChange={(event) => setInputPrice(event.target.value)}
                />
              </label>
              <label>
                Output
                <input
                  type="number"
                  min="0"
                  step="any"
                  required
                  value={outputPrice}
                  onChange={(event) => setOutputPrice(event.target.value)}
                />
              </label>
              <label>
                Cached input · optional
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={cachePrice}
                  onChange={(event) => setCachePrice(event.target.value)}
                  placeholder="Leave blank if unknown"
                />
              </label>
            </div>
          </div>
        )}
        <footer className="brain-pricing-form-footer">
          <p>
            {manual
              ? 'Historical costs will stay the same.'
              : agentConfigured
                ? 'The agent proposes prices. You review them before applying. API usage charges apply.'
                : 'Save now and check prices once the agent is connected.'}
          </p>
          <div className="brain-memory-actions">
            <button className="brain-button primary" type="submit" value="save-and-check">
              {busy
                ? 'Saving…'
                : manual
                  ? 'Save prices'
                  : agentConfigured
                    ? 'Save & check prices'
                    : 'Save model'}
            </button>
            {!manual && agentConfigured && (
              <button className="brain-button" type="submit" value="save-only">
                Save only
              </button>
            )}
            <button className="brain-pricing-link-button" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </footer>
      </fieldset>
    </form>
  );
}
