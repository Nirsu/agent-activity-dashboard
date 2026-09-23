import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { act, create } from 'react-test-renderer';
import { PricingModelForm } from '../ui/src/components/brain/PricingModelForm';
import type { PricingState } from '../ui/src/components/brain/pricingTypes';
import {
  comparisonRates,
  formatPrice,
  priceChange,
  proposalReady,
  pricingAttentionModels,
} from '../ui/src/components/brain/pricingPresentation';
import { PricingProposals } from '../ui/src/components/brain/PricingProposals';
import { renderToStaticMarkup } from 'react-dom/server';
import { pricingEvidenceRows } from '../ui/src/components/brain/pricingEvidence';
import PricingVerification from '../ui/src/components/brain/PricingVerification';
test('model registration preserves exact ID and source without inventing manual prices', async () => {
  let saved: unknown;
  let closed = false;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <PricingModelForm
        busy={false}
        onSave={async (input) => {
          saved = input;
          return true;
        }}
        onCancel={() => {
          closed = true;
        }}
      />,
    );
  });
  const inputs = renderer.root.findAllByType('input');
  await act(async () => {
    inputs[0].props.onChange({ target: { value: 'new-model' } });
    inputs[1].props.onChange({
      target: { value: 'https://developers.openai.com/api/docs/pricing' },
    });
  });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  assert.deepEqual(saved, {
    model: 'new-model',
    provider: 'openai',
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    revision: 0,
  });
  assert.equal(closed, true);
  await act(async () => renderer.unmount());
});
test('Settings asks for prices and requires a separate apply action; source-less models remain editable', async (t) => {
  const previous = ['location', 'localStorage', 'window'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('http://localhost/'),
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setInterval, clearInterval },
  });
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  const vite = await createServer({
    root: resolve('ui'),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  t.after(() => vite.close());
  const { BrainPricing } = await vite.ssrLoadModule('/src/components/brain/BrainPricing.tsx');
  const rates = { inputPerMillionUsd: 1, outputPerMillionUsd: 4 };
  const state: PricingState = {
    agent: { configured: true, model: 'test-agent' },
    models: [
      {
        model: 'test-model',
        provider: 'openai',
        sourceUrl: 'https://developers.openai.com/api/docs/pricing',
        revision: 1,
        versions: [{ at: 0, rates, sourceUrl: '', origin: 'environment' }],
      },
      {
        model: 'legacy-model',
        provider: 'openai',
        sourceUrl: '',
        revision: 1,
        versions: [{ at: 0, rates, sourceUrl: '', origin: 'environment' }],
      },
    ],
  };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, options?: RequestInit) => {
    const path = new URL(input).pathname;
    requests.push(path);
    if (path.endsWith('/lookup')) {
      assert.deepEqual(JSON.parse(options!.body as string), { models: ['test-model'] });
      state.job = {
        id: 'job',
        status: 'completed',
        startedAt: new Date().toISOString(),
        models: ['test-model'],
        proposals: [
          {
            model: 'test-model',
            revision: 1,
            sourceUrl: state.models[0].sourceUrl,
            checkedAt: new Date().toISOString(),
            rates: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
            evidence: 'Official source excerpt',
            notes: 'Standard text rates.',
          },
        ],
      };
    }
    if (path.endsWith('/apply')) {
      assert.deepEqual(JSON.parse(options!.body as string), { jobId: 'job', model: 'test-model' });
      state.job!.proposals[0].appliedAt = new Date().toISOString();
    }
    if (path.endsWith('/ignore')) {
      const input = JSON.parse(options!.body as string);
      const entry = state.models.find((model) => model.model === input.model)!;
      assert.equal(input.revision, entry.revision);
      assert.equal(input.model, 'test-model');
      entry.ignored = input.ignored;
      entry.revision++;
      state.job = undefined;
    }
    return Response.json(state);
  });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<BrainPricing onAdminRequired={() => {}} />);
  });
  assert.equal(renderer.root.findByProps({ id: 'brain-pricing-content' }).props.hidden, true);
  await act(async () => {
    renderer.root.findByProps({ 'aria-controls': 'brain-pricing-content' }).props.onClick();
  });
  assert.equal(renderer.root.findByProps({ id: 'brain-pricing-content' }).props.hidden, false);
  const checkButton = renderer.root
    .findAllByType('button')
    .find((button) => button.props['aria-label'] === 'Check prices for test-model')!;
  assert.equal(checkButton.props.disabled, false);
  assert.equal(
    renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === 'Add source for legacy-model')!.props
      .disabled,
    false,
  );
  await act(async () => {
    await checkButton.props.onClick();
  });
  assert.equal(
    requests.some((path) => path.endsWith('/apply')),
    false,
  );
  await act(async () => {
    renderer.root.findByProps({ 'aria-controls': 'brain-pricing-content' }).props.onClick();
  });
  assert.equal(renderer.root.findByProps({ id: 'brain-pricing-content' }).props.hidden, true);
  const reviewBadge = renderer.root
    .findAllByType('button')
    .find((button) => button.props.className === 'brain-pricing-badge review')!;
  assert.match(JSON.stringify(reviewBadge.props.children), /to review/);
  await act(async () => reviewBadge.props.onClick());
  assert.equal(renderer.root.findByProps({ id: 'brain-pricing-content' }).props.hidden, false);
  const apply = renderer.root
    .findAllByType('button')
    .find((button) => button.props.children === 'Apply prices')!;
  assert.equal(apply.props.disabled, false);
  await act(async () => {
    await apply.props.onClick();
  });
  assert.equal(requests.filter((path) => path.endsWith('/apply')).length, 1);
  assert.match(JSON.stringify(renderer.toJSON()), /Applied/);
  await act(async () => {
    renderer.root
      .findAllByType('button')
      .find(
        (button) =>
          button.props.children?.[0] === 'Ignore' &&
          button.props.children?.[1]?.props.children?.includes('test-model'),
      )!
      .props.onClick();
  });
  assert.equal(requests.filter((path) => path.endsWith('/ignore')).length, 1);
  assert.equal(renderer.root.findAllByProps({ 'aria-label': 'Select test-model' }).length, 0);
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': 'Check prices for test-model' }).length,
    0,
  );
  assert.match(JSON.stringify(renderer.toJSON()), /Ignored models/);
  assert.equal(
    renderer.root.findByProps({ className: 'brain-pricing-ignored' }).props.open,
    undefined,
  );
  await act(async () => {
    renderer.root
      .findAllByType('button')
      .find((button) => button.props.children?.[0] === 'Restore')!
      .props.onClick();
  });
  assert.equal(requests.filter((path) => path.endsWith('/ignore')).length, 2);
  assert.equal(renderer.root.findAllByProps({ 'aria-label': 'Select test-model' }).length, 1);
  assert.equal(renderer.root.findAllByProps({ className: 'brain-pricing-ignored' }).length, 0);
  await act(async () => renderer.unmount());
});

test('ignored models never produce attention badges or actionable proposals', () => {
  const state: PricingState = {
    agent: { configured: true, model: 'agent' },
    automation: { enabled: true, checking: false },
    models: [
      {
        model: 'codex-auto-review',
        provider: 'openai',
        sourceUrl: '',
        revision: 1,
        versions: [],
        ignored: true,
        automatic: { status: 'failed', attempts: 1, error: 'Unknown model' },
      },
    ],
    job: {
      id: 'ignored-job',
      status: 'failed',
      startedAt: '',
      error: 'Check interrupted',
      models: ['codex-auto-review'],
      proposals: [
        {
          model: 'codex-auto-review',
          sourceUrl: '',
          checkedAt: '',
          revision: 1,
          rates: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
        },
      ],
    },
  };
  assert.deepEqual(pricingAttentionModels(state), []);
  assert.equal(proposalReady(state.job!.proposals[0], state.models), false);
  const markup = renderToStaticMarkup(
    <PricingProposals
      state={state}
      busy={false}
      headingRef={{ current: null }}
      onApply={() => {}}
      onRetry={() => {}}
      onVerify={() => {}}
    />,
  );
  assert.equal(markup, '');
});

test('attention counts include reviews and failures once, without flagging active automatic checks', () => {
  const model = (name: string) => ({
    model: name,
    provider: 'openai' as const,
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    revision: 1,
    versions: [],
  });
  const state: PricingState = {
    agent: { configured: true, model: 'agent' },
    automation: { enabled: true, checking: false },
    models: [
      model('review'),
      { ...model('queued'), automatic: { status: 'queued', attempts: 0 } },
      { ...model('failed'), automatic: { status: 'failed', attempts: 1, error: 'Unavailable' } },
      {
        ...model('saved'),
        versions: [
          {
            at: 0,
            rates: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
            sourceUrl: 'https://developers.openai.com/api/docs/pricing',
            origin: 'agent',
            checkedAt: '2026-09-23T10:00:00Z',
          },
        ],
      },
    ],
    job: {
      id: 'job',
      status: 'completed',
      startedAt: '',
      models: ['review', 'failed'],
      proposals: [
        {
          model: 'review',
          revision: 1,
          sourceUrl: '',
          checkedAt: '',
          rates: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
        },
        { model: 'failed', revision: 1, sourceUrl: '', checkedAt: '', error: 'Unavailable' },
      ],
    },
  };
  assert.deepEqual(pricingAttentionModels(state), ['review', 'failed']);
  assert.deepEqual(pricingAttentionModels({ ...state, agent: { configured: false, model: '' } }), [
    'review',
    'queued',
    'failed',
  ]);
  state.models[0].revision++;
  assert.deepEqual(
    pricingAttentionModels(state),
    ['review', 'failed'],
    'Stale proposals still need attention',
  );
});

test('verification pairs separate table excerpts faithfully and leaves incomplete rows unlabelled', () => {
  const evidence =
    'Prices per 1M tokens.\n\n[…]\n\n| Model | Input | Cached input | Output |\n\n[…]\n\n| gpt-6-astra | $10.00 | $1.00 | $50.00 |';
  assert.deepEqual(pricingEvidenceRows(evidence), [
    {
      fields: [
        { label: 'Model', value: 'gpt-6-astra' },
        { label: 'Input', value: '$10.00' },
        { label: 'Cached input', value: '$1.00' },
        { label: 'Output', value: '$50.00' },
      ],
    },
  ]);
  assert.deepEqual(pricingEvidenceRows('| gpt-6-astra | $10 | $50 |'), []);
  assert.deepEqual(pricingEvidenceRows('| Model | Input | Output |\n| gpt-6-astra | $10 |'), []);
  const html = renderToStaticMarkup(
    <PricingVerification
      verification={{
        model: 'gpt-6-astra',
        sourceUrl: 'https://developers.openai.com/api/docs/pricing',
        evidence,
        rates: { inputPerMillionUsd: 10, outputPerMillionUsd: 50, cachedInputPerMillionUsd: 1 },
        notes: 'Standard rates.',
      }}
      onClose={() => {}}
    />,
  );
  assert.match(html, /<dt>Input<\/dt><dd>\$10\.00<\/dd>/);
  assert.match(html, /Original source excerpts/);
  assert.match(html, /aria-labelledby="pricing-verification-title"/);
});

test('price comparisons keep unknown distinct from zero and retain the true previous price after later edits', () => {
  assert.equal(formatPrice(0), '$0');
  assert.equal(formatPrice(undefined), 'Not set');
  assert.equal(priceChange(undefined, 0), 'New price');
  assert.equal(priceChange(0, undefined), 'Now unknown');
  assert.equal(priceChange(1, 2), '+$1');
  assert.equal(priceChange(2, 1), '−$1');
  const proposal = {
    model: 'test',
    revision: 1,
    sourceUrl: '',
    checkedAt: 'check-time',
    appliedAt: 'apply-time',
    rates: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
  };
  const entry = {
    model: 'test',
    provider: 'openai' as const,
    sourceUrl: '',
    revision: 3,
    versions: [
      {
        at: 0,
        rates: { inputPerMillionUsd: 1, outputPerMillionUsd: 4 },
        sourceUrl: '',
        origin: 'environment' as const,
      },
      {
        at: 1,
        rates: proposal.rates,
        sourceUrl: '',
        origin: 'agent' as const,
        checkedAt: proposal.checkedAt,
      },
      {
        at: 2,
        rates: { inputPerMillionUsd: 3, outputPerMillionUsd: 9 },
        sourceUrl: '',
        origin: 'manual' as const,
      },
    ],
  };
  assert.equal(comparisonRates(proposal, entry)?.inputPerMillionUsd, 1);
  assert.equal(proposalReady({ ...proposal, appliedAt: undefined }, [entry]), false);
  const html = renderToStaticMarkup(
    <PricingProposals
      state={{
        models: [entry],
        agent: { configured: true, model: 'agent' },
        job: {
          id: 'job',
          status: 'completed',
          startedAt: '2026-09-23T10:00:00Z',
          models: ['test'],
          proposals: [{ ...proposal, checkedAt: '2026-09-23T10:00:00Z', appliedAt: undefined }],
        },
      }}
      busy={false}
      headingRef={{ current: null }}
      onApply={() => {}}
      onRetry={() => {}}
      onVerify={() => {}}
    />,
  );
  assert.match(html, /Out of date/);
  assert.doesNotMatch(html, />Apply prices</);
});

test('save-only does not ask the agent and save errors remain beside the completed form', async () => {
  const requests: boolean[] = [];
  let closed = false;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <PricingModelForm
        busy={false}
        agentConfigured
        error="The source URL is not supported. Use an official page."
        onSave={async (_input, check) => {
          requests.push(check);
          return false;
        }}
        onCancel={() => {
          closed = true;
        }}
      />,
    );
  });
  await act(async () => {
    const fields = renderer.root.findAllByType('input');
    fields[0].props.onChange({ target: { value: 'new-model' } });
    fields[1].props.onChange({
      target: { value: 'https://developers.openai.com/api/docs/pricing' },
    });
  });
  await act(async () => {
    await renderer.root
      .findByType('form')
      .props.onSubmit({ preventDefault() {}, nativeEvent: { submitter: { value: 'save-only' } } });
  });
  assert.deepEqual(requests, [false]);
  assert.equal(closed, false);
  assert.equal(renderer.root.findAllByType('input')[0].props.value, 'new-model');
  assert.equal(
    renderer.root.findByProps({ role: 'alert' }).props.children,
    'The source URL is not supported. Use an official page.',
  );
  await act(async () => renderer.unmount());
});
