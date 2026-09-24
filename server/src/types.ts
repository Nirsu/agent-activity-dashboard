// Shared domain types for the ingestion server.
// The UI re-exports the WS contract (ServerMessage) from this module.
import type { ModelPrice } from './model-cost.js';

export type EventKind =
  | 'user_prompt' // OTel  claude_code.user_prompt
  | 'tool_result' // OTel  claude_code.tool_result
  | 'tool_decision' // OTel  claude_code.tool_decision
  | 'api_request' // OTel  claude_code.api_request
  | 'api_error' // OTel  claude_code.api_error
  | 'mcp_connection' // OTel  claude_code.mcp_server_connection
  | 'metric' // OTel  metric datapoint (e.g. session.count)
  | 'activity'; // hook   /activity payload

export type AgentProvider = 'claude' | 'codex';
export type AgentClient = 'cli' | 'desktop' | 'vscode' | 'unknown';
export type SessionRole = 'main' | 'subagent' | 'internal' | 'unknown';
export type MetricTemporality = 'delta' | 'cumulative' | 'unspecified';

/** Stable team identity with its display name at the time of attribution. */
export interface ActivityTeam {
  id: string;
  name: string;
}

/** A persisted counter baseline. The key includes every OTLP series dimension. */
export interface CumulativeSnapshot {
  seriesKey: string;
  provider: AgentProvider;
  sessionId: string;
  metricName: string;
  tokenType?: string;
  model?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  value: number;
  ts: number;
}

/** Nullable measurements distinguish missing telemetry from measured zero usage. */
export interface UsageDelta {
  usageId: string;
  dedupeKeys?: string[];
  source: 'claude_metrics' | 'codex_logs' | 'brain';
  ts: number;
  provider: string;
  client?: AgentClient;
  sessionId?: string;
  agent?: string;
  teamId?: string;
  teams?: ActivityTeam[];
  ticket?: string;
  repo?: string;
  projectId?: string;
  workItemId?: string;
  runId?: string;
  parentRunId?: string;
  model?: string;
  metricName?: string;
  dUsd: number | null;
  dTokensIn: number | null;
  dTokensOut: number | null;
  cachedInputTokens?: number;
  costOrigin?: 'reported' | 'model' | 'historical_estimate';
  costEstimate?: {
    at: string;
    method: 'configured-rate-backfill';
    priceVersion: { at: number; rates: ModelPrice };
    historicalRateVerified: boolean;
    missingCacheAssumedZero: boolean;
  };
  costStatus: 'measured' | 'estimated' | 'unknown';
  cumulative?: CumulativeSnapshot;
}

export interface SessionUsageTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  costKnown: boolean;
  tokensKnown: boolean;
  knownCostCount?: number;
}

export interface UsageAliasUpdate {
  usageId: string;
  dedupeKeys: string[];
  // Complete the canonical observation, including corrections to a derived cost.
  measurements?: Pick<
    UsageDelta,
    | 'dUsd'
    | 'dTokensIn'
    | 'dTokensOut'
    | 'cachedInputTokens'
    | 'model'
    | 'costOrigin'
    | 'costEstimate'
  >;
}

// Lifecycle subtype for hook-sourced ('activity') events.
export type ActivitySubtype =
  | 'session_start'
  | 'prompt_submit'
  | 'pre_tool'
  | 'post_tool'
  | 'stop'
  | 'session_end'
  | 'subagent_start'
  | 'subagent_stop'
  | 'context_update';

/** A normalized, privacy-safe event. Never contains prompt or tool content. */
export interface AgentEvent {
  id: string;
  ts: number; // epoch ms
  kind: EventKind;
  subtype?: ActivitySubtype;
  provider: AgentProvider;
  client?: AgentClient;

  // correlation
  promptId?: string;
  sessionId?: string;
  rawSessionId?: string;
  parentSessionId?: string;
  rawParentSessionId?: string;
  sessionRole?: SessionRole;
  sessionSource?: string;
  agentType?: string;
  requestId?: string;
  responseId?: string;
  projectId?: string;
  workItemId?: string;
  runId?: string;
  parentRunId?: string;

  // identity / grouping
  userEmail?: string; // cleared when anonymize is on
  agent?: string; // stable pseudonym (present always; = email when not anonymized)
  teamId?: string;
  teams?: ActivityTeam[];
  department?: string;
  terminalType?: string;

  // tool events
  toolName?: string;
  success?: boolean;
  durationMs?: number;
  decision?: 'accept' | 'reject';
  decisionSource?: string;

  // api events
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  usageOrigin?: 'request' | 'response';
  statusCode?: number;
  attempt?: number;

  // metric events
  metricName?: string;
  metricValue?: number;
  tokenType?: string; // token.usage: input | output | cacheRead | cacheCreation
  metricTemporality?: MetricTemporality;
  metricSeriesId?: string;
  metricStartTimeUnixNano?: string;
  metricEndTimeUnixNano?: string;

  // mcp connection
  mcpServer?: string;
  mcpState?: string;

  // hook / local context
  repo?: string;
  branch?: string;
  ticket?: string;
  ticketTitle?: string;
  cwd?: string;
}

export type SessionStatus = 'idle' | 'thinking' | 'tool';

export interface SessionState {
  sessionId: string;
  rawSessionId?: string;
  parentSessionId?: string;
  sessionRole?: SessionRole;
  sessionSource?: string;
  agentType?: string;
  endedAt?: number;
  provider: AgentProvider;
  model?: string;
  client?: AgentClient;
  teamId?: string;
  teams?: ActivityTeam[];
  department?: string;
  userEmail?: string;
  agent?: string; // stable pseudonym for directory/map grouping
  repo?: string;
  branch?: string;
  ticket?: string;
  ticketTitle?: string;
  cwd?: string;
  projectId?: string;
  workItemId?: string;
  runId?: string;
  parentRunId?: string;

  status: SessionStatus;
  currentTool?: string;
  currentPromptId?: string;

  turnStartedAt?: number; // epoch ms of current turn
  turnTokens: number; // input+output tokens this turn (from api_request logs, if any)
  turnCostUsd: number; // cost this turn (from api_request logs, if any)

  sessionTokens: number; // cumulative tokens this session (from token.usage metrics)
  sessionCostUsd: number; // cumulative cost this session (from cost.usage metrics)
  costKnown: boolean;
  tokensKnown: boolean;

  promptCount: number; // prompts this session
  lastEventAt: number;
  startedAt: number;
}

export interface Aggregate {
  activeSessions: number;
  promptsLastHour: number;
  costTodayUsd: number;
  tokensTodayInput: number;
  tokensTodayOutput: number;
  costKnown: boolean;
  tokensKnown: boolean;
  unknownUsageCount: number;
  editWriteAccepts: number;
  editWriteRejects: number;
  recentErrors: Array<{
    ts: number;
    statusCode?: number;
    model?: string;
    teamId?: string;
  }>;
}

export type ProviderAggregates = Record<AgentProvider, Aggregate>;

// ---- WebSocket contract (server -> client) ----

export interface SnapshotMessage {
  type: 'snapshot';
  sessions: SessionState[];
  aggregate: Aggregate;
  providerAggregates?: ProviderAggregates;
  recentEvents: AgentEvent[];
}
export interface EventMessage {
  type: 'event';
  event: AgentEvent;
}
export interface SessionsMessage {
  type: 'sessions';
  sessions: SessionState[];
  aggregate: Aggregate;
  providerAggregates?: ProviderAggregates;
}

export type ServerMessage = SnapshotMessage | EventMessage | SessionsMessage;
