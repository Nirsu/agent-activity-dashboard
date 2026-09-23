import { brainConfig } from '../config.js';
import type { PricingCatalogue, PricingModel, PricingProposal, PricingProvider } from './types.js';

export type ModelObservation = { model?: string; provider?: string };
type Backend = {
  catalogue: () => PricingCatalogue;
  change: (work: (catalogue: PricingCatalogue) => void) => Promise<unknown>;
  lookup: (entry: PricingModel) => Promise<PricingProposal>;
  available: () => boolean;
};

function observation(input: ModelObservation) {
  const model = input.model?.trim();
  if (
    !model ||
    model.length > brainConfig.pricing.maxModelCharacters ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)
  ) {
    return;
  }
  const provider: PricingProvider | undefined =
    model.startsWith('claude-') || input.provider === 'claude' || input.provider === 'anthropic'
      ? 'anthropic'
      : input.provider === 'codex' ||
          input.provider === 'brain' ||
          input.provider === 'openai' ||
          /^(gpt-|chatgpt-|o\d)/.test(model)
        ? 'openai'
        : undefined;
  if (provider) {
    return { model, provider };
  }
}

/** One persistent queue for first prices; manual proposals are never replaced. */
export class PricingDiscovery {
  private pending = new Map<string, { model: string; provider: PricingProvider }>();
  private seen = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private worker?: Promise<void>;
  private stopped = false;
  private error?: string;
  private storageError?: string;
  private interruptedModel?: string;

  get checking() {
    return Boolean(this.interruptedModel);
  }

  constructor(
    private readonly backend: Backend,
    readonly enabled: boolean,
    private readonly intervalMs = brainConfig.pricing.automaticIntervalMs,
  ) {}

  observe(inputs: ModelObservation[]) {
    if (this.stopped) {
      return;
    }
    for (const input of inputs) {
      const entry = observation(input);
      if (!entry || this.seen.has(entry.model) || this.pending.has(entry.model)) {
        continue;
      }
      if (this.pending.size >= brainConfig.pricing.maxModels) {
        this.error = 'Too many new models are waiting for discovery.';
        break;
      }
      this.pending.set(entry.model, entry);
    }
  }

  state() {
    return {
      enabled: this.enabled,
      checking: this.checking,
      error: this.storageError ?? this.error,
    };
  }

  start() {
    if (this.timer || this.stopped) {
      return;
    }
    this.timer = setInterval(() => this.schedule(), this.intervalMs);
    this.timer.unref();
    this.schedule();
  }

  private schedule() {
    if (this.worker || this.stopped) {
      return;
    }
    this.worker = this.run()
      .catch(() => {
        this.storageError =
          'Automatic pricing could not be saved. It will retry after the storage connection recovers.';
      })
      .finally(() => {
        this.worker = undefined;
      });
  }

  private async run() {
    // A failed storage write must not leave a model stuck in Checking forever.
    if (this.interruptedModel) {
      await this.backend.change((catalogue) => {
        const current = catalogue.models.find((entry) => entry.model === this.interruptedModel);
        if (!current?.ignored && current?.automatic?.status === 'checking') {
          current.automatic.status =
            current.automatic.attempts < brainConfig.pricing.automaticMaxAttempts
              ? 'queued'
              : 'failed';
          current.automatic.retryAt = Date.now() + brainConfig.pricing.automaticRetryDelayMs;
          current.automatic.error =
            'The automatic check was interrupted. Retry scheduled when possible.';
        }
      });
      this.interruptedModel = undefined;
      this.storageError = undefined;
    }
    if (this.pending.size) {
      const pending = [...this.pending.values()];
      await this.backend.change((catalogue) => {
        for (const observed of pending) {
          let entry = catalogue.models.find((entry) => entry.model === observed.model);
          if (!entry) {
            if (catalogue.models.length >= brainConfig.pricing.maxModels) {
              this.error =
                'The model catalogue is full. Increase the configured model limit to discover more models.';
              continue;
            }
            entry = {
              ...observed,
              sourceUrl: brainConfig.pricing.officialSources[observed.provider],
              revision: 1,
              versions: [],
            };
            catalogue.models.push(entry);
          }
          entry.detectedAt ??= new Date().toISOString();
          if (!entry.ignored && !entry.versions.at(-1)?.rates && !entry.automatic) {
            entry.automatic = { status: 'queued', attempts: 0 };
          }
        }
      });
      this.storageError = undefined;
      for (const entry of pending) {
        this.pending.delete(entry.model);
        if (this.backend.catalogue().models.some((model) => model.model === entry.model)) {
          this.seen.add(entry.model);
        }
      }
    }
    if (this.stopped || !this.enabled || !this.backend.available()) {
      return;
    }
    const catalogue = this.backend.catalogue();
    const entry = catalogue.models.find(
      (entry) =>
        !entry.ignored &&
        !entry.versions.at(-1)?.rates &&
        entry.automatic?.status === 'queued' &&
        entry.automatic.attempts < brainConfig.pricing.automaticMaxAttempts &&
        (entry.automatic.retryAt ?? 0) <= Date.now() &&
        !catalogue.job?.proposals.some(
          (proposal) =>
            proposal.model === entry.model &&
            proposal.revision === entry.revision &&
            proposal.rates &&
            !proposal.error &&
            !proposal.appliedAt,
        ),
    );
    if (!entry) {
      return;
    }
    // Automatic discovery always uses the two configured provider pricing pages.
    const selected = { ...entry, sourceUrl: brainConfig.pricing.officialSources[entry.provider] };
    this.interruptedModel = selected.model;
    let claimed = false;
    await this.backend.change((catalogue) => {
      const current = catalogue.models.find((model) => model.model === entry.model)!;
      if (
        current.ignored ||
        current.revision !== selected.revision ||
        current.versions.at(-1)?.rates
      ) {
        return;
      }
      current.automatic = { status: 'checking', attempts: (current.automatic?.attempts ?? 0) + 1 };
      claimed = true;
    });
    if (!claimed) {
      this.interruptedModel = undefined;
      return;
    }
    const proposal = await this.backend.lookup(selected);
    if (this.stopped) {
      return;
    }
    await this.backend.change((catalogue) => {
      const current = catalogue.models.find((model) => model.model === selected.model)!;
      if (
        current.ignored ||
        (current.revision !== selected.revision && current.automatic?.status !== 'checking')
      ) {
        return;
      }
      const attempts = current.automatic?.attempts ?? 1;
      if (current.revision !== selected.revision || current.versions.at(-1)?.rates) {
        current.automatic = {
          status: 'failed',
          attempts,
          error:
            'The model changed during the automatic check. Use Check prices to review its current settings.',
        };
        return;
      }
      if (proposal.error || !proposal.rates) {
        const retry = proposal.retryable && attempts < brainConfig.pricing.automaticMaxAttempts;
        current.automatic = {
          status: retry ? 'queued' : 'failed',
          attempts,
          error: proposal.error ?? 'No verified prices were found.',
          ...(retry ? { retryAt: Date.now() + brainConfig.pricing.automaticRetryDelayMs } : {}),
        };
        return;
      }
      current.revision++;
      current.sourceUrl = proposal.sourceUrl;
      current.versions.push({
        at: Date.now(),
        rates: proposal.rates,
        sourceUrl: proposal.sourceUrl,
        origin: 'agent',
        checkedAt: proposal.checkedAt,
        evidence: proposal.evidence,
        notes: proposal.notes,
      });
      current.automatic = { status: 'applied', attempts };
    });
    this.interruptedModel = undefined;
  }

  async close() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.worker;
    // Persist any observations received immediately before shutdown without calling the agent.
    if (this.pending.size) {
      await this.run();
    }
  }
}
