import { randomUUID } from 'node:crypto';
import { brainConfig } from '../config.js';
import { fail, requireObject, requireText } from '../analysis/validation.js';
import { OpenAIClient } from '../analysis/openai.js';
import type { ModelResult } from '../analysis/types.js';
import type { BrainStorage } from '../persistence.js';
import { usePricingCatalogue, type ModelPrice } from '../../model-cost.js';
import { fetchPricingSource, pricingUrl } from './source.js';
import { pricingPrompt, pricingSchema, validateProposal, validateRates } from './agent.js';
import { PricingDiscovery, type ModelObservation } from './discovery.js';
import type { PricingCatalogue, PricingModel, PricingProposal, PricingProvider } from './types.js';
const catalogueKey = 'model-pricing-v1';
type Options = {
  automatic?: boolean;
  automaticIntervalMs?: number;
  model?: string;
  apiKey?: string;
  fetchSource?: typeof fetchPricingSource;
  call?: (input: unknown) => Promise<ModelResult>;
  onUsage?: (jobId: string, model: string, result: ModelResult) => Promise<void>;
};
export class PricingService {
  private readonly model: string;
  private readonly client: OpenAIClient;
  private readonly configured: boolean;
  private readonly shutdown = new AbortController();
  private readonly discovery: PricingDiscovery;
  private worker?: Promise<void>;
  private releaseCatalogue?: () => void;
  constructor(
    private readonly storage: BrainStorage,
    private readonly options: Options = {},
  ) {
    this.model = options.model ?? process.env.BRAIN_MODEL ?? '';
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.configured = Boolean(options.call || (this.model && apiKey));
    this.client = new OpenAIClient({
      model: this.model,
      apiKey,
      requestTimeoutMs: brainConfig.pricing.agentTimeoutMs,
    });
    this.discovery = new PricingDiscovery(
      {
        catalogue: () => this.catalogue(),
        change: (work) => this.change(work),
        lookup: (entry) => this.lookup(randomUUID(), entry),
        available: () =>
          this.configured &&
          !this.worker &&
          this.catalogue().job?.status !== 'running' &&
          !this.shutdown.signal.aborted,
      },
      options.automatic ?? process.env.BRAIN_PRICING_AUTOMATIC !== '0',
      options.automaticIntervalMs,
    );
  }
  async init() {
    await this.storage.transaction(async () => {
      let catalogue = this.storage.get<PricingCatalogue>('access_settings', catalogueKey);
      if (!catalogue) {
        catalogue = { models: [] };
        let environment: Record<string, unknown> = {};
        try {
          environment = requireObject(JSON.parse(process.env.MODEL_PRICING_JSON ?? '{}'));
        } catch {
          // Invalid legacy configuration never invents prices.
        }
        for (const [model, value] of Object.entries(environment)) {
          try {
            const rates = validateRates(value);
            catalogue.models.push({
              model,
              provider: model.startsWith('claude') ? 'anthropic' : 'openai',
              sourceUrl: '',
              revision: 1,
              versions: [{ at: 0, rates, sourceUrl: '', origin: 'environment' }],
            });
          } catch {
            // Keep valid legacy rates while leaving unsupported entries unknown.
          }
        }
      }
      if (catalogue.job?.status === 'running') {
        catalogue.job.status = 'interrupted';
        catalogue.job.error =
          'The server restarted during this lookup. Start a new lookup to retry.';
      }
      for (const entry of catalogue.models) {
        if (entry.ignored) {
          delete entry.automatic;
          continue;
        }
        if (entry.automatic?.status === 'checking') {
          entry.automatic.status =
            entry.automatic.attempts < brainConfig.pricing.automaticMaxAttempts
              ? 'queued'
              : 'failed';
          entry.automatic.error = 'The server restarted during this check.';
        }
      }
      await this.storage.put('access_settings', catalogueKey, catalogue);
    });
    this.releaseCatalogue = usePricingCatalogue((model, at) => this.price(model, at));
  }
  private catalogue(): PricingCatalogue {
    return this.storage.get<PricingCatalogue>('access_settings', catalogueKey) ?? { models: [] };
  }
  state() {
    return {
      ...this.catalogue(),
      agent: { configured: this.configured, model: this.model },
      automation: this.discovery.state(),
    };
  }
  observeModels(models: ModelObservation[]) {
    this.discovery.observe(models);
  }
  startAutomatic() {
    this.discovery.start();
  }
  price(model: string, at: number): ModelPrice | undefined {
    const entry = this.catalogue().models.find((entry) => entry.model === model);
    return (
      entry?.versions
        .slice()
        .reverse()
        .find((version) => version.at <= at)?.rates ?? undefined
    );
  }
  private async change(work: (catalogue: PricingCatalogue) => void) {
    await this.storage.transaction(async () => {
      const catalogue = this.catalogue();
      work(catalogue);
      await this.storage.put('access_settings', catalogueKey, catalogue);
    });
    return this.state();
  }
  async save(raw: unknown) {
    const input = requireObject(raw);
    const model = requireText(input.model, brainConfig.pricing.maxModelCharacters).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) {
      fail('Use the exact model ID reported by your provider.');
    }
    if (input.provider !== 'openai' && input.provider !== 'anthropic') {
      fail('Select a supported provider.');
    }
    const provider: PricingProvider = input.provider;
    const sourceUrl = pricingUrl(
      requireText(input.sourceUrl, brainConfig.pricing.maxUrlCharacters),
      provider,
    );
    const rates = input.rates === undefined ? undefined : validateRates(input.rates);
    return this.change((catalogue) => {
      let entry = catalogue.models.find((item) => item.model === model);
      if (entry && input.revision !== entry.revision) {
        fail('This model changed. Refresh before saving.', 409);
      }
      if (entry?.ignored) {
        fail('Restore this model before editing its prices.', 409);
      }
      if (!entry) {
        if (input.revision !== 0) {
          fail('This model no longer exists. Refresh before saving.', 409);
        }
        if (catalogue.models.length >= brainConfig.pricing.maxModels) {
          fail('The model catalogue is full.');
        }
        entry = { model, provider, sourceUrl, revision: 0, versions: [] };
        catalogue.models.push(entry);
      }
      entry.provider = provider;
      entry.sourceUrl = sourceUrl;
      entry.revision++;
      if (rates) {
        entry.versions.push({ at: Date.now(), rates, sourceUrl, origin: 'manual' });
      }
    });
  }
  async setIgnored(raw: unknown) {
    const input = requireObject(raw);
    const model = requireText(input.model, brainConfig.pricing.maxModelCharacters).trim();
    if (typeof input.ignored !== 'boolean') {
      fail('Choose whether to ignore or restore the model.');
    }
    const ignored = input.ignored;
    return this.change((catalogue) => {
      const entry = catalogue.models.find((item) => item.model === model);
      if (!entry || entry.revision !== input.revision) {
        fail('This model changed. Refresh before updating it.', 409);
      }
      if (Boolean(entry.ignored) === ignored) {
        return;
      }
      entry.ignored = ignored;
      entry.revision++;
      delete entry.automatic;
      if (ignored && catalogue.job) {
        // Retain price versions and usage accounting, but discard this model's latest review.
        catalogue.job.models = catalogue.job.models.filter((id) => id !== model);
        catalogue.job.proposals = catalogue.job.proposals.filter((item) => item.model !== model);
      }
      if (!ignored && !entry.versions.at(-1)?.rates) {
        entry.automatic = { status: 'queued', attempts: 0 };
      }
    });
  }
  async start(models: string[]) {
    if (!this.configured) {
      fail('Configure BRAIN_MODEL and OPENAI_API_KEY on the server to use the pricing agent.', 503);
    }
    if (this.shutdown.signal.aborted) {
      fail('The server is stopping.', 503);
    }
    if (
      !Array.isArray(models) ||
      !models.length ||
      models.length > brainConfig.pricing.maxModels ||
      new Set(models).size !== models.length
    ) {
      fail('Select one or more distinct models.');
    }
    let selected: PricingModel[] = [];
    const id = randomUUID();
    const result = await this.change((catalogue) => {
      if (catalogue.job?.status === 'running' || this.worker || this.discovery.checking) {
        fail('A pricing lookup is already running.', 409);
      }
      selected = models.map((model) => {
        const entry = catalogue.models.find((item) => item.model === model);
        if (entry?.ignored) {
          fail('Restore ignored models before checking their prices.', 409);
        }
        if (!entry?.sourceUrl) {
          fail('Each selected model needs an official pricing URL.');
        }
        pricingUrl(entry.sourceUrl, entry.provider);
        return entry;
      });
      catalogue.job = {
        id,
        status: 'running',
        startedAt: new Date().toISOString(),
        models,
        proposals: [],
      };
    });
    this.worker = this.run(id, selected)
      .catch(async () => {
        await this.change((catalogue) => {
          if (catalogue.job?.id === id) {
            catalogue.job.status = 'failed';
            catalogue.job.error = 'The lookup could not be saved. Existing prices are unchanged.';
          }
        }).catch(() => undefined);
      })
      .finally(() => {
        this.worker = undefined;
      });
    return result;
  }
  private async lookup(id: string, entry: PricingModel): Promise<PricingProposal> {
    let validating = false;
    const proposal: PricingProposal = {
      model: entry.model,
      revision: entry.revision,
      sourceUrl: entry.sourceUrl,
      checkedAt: new Date().toISOString(),
    };
    try {
      const source = await (this.options.fetchSource ?? fetchPricingSource)(
        entry.sourceUrl,
        entry.provider,
        this.shutdown.signal,
      );
      const current = this.catalogue().models.find((item) => item.model === entry.model);
      if (current?.ignored || current?.revision !== entry.revision) {
        fail('This model changed before the agent check.');
      }
      const input = { model: entry.model, provider: entry.provider, source };
      const response = await (this.options.call
        ? this.options.call(input)
        : this.client.call('pricing', pricingPrompt, input, pricingSchema));
      const { value: _value, ...usage } = response;
      proposal.usage = usage;
      await this.options.onUsage?.(id, entry.model, response);
      if (response.error) {
        fail(response.error);
      }
      validating = true;
      Object.assign(
        proposal,
        validateProposal(response.value, source.text, entry.model, entry.provider),
        {
          sourceUrl: source.url,
        },
      );
    } catch (error) {
      proposal.retryable = !validating;
      proposal.error =
        error instanceof Error && 'statusCode' in error
          ? error.message
          : 'The pricing lookup failed. Check the source and connection, then retry.';
    }
    return proposal;
  }
  private async run(id: string, selected: PricingModel[]) {
    for (const entry of selected) {
      if (this.shutdown.signal.aborted) {
        break;
      }
      if (!this.catalogue().job?.models.includes(entry.model)) {
        continue;
      }
      const proposal = await this.lookup(id, entry);
      await this.change((catalogue) => {
        if (catalogue.job?.id === id && catalogue.job.models.includes(entry.model)) {
          catalogue.job.proposals.push(proposal);
        }
      });
    }
    await this.change((catalogue) => {
      if (catalogue.job?.id === id) {
        catalogue.job.status = this.shutdown.signal.aborted ? 'interrupted' : 'completed';
      }
    });
  }
  async apply(jobId: string, model: string) {
    return this.change((catalogue) => {
      const job = catalogue.job;
      if (job?.id !== jobId) {
        fail('This proposal is no longer current. Refresh the page.', 409);
      }
      const proposal = job.proposals.find((item) => item.model === model);
      const entry = catalogue.models.find((item) => item.model === model);
      if (entry?.ignored) {
        fail('Restore this model and check its prices again before applying.', 409);
      }
      if (!entry || !proposal?.rates || proposal.error) {
        fail('No valid proposal is available.');
      }
      if (proposal.appliedAt) {
        return;
      }
      if (entry.revision !== proposal.revision) {
        fail('This model changed after the lookup. Run the agent again.', 409);
      }
      proposal.appliedAt = new Date().toISOString();
      entry.revision++;
      entry.versions.push({
        at: Date.now(),
        rates: proposal.rates,
        origin: 'agent',
        sourceUrl: proposal.sourceUrl,
        checkedAt: proposal.checkedAt,
        evidence: proposal.evidence,
        notes: proposal.notes,
      });
    });
  }
  async close() {
    this.shutdown.abort();
    const discoveryClosed = this.discovery.close();
    await this.client.close();
    await this.worker;
    await discoveryClosed;
    this.releaseCatalogue?.();
  }
}
