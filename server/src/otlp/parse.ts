// Parse OTLP/JSON (protobuf-JSON) payloads from Claude Code and Codex into
// normalized AgentEvents. Unknown fields are ignored, never thrown on.
import { createHash } from 'node:crypto';
import { sourceMetadata, safeId, safeLabel } from '../session-metadata.js';
import type {
  AgentClient,
  AgentEvent,
  AgentProvider,
  EventKind,
  MetricTemporality,
} from '../types.js';

let seq = 0;
function nextId(): string {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(ordered);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, ordered(item)]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
}

function unixNano(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const text = String(value);
  return /^\d+$/.test(text) && BigInt(text) > 0n ? text : undefined;
}

function temporality(value: unknown): MetricTemporality {
  if (value === 1 || value === '1' || value === 'AGGREGATION_TEMPORALITY_DELTA') {
    return 'delta';
  }
  if (value === 2 || value === '2' || value === 'AGGREGATION_TEMPORALITY_CUMULATIVE') {
    return 'cumulative';
  }
  return 'unspecified';
}

// OTLP AnyValue -> JS primitive.
type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
};
type KeyValue = { key: string; value?: AnyValue };

function coerce(v?: AnyValue): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue); // protojson sends int64 as string
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(coerce);
  if (v.kvlistValue) return flattenKV(v.kvlistValue.values ?? []);
  return undefined;
}

function flattenKV(kvs: KeyValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs) if (kv?.key) out[kv.key] = coerce(kv.value);
  return out;
}

function nanoToMs(nano?: string | number): number {
  if (nano === undefined) return Date.now();
  const n = typeof nano === 'string' ? Number(nano) : nano;
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1e6) : Date.now();
}

function str(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' ? v : v === undefined ? undefined : String(v);
}
function n(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  const value = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function nFirst(a: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = n(a, key);
    if (value !== undefined) return value;
  }
  return undefined;
}
function tokenCount(a: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = nFirst(a, ...keys);
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}
function truthy(a: Record<string, unknown>, k: string): boolean | undefined {
  const value = a[k];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function safeToolSummary(toolName?: string): string | undefined {
  if (!toolName) return undefined;
  if (toolName === 'Bash' || toolName === 'exec_command' || toolName === 'write_stdin') {
    return 'Terminal command';
  }
  if (toolName === 'apply_patch' || toolName === 'Edit' || toolName === 'Write') {
    return 'File edit';
  }
  if (toolName.startsWith('mcp__')) {
    const integration = toolName
      .split('__')[1]
      ?.replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 32);
    return integration ? `Integration: ${integration}` : 'Integration';
  }
  return toolName.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 64) || 'Tool';
}

// Claude Code event.name (e.g. "claude_code.api_request") -> our EventKind.
const KIND_BY_EVENT: Record<string, EventKind> = {
  'claude_code.user_prompt': 'user_prompt',
  'claude_code.tool_result': 'tool_result',
  'claude_code.tool_decision': 'tool_decision',
  'claude_code.api_request': 'api_request',
  'claude_code.api_error': 'api_error',
  'claude_code.mcp_server_connection': 'mcp_connection',
  'codex.conversation_starts': 'activity',
  'codex.user_prompt': 'user_prompt',
  'codex.tool_result': 'tool_result',
  'codex.tool_decision': 'tool_decision',
  'codex.api_request': 'api_request',
};

function providerFor(eventName?: string, metricName?: string): AgentProvider {
  return eventName?.startsWith('codex.') || metricName?.startsWith('codex.') ? 'codex' : 'claude';
}

function clientFrom(
  resAttrs: Record<string, unknown>,
  attrs: Record<string, unknown>,
): AgentClient | undefined {
  const sources = [
    attrs.originator,
    resAttrs.originator,
    attrs.session_source,
    resAttrs.session_source,
    resAttrs['service.name'],
  ];
  for (const value of sources) {
    if (typeof value !== 'string' || value.startsWith('{')) continue;
    const source = value.toLowerCase();
    if (source.includes('vscode') || source.includes('ide')) return 'vscode';
    if (source.includes('desktop') || source.includes('app')) return 'desktop';
    if (source.includes('cli') || source.includes('tui') || source.includes('exec')) return 'cli';
  }
  return sources.some(Boolean) ? 'unknown' : undefined;
}

function identityFrom(resAttrs: Record<string, unknown>, attrs: Record<string, unknown>) {
  const metadata = sourceMetadata(attrs.session_source ?? resAttrs.session_source);
  const parentSessionId =
    safeId(
      attrs['parent_session.id'] ??
        attrs.parent_session_id ??
        attrs.parent_thread_id ??
        resAttrs.parent_thread_id,
    ) ?? metadata.parentSessionId;
  return {
    ...metadata,
    sessionSource:
      typeof (attrs.session_source ?? resAttrs.session_source) === 'string' &&
      !String(attrs.session_source ?? resAttrs.session_source).startsWith('{')
        ? safeLabel(attrs.session_source ?? resAttrs.session_source)
        : undefined,
    parentSessionId,
    sessionRole:
      metadata.sessionRole ?? (parentSessionId ? ('subagent' as const) : ('unknown' as const)),
    agentType: safeLabel(attrs.agent_type) ?? metadata.agentType,
    userEmail: str(attrs, 'user.email') ?? str(resAttrs, 'user.email'),
    teamId: str(resAttrs, 'team.id') ?? str(attrs, 'team.id'),
    department: str(resAttrs, 'department') ?? str(attrs, 'department'),
    terminalType: str(attrs, 'terminal.type'),
    sessionId:
      str(attrs, 'session.id') ??
      str(resAttrs, 'session.id') ??
      str(attrs, 'conversation.id') ??
      str(attrs, 'conversation_id') ??
      str(resAttrs, 'conversation.id') ??
      str(resAttrs, 'conversation_id'),
    promptId: str(attrs, 'prompt.id') ?? str(attrs, 'turn.id') ?? str(attrs, 'turn_id'),
    requestId: str(attrs, 'request.id') ?? str(attrs, 'request_id'),
    responseId: str(attrs, 'response.id') ?? str(attrs, 'response_id'),
    projectId: str(attrs, 'project.id') ?? str(attrs, 'project_id') ?? str(resAttrs, 'project.id'),
    workItemId:
      str(attrs, 'work_item.id') ?? str(attrs, 'work_item_id') ?? str(resAttrs, 'work_item.id'),
    runId: str(attrs, 'run.id') ?? str(attrs, 'run_id') ?? str(resAttrs, 'run.id'),
    parentRunId:
      str(attrs, 'parent_run.id') ?? str(attrs, 'parent_run_id') ?? str(resAttrs, 'parent_run.id'),
    client: clientFrom(resAttrs, attrs),
  };
}

/** Parse an OTLP/JSON ExportLogsServiceRequest into AgentEvents. */
export function parseLogs(body: unknown): AgentEvent[] {
  const events: AgentEvent[] = [];
  const resourceLogs = (body as any)?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return events;

  for (const rl of resourceLogs) {
    const resAttrs = flattenKV(rl?.resource?.attributes ?? []);
    for (const sl of rl?.scopeLogs ?? []) {
      for (const rec of sl?.logRecords ?? []) {
        const attrs = flattenKV(rec?.attributes ?? []);
        const eventName =
          str(attrs, 'event.name') ??
          (typeof rec?.body?.stringValue === 'string' ? rec.body.stringValue : undefined) ??
          str(attrs, 'name');
        const codexStreamKind = str(attrs, 'kind') ?? str(attrs, 'event.kind');
        const isResponseUsage =
          (eventName === 'codex.sse_event' || eventName === 'codex.websocket_event') &&
          codexStreamKind === 'response.completed';
        const kind = isResponseUsage
          ? 'api_request'
          : eventName
            ? KIND_BY_EVENT[eventName]
            : undefined;
        if (!kind) continue; // ignore log records we don't model

        const id = identityFrom(resAttrs, attrs);
        let effectiveKind = kind;
        if (eventName === 'codex.api_request' && truthy(attrs, 'success') === false) {
          effectiveKind = 'api_error';
        }
        const ev: AgentEvent = {
          id: nextId(),
          ts: nanoToMs(rec?.timeUnixNano ?? rec?.observedTimeUnixNano),
          kind: effectiveKind,
          provider: providerFor(eventName),
          ...id,
        };

        switch (effectiveKind) {
          case 'activity':
            ev.subtype = 'session_start';
            ev.model = str(attrs, 'model') ?? str(resAttrs, 'model');
            break;
          case 'tool_result':
            ev.toolName = safeToolSummary(
              str(attrs, 'tool_name') ?? str(attrs, 'tool') ?? str(attrs, 'name'),
            );
            ev.success = truthy(attrs, 'success');
            ev.durationMs = nFirst(attrs, 'duration_ms', 'duration.ms');
            break;
          case 'tool_decision':
            ev.toolName = safeToolSummary(
              str(attrs, 'tool_name') ?? str(attrs, 'tool') ?? str(attrs, 'name'),
            );
            {
              const decision = str(attrs, 'decision')?.toLowerCase();
              ev.decision =
                decision === 'approved' || decision === 'approve' || decision === 'accept'
                  ? 'accept'
                  : decision === 'denied' || decision === 'deny' || decision === 'reject'
                    ? 'reject'
                    : undefined;
            }
            ev.decisionSource = str(attrs, 'source');
            break;
          case 'api_request':
            ev.model = str(attrs, 'model') ?? str(resAttrs, 'model');
            ev.inputTokens = tokenCount(attrs, 'input_tokens', 'input_token_count', 'tokens.input');
            ev.cachedInputTokens = tokenCount(
              attrs,
              'cached_input_tokens',
              'cached_input_token_count',
              'cached_token_count',
              'tokens.cached_input',
            );
            ev.outputTokens = tokenCount(
              attrs,
              'output_tokens',
              'output_token_count',
              'tokens.output',
            );
            ev.costUsd = nFirst(attrs, 'cost_usd', 'cost.usage');
            ev.durationMs = nFirst(attrs, 'duration_ms', 'duration.ms');
            ev.statusCode = nFirst(attrs, 'status_code', 'status');
            ev.usageOrigin = isResponseUsage ? 'response' : 'request';
            break;
          case 'api_error':
            ev.statusCode = nFirst(attrs, 'status_code', 'status');
            ev.attempt = n(attrs, 'attempt');
            ev.model = str(attrs, 'model') ?? str(resAttrs, 'model');
            ev.durationMs = nFirst(attrs, 'duration_ms', 'duration.ms');
            break;
          case 'mcp_connection':
            ev.mcpServer = str(attrs, 'server_name') ?? str(attrs, 'name');
            ev.mcpState = str(attrs, 'state') ?? str(attrs, 'status');
            break;
          case 'user_prompt':
            if (ev.provider === 'claude' && ev.sessionRole === 'unknown') ev.sessionRole = 'main';
            // prompt.id carried in identity; length is non-sensitive
            break;
        }
        const sourceId = str(attrs, 'event.id') ?? str(attrs, 'event_id');
        const timestamp = unixNano(rec?.timeUnixNano ?? rec?.observedTimeUnixNano);
        if (sourceId || timestamp) {
          const { id: generatedId, ts: observedTs, ...stableEvent } = ev;
          ev.id = `otel-log:${fingerprint(
            sourceId
              ? {
                  provider: ev.provider,
                  sessionId: ev.sessionId,
                  sourceId,
                }
              : {
                  eventName,
                  timestamp,
                  traceId: rec?.traceId,
                  spanId: rec?.spanId,
                  event: stableEvent,
                },
          )}`;
        }
        events.push(ev);
      }
    }
  }
  return events;
}

/** Parse an OTLP/JSON ExportMetricsServiceRequest into lightweight metric events. */
export function parseMetrics(body: unknown): AgentEvent[] {
  const events: AgentEvent[] = [];
  const resourceMetrics = (body as any)?.resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return events;

  for (const rm of resourceMetrics) {
    const resAttrs = flattenKV(rm?.resource?.attributes ?? []);
    for (const sm of rm?.scopeMetrics ?? []) {
      for (const metric of sm?.metrics ?? []) {
        const name: string | undefined = metric?.name;
        if (!name) continue;
        const dps =
          metric?.sum?.dataPoints ??
          metric?.gauge?.dataPoints ??
          metric?.histogram?.dataPoints ??
          [];
        for (const dp of dps) {
          const attrs = flattenKV(dp?.attributes ?? []);
          const id = identityFrom(resAttrs, attrs);
          const value =
            dp?.asDouble !== undefined
              ? Number(dp.asDouble)
              : dp?.asInt !== undefined
                ? Number(dp.asInt)
                : dp?.sum !== undefined
                  ? Number(dp.sum)
                  : undefined;
          const startTime = unixNano(dp?.startTimeUnixNano);
          const endTime = unixNano(dp?.timeUnixNano);
          const seriesId = fingerprint({
            resource: resAttrs,
            scope: {
              name: sm?.scope?.name,
              version: sm?.scope?.version,
              attributes: flattenKV(sm?.scope?.attributes ?? []),
            },
            metric: name,
            attributes: attrs,
          });
          const ev: AgentEvent = {
            id: nextId(),
            ts: nanoToMs(dp?.timeUnixNano),
            kind: 'metric',
            provider: providerFor(undefined, name),
            metricName: name,
            metricValue:
              value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined,
            tokenType: str(attrs, 'type') ?? str(attrs, 'token_type'),
            metricTemporality: temporality(metric?.sum?.aggregationTemporality),
            metricSeriesId: seriesId,
            metricStartTimeUnixNano: startTime,
            metricEndTimeUnixNano: endTime,
            model: str(attrs, 'model'),
            ...id,
          };
          if (endTime) {
            ev.id = `otel-metric:${fingerprint({ seriesId, startTime, endTime, value, temporality: ev.metricTemporality })}`;
          }
          events.push(ev);
        }
      }
    }
  }
  return events;
}
