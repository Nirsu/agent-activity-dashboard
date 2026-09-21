import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { brainConfig } from './brain/config.js';
import { OpenAIClient } from './brain/analysis/openai.js';

const options = { model: 'test-model', apiKey: 'test-key-never-sent', requestTimeoutMs: 600_000 };
const value = { summary: 'Fixture response', requirements: [] };
const schema = { type: 'object', properties: { summary: { type: 'string' } } };
const payload = {
  status: 'completed',
  usage: { input_tokens: 10, output_tokens: 5 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
};
const privateDetail = 'Private provider detail';

test('OpenAI sends a strict structured request and preserves response usage', async (t) => {
  const client = new OpenAIClient(options);
  t.after(() => client.close());
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, options.requestTimeoutMs);
    return timeout(ms);
  });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${options.apiKey}`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: options.model,
      store: false,
      instructions: 'Read approved references.',
      input: JSON.stringify({ feature: 'Hooks' }),
      max_output_tokens: brainConfig.analysis.maxOutputTokens,
      text: { format: { type: 'json_schema', name: 'reader', strict: true, schema } },
    });
    return Response.json(payload);
  });
  assert.deepEqual(
    await client.call('reader', 'Read approved references.', { feature: 'Hooks' }, schema),
    {
      value,
      inputTokens: 10,
      outputTokens: 5,
      usageKnown: true,
      model: 'test-model',
      responseId: undefined,
      cachedInputTokens: undefined,
      reasoningTokens: undefined,
    },
  );
});

test('OpenAI reads final JSON separately from preliminary commentary', async (t) => {
  const client = new OpenAIClient(options);
  t.after(() => client.close());
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      ...payload,
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          phase: 'commentary',
          content: [{ type: 'output_text', text: '{"requests":[]}' }],
        },
        {
          type: 'message',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: JSON.stringify(value) }],
        },
      ],
    }),
  );
  assert.deepEqual((await client.call('reader', '', {}, schema)).value, value);
});

test('OpenAI never accepts commentary as a final answer or masks a final refusal', async (t) => {
  const client = new OpenAIClient(options);
  t.after(() => client.close());
  const commentary = {
    type: 'message',
    phase: 'commentary',
    content: [{ type: 'output_text', text: JSON.stringify(value) }],
  };
  let output: unknown[] = [commentary];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...payload, output }));
  assert.equal((await client.call('reader', '', {}, schema)).value, null);
  output = [
    commentary,
    {
      type: 'message',
      phase: 'final_answer',
      content: [{ type: 'refusal', refusal: privateDetail }],
    },
  ];
  const refused = await client.call('reader', '', {}, schema);
  assert.equal(refused.value, null);
  assert.doesNotMatch(JSON.stringify(refused), /Private provider detail/);
});

for (const [name, response] of [
  ['incomplete', { ...payload, status: 'incomplete' }],
  [
    'refusal',
    {
      ...payload,
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: privateDetail }] }],
    },
  ],
  [
    'invalid structured JSON',
    {
      ...payload,
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{invalid' }] }],
    },
  ],
] as const) {
  test(`OpenAI preserves usage without usable output for ${name}`, async (t) => {
    const client = new OpenAIClient(options);
    t.after(() => client.close());
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    const result = await client.call('reader', '', {}, schema);
    assert.equal(result.value, null);
    assert.equal(result.inputTokens, 10);
    assert.equal(result.outputTokens, 5);
    assert.match(result.error!, /incomplete|refused/);
    assert.doesNotMatch(JSON.stringify(result), /Private provider detail|test-key-never-sent/);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

const failures: [string, () => Response, RegExp][] = [
  ...[401, 429, 404, 503].map((status): [string, () => Response, RegExp] => [
    `HTTP ${status}`,
    () => Response.json({ message: privateDetail }, { status }),
    new RegExp(`HTTP ${status}`),
  ]),
  ...(
    [
      ['credit_balance_exhausted', /API credits are exhausted/],
      ['project_spend_limit_exceeded', /spending limit reached/],
      ['insufficient_quota', /API quota is insufficient/],
      ['rate_limit_exceeded', /rate limit reached/],
    ] as const
  ).map(([code, message]): [string, () => Response, RegExp] => [
    code,
    () => Response.json({ error: { code, message: privateDetail } }, { status: 429 }),
    message,
  ]),
  ['invalid error body', () => new Response(privateDetail, { status: 429 }), /HTTP 429/],
  ['invalid envelope', () => new Response('{invalid'), /invalid JSON response/],
  [
    'network failure',
    () => {
      throw new TypeError(privateDetail);
    },
    /connection failed/,
  ],
  [
    'request timeout',
    () => {
      throw new DOMException(privateDetail, 'TimeoutError');
    },
    /timed out after 600 seconds/,
  ],
  ...(
    [
      ['body network failure', new TypeError(privateDetail), /connection failed/],
      [
        'body timeout',
        new DOMException(privateDetail, 'TimeoutError'),
        /timed out after 600 seconds/,
      ],
    ] as const
  ).map(([name, error, message]): [string, () => Response, RegExp] => [
    name,
    () =>
      Object.assign(new Response(), {
        json: async () => {
          throw error;
        },
      }),
    message,
  ]),
];

for (const [name, response, message] of failures) {
  test(`OpenAI reports ${name} without exposing provider details or retrying`, async (t) => {
    const client = new OpenAIClient(options);
    t.after(() => client.close());
    const fetch = t.mock.method(globalThis, 'fetch', async () => response());
    await assert.rejects(client.call('reader', '', {}, schema), (error: Error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /Private provider detail|test-key-never-sent/);
      return true;
    });
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('unlimited OpenAI calls disable both application and HTTP response deadlines', async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the request before responding. */
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const client = new OpenAIClient({ ...options, requestTimeoutMs: 0 });
  t.after(() => client.close());
  const port = (server.address() as { port: number }).port;
  const originalFetch = globalThis.fetch;
  t.mock.method(AbortSignal, 'timeout', () => {
    throw new Error('Unlimited calls must not create a deadline');
  });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(init.signal, undefined);
    return originalFetch(`http://127.0.0.1:${port}`, init);
  });
  const timers: { headersTimeout: number; bodyTimeout: number }[] = [];
  const requests = channel('undici:request:create');
  const observe = (event: unknown) => {
    const { request } = event as { request: { headersTimeout: number; bodyTimeout: number } };
    timers.push({ headersTimeout: request.headersTimeout, bodyTimeout: request.bodyTimeout });
  };
  requests.subscribe(observe);
  t.after(() => requests.unsubscribe(observe));
  assert.deepEqual(await client.call('reader', '', {}, schema), {
    value,
    inputTokens: 10,
    outputTokens: 5,
    usageKnown: true,
    model: 'test-model',
    responseId: undefined,
    cachedInputTokens: undefined,
    reasoningTokens: undefined,
  });
  assert.equal(timers.length, 1);
  // An absent request value inherits the dispatcher's disabled response timers.
  assert.ok(
    timers.every(
      ({ headersTimeout, bodyTimeout }) =>
        (headersTimeout == null || headersTimeout === 0) &&
        (bodyTimeout == null || bodyTimeout === 0),
    ),
  );
});
