// Select structural fields before any telemetry reaches durable local storage.
import { randomUUID } from 'node:crypto';

const attributeNames = new Set(
  `event.name event.id event_id name kind event.kind
session.id conversation.id conversation_id parent_session.id parent_session_id parent_thread_id
agent_type user.email team.id department terminal.type prompt.id turn.id turn_id
request.id request_id response.id response_id project.id project_id work_item.id work_item_id
run.id run_id parent_run.id parent_run_id originator service.name service.version
model tool_name tool success duration_ms duration.ms decision source
input_tokens input_token_count tokens.input cached_input_tokens cached_input_token_count
cached_token_count tokens.cached_input output_tokens output_token_count tokens.output
cost_usd cost.usage status_code status attempt server_name state type token_type`.split(/\s+/),
);

function pick(value, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => ['string', 'number', 'boolean'].includes(typeof value?.[key]))
      .map((key) => [key, typeof value[key] === 'string' ? value[key].slice(0, 300) : value[key]]),
  );
}

function sessionSource(text) {
  if (typeof text !== 'string') return undefined;
  if (!text.startsWith('{')) return text.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
  try {
    const value = JSON.parse(text);
    if (value.internal)
      return JSON.stringify({ internal: value.internal === 'guardian' ? 'guardian' : 'internal' });
    if (value.subagent) {
      const spawn = value.subagent.thread_spawn;
      return JSON.stringify({
        subagent:
          typeof value.subagent === 'string'
            ? value.subagent.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80)
            : {
                other: value.subagent.other === 'guardian' ? 'guardian' : undefined,
                thread_spawn: spawn
                  ? {
                      parent_thread_id:
                        typeof spawn.parent_thread_id === 'string'
                          ? spawn.parent_thread_id.replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 200)
                          : undefined,
                      agent_role:
                        typeof spawn.agent_role === 'string'
                          ? spawn.agent_role.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 80)
                          : undefined,
                    }
                  : undefined,
              },
      });
    }
  } catch {
    /* Unknown source metadata is not retained. */
  }
  return undefined;
}

function attrs(values) {
  return (Array.isArray(values) ? values : []).flatMap(({ key, value } = {}) => {
    if (key === 'session_source') {
      const source = sessionSource(value?.stringValue);
      return source ? [{ key, value: { stringValue: source } }] : [];
    }
    if (!attributeNames.has(key)) return [];
    const safeValue = {};
    if (typeof value?.stringValue === 'string')
      safeValue.stringValue = value.stringValue.slice(0, 300);
    if (typeof value?.boolValue === 'boolean') safeValue.boolValue = value.boolValue;
    if (typeof value?.doubleValue === 'number' && Number.isFinite(value.doubleValue))
      safeValue.doubleValue = value.doubleValue;
    if (/^-?\d+$/.test(String(value?.intValue))) safeValue.intValue = String(value.intValue);
    return Object.keys(safeValue).length ? [{ key, value: safeValue }] : [];
  });
}

const hookFields =
  `event session_id parent_session_id session_role agent_type prompt_id user provider
client team_id department repo branch ticket project_id work_item_id run_id parent_run_id cwd tool_name`.split(
    /\s+/,
  );

export function safeTelemetry(path, body) {
  if (path === '/activity') {
    const payload = {};
    for (const key of hookFields) {
      if (typeof body[key] === 'string')
        payload[key] = body[key].slice(0, key === 'cwd' ? 2000 : 300);
    }
    payload.event_id =
      typeof body.event_id === 'string' && body.event_id.length <= 160
        ? body.event_id
        : randomUUID();
    payload.timestamp =
      Number.isSafeInteger(body.timestamp) && body.timestamp > 0 && body.timestamp <= Date.now()
        ? body.timestamp
        : Date.now();
    return payload;
  }
  const logs = path === '/v1/logs';
  const resourceKey = logs ? 'resourceLogs' : 'resourceMetrics';
  const scopeKey = logs ? 'scopeLogs' : 'scopeMetrics';
  return {
    [resourceKey]: body[resourceKey].map((resource) => ({
      resource: { attributes: attrs(resource.resource?.attributes) },
      [scopeKey]: resource[scopeKey].map((scope) => ({
        scope: {
          ...pick(scope.scope, ['name', 'version']),
          ...(scope.scope?.attributes ? { attributes: attrs(scope.scope.attributes) } : {}),
        },
        ...(logs
          ? {
              logRecords: scope.logRecords.map((record) => ({
                ...pick(record, ['timeUnixNano', 'observedTimeUnixNano', 'traceId', 'spanId']),
                attributes: attrs(record.attributes),
                ...(typeof record.body?.stringValue === 'string' &&
                /^(codex|claude_code)\.[a-z_]+$/.test(record.body.stringValue)
                  ? { body: { stringValue: record.body.stringValue } }
                  : {}),
              })),
            }
          : {
              metrics: scope.metrics.map((metric) => ({
                name: metric.name,
                ...Object.fromEntries(
                  ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']
                    .filter((type) => metric[type])
                    .map((type) => [
                      type,
                      {
                        ...pick(metric[type], ['aggregationTemporality', 'isMonotonic']),
                        dataPoints: metric[type].dataPoints.map((point) => ({
                          ...pick(point, [
                            'startTimeUnixNano',
                            'timeUnixNano',
                            'asInt',
                            'asDouble',
                            'sum',
                            'count',
                          ]),
                          attributes: attrs(point.attributes),
                        })),
                      },
                    ]),
                ),
              })),
            }),
      })),
    })),
  };
}
