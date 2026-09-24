import React from 'react';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import type { TrendsReport } from '../server/src/trends/types';
import { trendsFixture, trendTotals } from './trends-fixture';

function renderedText(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(renderedText).join('');
}

async function mountTrends(t: TestContext) {
  let renderer: ReturnType<typeof create> | undefined;
  const restore: Array<() => void> = [];
  const requests: Array<{ url: URL; signal: AbortSignal; complete: (response: Response) => void }> =
    [];
  const polls = new Map<ReturnType<typeof setInterval>, () => void>();
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const replacements = {
    location: new URL('http://localhost/#trends'),
    localStorage: { getItem: () => null },
    fetch: (url: string, options: RequestInit) =>
      new Promise<Response>((complete) => {
        // Deliberately allow completion after abort: a superseded response must
        // never replace the current range even if the transport ignores abort.
        requests.push({ url: new URL(url), signal: options.signal as AbortSignal, complete });
      }),
    setInterval: (callback: () => void, delay: number) => {
      if (delay === 30_000) {
        const id = {} as ReturnType<typeof setInterval>;
        polls.set(id, callback);
        return id;
      }
      return originalInterval(callback, delay);
    },
    clearInterval: (id: ReturnType<typeof setInterval>) => {
      if (!polls.delete(id)) {
        originalClear(id);
      }
    },
  };
  const vite = await createServer({
    root: resolve('ui'),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  async function unmount() {
    if (renderer) {
      await act(async () => renderer?.unmount());
      renderer = undefined;
    }
  }
  t.after(async () => {
    await unmount();
    for (const reset of restore) {
      reset();
    }
    await vite.close();
  });
  for (const [name, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restore.push(() => {
      if (original) {
        Object.defineProperty(globalThis, name, original);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    });
  }
  const { Trends } = await vite.ssrLoadModule('/src/components/Trends.tsx');
  await act(async () => {
    renderer = create(<Trends />);
  });
  const root = () => renderer!.root;
  const text = () => renderedText(root());
  const group = (label: string) => root().findByProps({ role: 'group', 'aria-label': label });
  const button = (label: string, within = root()) => {
    const found = within
      .findAllByType('button')
      .find((node) => renderedText(node).replace(/\s*⌄$/, '').trim() === label);
    assert.ok(found, `Expected button ${label}`);
    return found;
  };
  const card = (label: string) => {
    const found = root()
      .findAllByType('article')
      .find((node) => node.findAllByType('h2').some((heading) => renderedText(heading) === label));
    assert.ok(found, `Expected summary card ${label}`);
    return found;
  };
  const cardValue = (label: string) => renderedText(card(label).findByType('div'));
  const click = async (label: string, within = root()) => {
    await act(async () => button(label, within).props.onClick());
  };
  const reply = async (report: TrendsReport, index = requests.length - 1) => {
    await act(async () => requests[index].complete(Response.json(report)));
  };
  const poll = async () => {
    assert.equal(polls.size, 1, 'one timer belongs to the active range');
    await act(async () => [...polls.values()][0]());
  };
  return {
    root,
    text,
    group,
    button,
    card,
    cardValue,
    click,
    reply,
    poll,
    requests,
    polls,
    unmount,
  };
}

test('Trends drills into a team and person, preserves filters across periods and rejects stale responses', async (t) => {
  const page = await mountTrends(t);
  const report = trendsFixture();
  await page.reply(report);
  const audience = () => page.root().findByProps({ 'aria-label': 'Team and person usage' });
  const rowLink = () => audience().findByProps({ className: 'trends-audience-link' });
  await act(async () => rowLink().props.onClick());
  assert.equal(page.requests.at(-1)!.url.searchParams.get('team'), 'test-team');
  assert.equal(page.requests.at(-1)!.url.searchParams.has('person'), false);
  await page.reply({ ...report, filters: { team: 'test-team' } });
  assert.equal(page.button('People', page.group('Audience dimension')).props['aria-pressed'], true);
  assert.match(renderedText(audience()), /calm-otter-01/);
  await act(async () => rowLink().props.onClick());
  const personRequest = page.requests.at(-1)!;
  assert.equal(personRequest.url.searchParams.get('person'), 'person-a');
  assert.equal(personRequest.url.searchParams.get('team'), 'test-team');
  await page.click('Today');
  assert.equal(personRequest.signal.aborted, true);
  assert.equal(page.requests.at(-1)!.url.search, '?period=today&team=test-team&person=person-a');
  const active = page.requests.length - 1;
  await page.reply({ ...report, summary: trendTotals({ costUsd: 999 }) }, active - 1);
  assert.doesNotMatch(page.text(), /\$999/);
  await page.reply({ ...report, filters: { team: 'test-team', person: 'person-a' } }, active);
  assert.equal(page.root().findByProps({ 'aria-label': 'Person' }).props.value, 'person-a');
  assert.match(renderedText(audience()), /Known cached tokens.*100/);
  assert.match(renderedText(audience()), /73.5% vs previous period/);
  await page.click('Clear filters');
  assert.equal(page.requests.at(-1)!.url.search, '?period=today');
  await page.reply(report);
  const change = async (label: string, value: string) =>
    act(async () =>
      page.root().findByProps({ 'aria-label': label }).props.onChange({ target: { value } }),
    );
  await change('Person', 'person-a');
  await page.reply({ ...report, filters: { person: 'person-a' } });
  await change('Team', 'test-team');
  assert.equal(
    page.requests.at(-1)!.url.searchParams.has('person'),
    false,
    'changing team resets the person',
  );
  await page.reply({ ...report, byTeam: [], byPerson: [], filters: { team: 'test-team' } });
  assert.match(page.text(), /No activity matches these filters/);
  assert.equal(page.button('Clear filters').props.disabled, undefined);
});

test('audience comparisons respect missing costs and token measurements', async (t) => {
  const page = await mountTrends(t);
  const report = trendsFixture();
  report.byTeam[0].current = trendTotals({
    unknownUsageCount: 1,
    unknownTokenCount: 1,
    cacheKnown: false,
  });
  await page.reply(report);
  const section = page.root().findByProps({ 'aria-label': 'Team and person usage' });
  assert.match(renderedText(section), /Cost comparison unavailable/);
  assert.match(renderedText(section), /Partial cost/);
  const compare = section.findByType('select');
  await act(async () => compare.props.onChange({ target: { value: 'tokens' } }));
  assert.match(renderedText(section), /Token comparison unavailable/);
  await act(async () => compare.props.onChange({ target: { value: 'prompts' } }));
  assert.match(renderedText(section), /Prompts change.*No change/);
});

test('Trends retries failures, keeps the same range on failed polling, and cleans up pending work', async (t) => {
  const page = await mountTrends(t);
  assert.equal(page.requests.length, 1);
  assert.equal(
    page.requests[0].url.pathname + page.requests[0].url.search,
    '/api/trends?period=14d',
  );
  assert.equal(page.button('Refreshing…').props.disabled, true);
  await page.poll();
  assert.equal(page.requests.length, 1, 'polling cannot overlap an unfinished request');
  await act(async () => page.requests[0].complete(new Response('', { status: 503 })));
  assert.match(page.text(), /History could not be loaded/);
  await page.click('Retry loading');
  await page.reply(trendsFixture());
  assert.equal(page.cardValue('Known cost'), '$1.73');
  assert.equal(
    page.cardValue('Unique sessions'),
    '2',
    'headline uses unique sessions, not the sum of daily appearances',
  );
  assert.doesNotMatch(page.text(), /PostgreSQL|SQLite/);
  await page.poll();
  await page.poll();
  assert.equal(page.requests.length, 3, 'only one refresh request may run at a time');
  await act(async () => page.requests[2].complete(new Response('', { status: 500 })));
  assert.match(page.text(), /Showing the last received data/);
  assert.equal(page.cardValue('Known cost'), '$1.73');
  assert.equal(
    page
      .root()
      .findByProps({ 'aria-label': 'Detailed usage figures' })
      .findByType('tbody')
      .findAllByType('tr').length,
    2,
  );
  await page.click('Retry loading');
  const pending = page.requests[3];
  assert.equal(pending.signal.aborted, false);
  await page.unmount();
  assert.equal(pending.signal.aborted, true);
  assert.equal(page.polls.size, 0);
  await act(async () => pending.complete(Response.json(trendsFixture())));
});

test('Trends cancels obsolete periods and never shows a late response under the new range', async (t) => {
  const page = await mountTrends(t);
  await page.reply(trendsFixture());
  await page.poll();
  const oldRequest = page.requests[1];
  await page.click('Today');
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(page.requests[2].url.search, '?period=today');
  assert.equal(
    page.root().findAllByType('article').length,
    0,
    'old KPIs disappear as soon as the range changes',
  );
  assert.equal(
    page.root().findAllByType('tbody').length,
    0,
    'old detailed rows must not remain visible',
  );
  await page.reply(trendsFixture({ summary: trendTotals({ costUsd: 913.88 }) }), 1);
  assert.equal(
    page.root().findAllByType('article').length,
    0,
    'an aborted response cannot end the new range loading state',
  );
  await page.reply(trendsFixture({ summary: trendTotals({ costUsd: 12.34 }) }), 2);
  assert.equal(page.cardValue('Known cost'), '$12.34');
  await page.click('This month');
  const month = page.requests[3];
  await page.click('90 days');
  assert.equal(month.signal.aborted, true);
  await page.reply(trendsFixture({ summary: trendTotals({ costUsd: 99.99 }) }), 4);
  await page.reply(trendsFixture({ summary: trendTotals({ costUsd: 88.88 }) }), 3);
  assert.equal(page.cardValue('Known cost'), '$99.99');
  assert.equal(page.button('90 days').props['aria-pressed'], true);
});

test('Trends sends every preset and custom range, and rejects invalid dates without requesting data', async (t) => {
  const page = await mountTrends(t);
  const base = trendsFixture();
  await page.reply(base);
  const presets = [
    ['Today', 'today'],
    ['7 days', '7d'],
    ['14 days', '14d'],
    ['This month', 'month'],
    ['30 days', '30d'],
    ['90 days', '90d'],
  ] as const;
  for (const [label, period] of presets) {
    await page.click(label);
    assert.equal(page.requests.at(-1)!.url.search, `?period=${period}`);
    assert.equal(page.button(label).props['aria-pressed'], true);
    assert.equal(
      page
        .group('Choose reporting period')
        .findAllByType('button')
        .filter((node) => node.props['aria-pressed']).length,
      1,
    );
    await page.reply(trendsFixture({ period: { ...base.period, key: period } }));
  }
  const requestCount = page.requests.length;
  await page.click('Custom');
  assert.equal(page.button('Custom').props['aria-expanded'], true);
  assert.equal(
    page.requests.length,
    requestCount,
    'opening the date editor does not change the report',
  );
  const field = (label: string) =>
    page
      .root()
      .findAllByType('label')
      .find((node) => renderedText(node) === label)!
      .findByType('input');
  async function applyDates(start: string, end: string) {
    await act(async () => {
      field('Start date').props.onChange({ target: { value: start } });
      field('End date').props.onChange({ target: { value: end } });
    });
    await act(async () =>
      page
        .root()
        .findByType('form')
        .props.onSubmit({ preventDefault() {} }),
    );
  }
  for (const [start, end, message] of [
    ['', '', /Choose a start and end date/],
    ['2020-09-12', '2020-09-01', /on or after the start date/],
    ['2020-01-01', '2020-05-01', /up to 90 days/],
    ['9999-12-30', '9999-12-31', /no later than today/],
  ] as const) {
    await applyDates(start, end);
    assert.equal(page.requests.length, requestCount, 'invalid custom dates never reach the API');
    assert.match(renderedText(page.root().findByProps({ role: 'alert' })), message);
    assert.equal(field('End date').props['aria-invalid'], true);
  }
  await applyDates('2020-09-01', '2020-09-12');
  assert.equal(page.requests.length, requestCount + 1);
  assert.equal(page.requests.at(-1)!.url.search, '?period=custom&start=2020-09-01&end=2020-09-12');
  assert.equal(page.button('Custom').props['aria-pressed'], true);
  assert.equal(page.root().findAllByProps({ role: 'alert' }).length, 0);
});

test('Trends comparisons distinguish unknown usage, incomplete history, and a zero baseline', async (t) => {
  const page = await mountTrends(t);
  await page.reply(trendsFixture());
  assert.match(renderedText(page.card('Known cost')), /↑ 73.5% vs previous period/);
  assert.match(renderedText(page.card('Known tokens')), /↑ 60% vs previous period/);
  assert.match(renderedText(page.card('Prompts')), /↓ 50% vs previous period/);
  assert.match(renderedText(page.card('Unique sessions')), /↑ 100% vs previous period/);
  await page.poll();
  await page.reply(
    trendsFixture({
      summary: trendTotals({
        costKnown: false,
        tokensKnown: false,
        unknownUsageCount: 1,
        unknownTokenCount: 1,
      }),
    }),
  );
  assert.equal(page.cardValue('Known cost'), 'Unavailable');
  assert.equal(page.cardValue('Known tokens'), 'Unavailable');
  assert.match(renderedText(page.card('Known cost')), /Cost comparison unavailable/);
  assert.match(renderedText(page.card('Known tokens')), /Token comparison unavailable/);
  await page.poll();
  await page.reply(
    trendsFixture({
      previous: trendTotals({ unknownUsageCount: 1, unknownTokenCount: 1 }),
    }),
  );
  assert.equal(page.cardValue('Known cost'), '$1.73', 'partially known totals remain visible');
  assert.match(renderedText(page.card('Known cost')), /Cost comparison unavailable/);
  assert.match(renderedText(page.card('Known tokens')), /Token comparison unavailable/);
  await page.poll();
  await page.reply(
    trendsFixture({ coverage: { ...trendsFixture().coverage, previousComplete: false } }),
  );
  for (const label of ['Known cost', 'Known tokens', 'Prompts', 'Unique sessions']) {
    assert.match(renderedText(page.card(label)), /No comparable period yet/);
  }
  assert.equal(page.root().findAllByProps({ 'aria-label': 'Data coverage' }).length, 0);
  assert.match(page.text(), /History since/);
  await page.poll();
  await page.reply(
    trendsFixture({
      summary: trendTotals({ prompts: 0, sessions: 0 }),
      previous: trendTotals({
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokens: 0,
        prompts: 0,
        sessions: 0,
      }),
    }),
  );
  assert.match(renderedText(page.card('Known cost')), /Previous value was zero/);
  assert.match(renderedText(page.card('Known tokens')), /Previous value was zero/);
  assert.match(renderedText(page.card('Prompts')), /No change/);
  assert.match(renderedText(page.card('Unique sessions')), /No change/);
  assert.doesNotMatch(page.text(), /Infinity|NaN/);
});

test('Trends switches chart and breakdown metrics and preserves exact figures and unavailable values', async (t) => {
  const page = await mountTrends(t);
  const data = trendsFixture();
  data.buckets[0] = {
    ...data.buckets[0],
    costKnown: false,
    tokensKnown: false,
    tokensInKnown: false,
    tokensOutKnown: false,
    unknownUsageCount: 1,
    unknownTokenCount: 1,
  };
  await page.reply(data);
  const rows = page
    .root()
    .findByProps({ 'aria-label': 'Detailed usage figures' })
    .findByType('tbody')
    .findAllByType('tr');
  assert.deepEqual(rows[0].findAllByType('td').map(renderedText), [
    'Unavailable',
    'Unavailable',
    'Unavailable',
    '2',
    '2',
    '1',
    '1',
  ]);
  assert.deepEqual(rows[1].findAllByType('td').map(renderedText), [
    '$1.23456',
    '100',
    '20',
    '1',
    '1',
    '0',
    '0',
  ]);
  const svg = () => page.root().findByType('svg');
  assert.match(svg().props['aria-label'], /Known cost per day/);
  assert.match(renderedText(svg()), /1\.23456/);
  await page.click('Tokens', page.group('Chart metric'));
  assert.match(svg().props['aria-label'], /Known tokens per day/);
  assert.match(renderedText(svg()), /120 tokens/);
  await page.click('Prompts', page.group('Chart metric'));
  assert.match(svg().props['aria-label'], /Prompts per day/);
  assert.match(renderedText(svg()), /2 prompts/);
  await page.click('Cost', page.group('Chart metric'));
  assert.match(svg().props['aria-label'], /Known cost per day/);
  const breakdown = () => page.root().findByType('ul');
  assert.match(renderedText(breakdown()), /openai.*\$1\.73.*anthropic.*Unavailable/);
  await page.click('Tokens', page.group('Breakdown metric'));
  assert.match(renderedText(breakdown()), /openai.*320/);
  await page.click('Models', page.group('Breakdown dimension'));
  assert.match(renderedText(breakdown()), /gpt-test-model.*openai.*320/);
  assert.doesNotMatch(renderedText(breakdown()), /anthropic/);
  await page.click('Teams', page.group('Breakdown dimension'));
  assert.match(renderedText(breakdown()), /Test team.*320/);
  assert.match(page.text(), /Shared activity appears in each team/);
  await page.click('Cost', page.group('Breakdown metric'));
  assert.match(renderedText(breakdown()), /Test team.*\$1\.73/);
  await page.click('Providers', page.group('Breakdown dimension'));
  assert.match(renderedText(breakdown()), /anthropic.*Unavailable/);
  assert.equal(
    page.requests.length,
    1,
    'presentation controls do not refetch unchanged report data',
  );
  await page.poll();
  await page.reply(
    trendsFixture({
      period: { ...data.period, key: 'today', granularity: 'hour' },
    }),
  );
  assert.match(svg().props['aria-label'], /Known cost per hour/);
  await page.poll();
  await page.reply(
    trendsFixture({
      period: { ...data.period, key: '90d', granularity: 'week' },
      coverage: {
        ...data.coverage,
        currentComplete: false,
        earliestAvailableAt: data.buckets[0].end,
      },
    }),
  );
  assert.match(svg().props['aria-label'], /Known cost per week/);
  const missingHistory = page
    .root()
    .findByProps({ 'aria-label': 'Detailed usage figures' })
    .findByType('tbody')
    .findAllByType('tr')[0];
  assert.deepEqual(
    missingHistory.findAllByType('td').map(renderedText),
    Array(7).fill('Unavailable'),
    'pre-history intervals must not imply zero recorded activity',
  );
});

test('Trends explains disabled history without rendering misleading totals', async (t) => {
  const page = await mountTrends(t);
  await page.reply(trendsFixture({ enabled: false, backend: 'disabled' }));
  assert.match(page.text(), /History is unavailable/);
  assert.equal(page.root().findAllByType('article').length, 0);
  assert.equal(page.root().findAllByType('svg').length, 0);
});

test('Trends cost coverage excludes token-only observations from its denominator', async (t) => {
  const page = await mountTrends(t);
  await page.reply(
    trendsFixture({
      summary: trendTotals({ usageCount: 10, knownCostCount: 4, unknownUsageCount: 1 }),
    }),
  );
  const insights = page.root().findByProps({ 'aria-label': 'Period insights' });
  assert.match(renderedText(insights), /Cost coverage80%/);
  assert.match(renderedText(insights), /4 of 5 cost observations have a known cost/);
  assert.match(renderedText(insights), /Average known cost \/ day\$0\.87/);
  assert.match(renderedText(insights), /Most expensive day\$1\.23/);
});

test('partial token observations hide missing directions and percentage comparisons', async (t) => {
  const page = await mountTrends(t);
  const data = trendsFixture();
  const partial = trendTotals({
    tokensIn: 100,
    tokensOut: 0,
    tokens: 100,
    tokensInKnown: true,
    tokensOutKnown: false,
    unknownTokenCount: 1,
  });
  data.summary = partial;
  data.buckets = [{ ...data.buckets[0], ...partial }];
  await page.reply(data);
  assert.equal(page.cardValue('Known tokens'), '100');
  assert.match(renderedText(page.card('Known tokens')), /100 input · Unknown output/);
  assert.match(renderedText(page.card('Known tokens')), /Token comparison unavailable/);
  assert.doesNotMatch(renderedText(page.card('Known tokens')), /50%/);
  const cells = () =>
    page
      .root()
      .findByProps({ 'aria-label': 'Detailed usage figures' })
      .findByType('tbody')
      .findAllByType('td')
      .map(renderedText);
  assert.equal(cells()[1], '100');
  assert.equal(cells()[2], 'Unavailable');
  await page.poll();
  data.summary = trendTotals();
  data.previous = partial;
  await page.reply(data);
  assert.match(renderedText(page.card('Known tokens')), /Token comparison unavailable/);
  await page.poll();
  const outputOnly = {
    ...partial,
    tokensIn: 0,
    tokensOut: 20,
    tokens: 20,
    tokensInKnown: false,
    tokensOutKnown: true,
  };
  await page.reply({
    ...data,
    summary: outputOnly,
    buckets: [{ ...data.buckets[0], ...outputOnly }],
  });
  assert.equal(cells()[1], 'Unavailable');
  assert.equal(cells()[2], '20');
});

test('ignored model costs do not trigger reminders but remain visible in coverage', async (t) => {
  const page = await mountTrends(t);
  const data = trendsFixture({
    summary: trendTotals({ knownCostCount: 4, unknownUsageCount: 2 }),
  });
  data.coverage.ignoredCostCount = 2;
  await page.reply(data);
  assert.equal(page.root().findAllByProps({ 'aria-label': 'Data coverage' }).length, 0);
  assert.match(page.text(), /2 unpriced observations belong to models ignored in pricing/);
  assert.match(page.text(), /4 of 6 cost observations have a known cost/);
  assert.doesNotMatch(page.text(), /Review model pricing/);
  await page.poll();
  await page.reply({ ...data, summary: trendTotals({ unknownUsageCount: 3 }) });
  const warning = page.root().findByProps({ 'aria-label': 'Data coverage' });
  assert.match(renderedText(warning), /1 usage observations have unknown costs/);
  assert.match(renderedText(warning), /Review model pricing/);
  await page.poll();
  await page.reply({
    ...data,
    summary: trendTotals({ unknownUsageCount: 2, unknownTokenCount: 1 }),
  });
  assert.match(
    renderedText(page.root().findByProps({ 'aria-label': 'Data coverage' })),
    /unknown tokens/,
  );
});
