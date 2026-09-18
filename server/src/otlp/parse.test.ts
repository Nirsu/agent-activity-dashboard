import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogs, parseMetrics } from './parse.js';

function s(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function i(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}

function b(key: string, value: boolean) {
  return { key, value: { boolValue: value } };
}

function logs(eventName: string, attributes: unknown[], resourceAttributes: unknown[] = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1785240000000000000',
                attributes: [s('event.name', eventName), ...attributes],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('Codex source metadata distinguishes internal checks and explicit parent links without prompt content', () => {
  const [internal] = parseLogs(
    logs('codex.user_prompt', [
      s('conversation.id', 'check'),
      s('session_source', 'guardian'),
      s('prompt', 'never retain this'),
      s('parent_thread_id', 'parent'),
    ]),
  );
  assert.equal(internal.sessionRole, 'internal');
  assert.equal(internal.parentSessionId, 'parent');
  assert.equal(internal.agentType, 'Approval check');
  assert.doesNotMatch(JSON.stringify(internal), /never retain/);
  const [child] = parseLogs(
    logs('codex.api_request', [
      s('conversation.id', 'child'),
      s(
        'session_source',
        JSON.stringify({
          subagent: { thread_spawn: { parent_thread_id: 'root', agent_role: 'explorer' } },
        }),
      ),
    ]),
  );
  assert.equal(child.sessionRole, 'subagent');
  assert.equal(child.parentSessionId, 'root');
  const [unknown] = parseLogs(
    logs('codex.api_request', [
      s('conversation.id', 'other'),
      s('session_source', 'future-client'),
    ]),
  );
  assert.equal(unknown.sessionRole, 'unknown');
  assert.equal(unknown.parentSessionId, undefined);
});

test('keeps Claude parsing backward compatible and marks its provider', () => {
  const [event] = parseLogs(
    logs('claude_code.api_request', [
      s('session.id', 'claude-session'),
      s('model', 'claude-model'),
      i('input_tokens', 12),
      i('output_tokens', 7),
    ]),
  );

  assert.equal(event.provider, 'claude');
  assert.equal(event.kind, 'api_request');
  assert.equal(event.sessionId, 'claude-session');
  assert.equal(event.inputTokens, 12);
  assert.equal(event.outputTokens, 7);
});

test('normalizes Codex OTLP events without retaining prompt or tool content', () => {
  const [prompt] = parseLogs(
    logs(
      'codex.user_prompt',
      [
        s('conversation.id', 'codex-session'),
        s('turn.id', 'turn-1'),
        s('prompt', 'private source code must not survive'),
      ],
      [s('service.name', 'codex_cli_rs'), s('session_source', 'cli')],
    ),
  );
  const [tool] = parseLogs(
    logs('codex.tool_result', [
      s('conversation.id', 'codex-session'),
      s('tool', 'apply_patch'),
      b('success', true),
      s('output', 'secret tool output must not survive'),
      i('duration_ms', 42),
    ]),
  );

  assert.equal(prompt.provider, 'codex');
  assert.equal(prompt.client, 'cli');
  assert.equal(prompt.kind, 'user_prompt');
  assert.equal(prompt.sessionId, 'codex-session');
  assert.equal(prompt.promptId, 'turn-1');
  assert.equal(tool.provider, 'codex');
  assert.equal(tool.toolName, 'File edit');
  assert.equal(tool.success, true);
  assert.equal(tool.durationMs, 42);
  assert.doesNotMatch(JSON.stringify([prompt, tool]), /private source|secret tool output/);
});

test('maps failed Codex API requests to dashboard errors', () => {
  const [event] = parseLogs(
    logs('codex.api_request', [
      s('conversation_id', 'codex-session'),
      s('model', 'gpt-test'),
      b('success', false),
      i('status_code', 429),
      i('duration_ms', 150),
    ]),
  );

  assert.equal(event.kind, 'api_error');
  assert.equal(event.provider, 'codex');
  assert.equal(event.statusCode, 429);
});

test('marks Codex metrics with their provider and client', () => {
  const [event] = parseMetrics({
    resourceMetrics: [
      {
        resource: { attributes: [s('service.name', 'codex_vscode')] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'codex.tool.call',
                sum: {
                  dataPoints: [
                    {
                      asInt: '3',
                      attributes: [s('conversation.id', 'codex-session')],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(event.provider, 'codex');
  assert.equal(event.client, 'vscode');
  assert.equal(event.metricName, 'codex.tool.call');
});

test('recognizes both desktop websocket and SSE completed-response usage', () => {
  for (const name of ['codex.websocket_event', 'codex.sse_event']) {
    const [event] = parseLogs(
      logs(
        name,
        [
          s('kind', 'response.completed'),
          s('conversation.id', 'desktop-session'),
          s('request_id', 'request-1'),
          s('response_id', 'response-1'),
          i('input_token_count', 90),
          i('cached_token_count', 20),
          i('output_token_count', 12),
          s('project.id', 'harmonie'),
          s('work_item.id', 'HM-4'),
          s('run.id', 'coding-run'),
          s('parent_run.id', 'workflow-run'),
        ],
        [s('session_source', 'desktop')],
      ),
    );
    assert.equal(event.kind, 'api_request');
    assert.equal(event.usageOrigin, 'response');
    assert.equal(event.client, 'desktop');
    assert.equal(event.requestId, 'request-1');
    assert.equal(event.responseId, 'response-1');
    assert.equal(event.inputTokens, 90);
    assert.equal(event.cachedInputTokens, 20);
    assert.equal(event.outputTokens, 12);
    assert.equal(event.costUsd, undefined);
    assert.equal(event.projectId, 'harmonie');
    assert.equal(event.workItemId, 'HM-4');
    assert.equal(event.runId, 'coding-run');
    assert.equal(event.parentRunId, 'workflow-run');
  }
});

test('uses stable replay IDs without retaining sensitive fields or collapsing distinct timestamps', () => {
  const body = logs('codex.api_request', [
    s('conversation.id', 'stable-session'),
    s('prompt', 'do not retain this prompt'),
    s('authorization', 'do not retain credentials'),
    i('input_token_count', 10),
  ]);
  const [first] = parseLogs(body);
  const [replayed] = parseLogs(body);
  assert.equal(first.id, replayed.id);
  const later = structuredClone(body);
  later.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = '1785240000000000001';
  assert.notEqual(parseLogs(later)[0].id, first.id);
  assert.doesNotMatch(JSON.stringify(first), /do not retain|authorization|credentials/);
});

test('keeps explicit zero but rejects invalid, infinite and negative usage', () => {
  const [event] = parseLogs(
    logs('codex.api_request', [
      s('cost_usd', 'Infinity'),
      i('input_token_count', -5),
      i('output_token_count', 0),
    ]),
  );
  assert.equal(event.costUsd, undefined);
  assert.equal(event.inputTokens, undefined);
  assert.equal(event.outputTokens, 0);
  const [fractional] = parseLogs(logs('codex.api_request', [s('input_token_count', '2.5')]));
  assert.equal(fractional.inputTokens, undefined);
});

test('uses explicit source event IDs even when an exporter changes the observed timestamp', () => {
  const body = logs('codex.api_request', [
    s('event.id', 'unique-event'),
    s('conversation.id', 'session'),
    i('input_token_count', 5),
  ]);
  const [original] = parseLogs(body);
  body.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = '1785240000000000123';
  assert.equal(parseLogs(body)[0].id, original.id);
});

test('preserves metric temporality and reset timestamps, with distinct model series', () => {
  const point = {
    startTimeUnixNano: '1785240000000000000',
    timeUnixNano: '1785240100000000000',
    asDouble: 2,
    attributes: [s('session.id', 'session'), s('model', 'model-a'), s('type', 'input')],
  };
  const body = {
    resourceMetrics: [
      {
        resource: { attributes: [s('service.name', 'claude-code')] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: { aggregationTemporality: 1, dataPoints: [point] },
              },
            ],
          },
        ],
      },
    ],
  };
  const [first] = parseMetrics(body);
  assert.equal(first.metricTemporality, 'delta');
  assert.equal(first.metricStartTimeUnixNano, point.startTimeUnixNano);
  assert.equal(first.metricEndTimeUnixNano, point.timeUnixNano);
  assert.equal(parseMetrics(body)[0].id, first.id);

  const reordered = structuredClone(body);
  reordered.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.reverse();
  assert.equal(parseMetrics(reordered)[0].metricSeriesId, first.metricSeriesId);

  const otherModel = structuredClone(body);
  otherModel.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes[1] = s(
    'model',
    'model-b',
  );
  assert.notEqual(parseMetrics(otherModel)[0].metricSeriesId, first.metricSeriesId);

  body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 2;
  assert.equal(parseMetrics(body)[0].metricTemporality, 'cumulative');
});
