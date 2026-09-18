import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  AgentProvider,
  Aggregate,
  CumulativeSnapshot,
  SessionState,
  SessionStatus,
  SessionUsageTotals,
  UsageDelta,
  ProviderAggregates,
} from '../types.js';
import { config } from '../config.js';
import { agentLabel } from '../identity.js';
import { UsageAccounting } from './accounting.js';
import {
  PromptTracker,
  PROMPT_WINDOW_MS,
  PROMPT_PAIR_WINDOW_MS,
  type PromptMatch,
} from './prompts.js';
import { groupSessions } from '../session-hierarchy.js';

function startOfLocalDay(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function emptyTotals(): SessionUsageTotals {
  return { costUsd: 0, tokensIn: 0, tokensOut: 0, costKnown: false, tokensKnown: false };
}

function emptyProviderAggregate(): Aggregate {
  return {
    activeSessions: 0,
    promptsLastHour: 0,
    costTodayUsd: 0,
    tokensTodayInput: 0,
    tokensTodayOutput: 0,
    costKnown: false,
    tokensKnown: false,
    unknownUsageCount: 0,
    editWriteAccepts: 0,
    editWriteRejects: 0,
    recentErrors: [],
  };
}

/**
 * Live projections of normalized events. Accounting emits one `usage` delta per
 * canonical observation; `cumulative` carries counter baselines, including flat
 * samples. Persist usage and its attached baseline in the same transaction.
 */
export class Store extends EventEmitter {
  private ring: AgentEvent[] = [];
  private sessions = new Map<string, SessionState>();
  private sessionContext = new Map<string, SessionState>();
  private usageContexts = new Map<
    string,
    Array<{ ts: number; key: string; context: SessionState }>
  >();
  private sessionTotals = new Map<string, SessionUsageTotals>();
  private endedSessions = new Set<string>();
  private stoppedTurns = new Set<string>();
  private accounting = new UsageAccounting();
  private prompts = new PromptTracker();
  private seenEvents = new Set<string>();
  private externalUsageIds = new Map<string, number>();
  private agentBySession = new Map<string, string>();
  private sessionLastSeen = new Map<string, number>();
  private nextPruneAt = 0;

  private dayStart = startOfLocalDay();
  private costTodayUsd = 0;
  private tokensInToday = 0;
  private tokensOutToday = 0;
  private costKnown = false;
  private knownCostCount = 0;
  private providerKnownCostCounts = { claude: 0, codex: 0 };
  private tokensKnown = false;
  private unknownUsageCount = 0;
  private editWriteAccepts = 0;
  private editWriteRejects = 0;
  private providerTotals: ProviderAggregates = {
    claude: emptyProviderAggregate(),
    codex: emptyProviderAggregate(),
  };
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    super();
    this.sweepTimer = setInterval(() => this.sweep(), 5_000);
    this.sweepTimer.unref();
  }

  close(): void {
    clearInterval(this.sweepTimer);
    this.removeAllListeners();
  }

  restoreCumulative(snapshots: Map<string, CumulativeSnapshot>): void {
    this.accounting.restoreCumulative(snapshots);
  }

  restoreUsageIds(ids: Iterable<string>): void {
    const restored = [...ids];
    this.accounting.restoreUsageIds(restored);
    this.externalUsageIds = new Map(restored.map((id) => [id, Date.now()]));
  }

  restoreUsageIdentityMap(identities: Map<string, string>): void {
    this.accounting.restoreUsageIdentityMap(identities);
  }

  restoreRequestUsage(observations: UsageDelta[]): void {
    this.accounting.restoreRequestUsage(observations);
  }

  restoreSessionTotals(totals: Map<string, SessionUsageTotals>): void {
    this.sessionTotals = new Map(totals);
    for (const id of totals.keys()) {
      this.sessionLastSeen.set(id, Date.now());
    }
  }

  restorePrompts(events: AgentEvent[]): void {
    for (const event of events) {
      this.prompts.record(event);
    }
  }

  hydrateToday(
    totals: {
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
      costKnown?: boolean;
      knownCostCount?: number;
      tokensKnown?: boolean;
      unknownUsageCount?: number;
    },
    provider?: AgentProvider,
  ): void {
    this.dayStart = startOfLocalDay();
    if (provider) {
      this.providerKnownCostCounts[provider] =
        totals.knownCostCount ?? Number(totals.costKnown ?? totals.costUsd > 0);
      Object.assign(this.providerTotals[provider], {
        costTodayUsd: totals.costUsd,
        tokensTodayInput: totals.tokensIn,
        tokensTodayOutput: totals.tokensOut,
        costKnown: totals.costKnown ?? totals.costUsd > 0,
        tokensKnown: totals.tokensKnown ?? totals.tokensIn + totals.tokensOut > 0,
        unknownUsageCount: totals.unknownUsageCount ?? 0,
      });
      return;
    }
    this.costTodayUsd = totals.costUsd;
    this.knownCostCount = totals.knownCostCount ?? Number(totals.costKnown ?? totals.costUsd > 0);
    this.tokensInToday = totals.tokensIn;
    this.tokensOutToday = totals.tokensOut;
    this.costKnown = totals.costKnown ?? totals.costUsd > 0;
    this.tokensKnown = totals.tokensKnown ?? totals.tokensIn + totals.tokensOut > 0;
    this.unknownUsageCount = totals.unknownUsageCount ?? 0;
  }

  /** Called after a Brain usage record is durably inserted; never creates a session. */
  ingestExternalUsage(usage: UsageDelta): void {
    if (usage.ts < this.retentionCutoff() || this.externalUsageIds.has(usage.usageId)) {
      return;
    }
    this.externalUsageIds.set(usage.usageId, usage.ts);
    this.rolloverDayIfNeeded();
    this.applyUsageToDay(usage);
    this.emit('sessions', this.getSessions(), this.getAggregate());
  }

  ingest(input: AgentEvent): void {
    // Once deduplication state expires, replayed old exports must also expire.
    if (input.ts < this.retentionCutoff()) {
      return;
    }
    const event = this.normalizeSession(input);
    if (event.sessionId) {
      this.sessionLastSeen.set(
        event.sessionId,
        Math.max(this.sessionLastSeen.get(event.sessionId) ?? 0, event.ts),
      );
    }
    const eventKey = `${event.provider}:${event.id}`;
    if (this.seenEvents.has(eventKey)) {
      return;
    }
    this.seenEvents.add(eventKey);
    if (this.seenEvents.size > Math.max(config.ringSize * 10, 1_000)) {
      const oldest = this.seenEvents.values().next().value;
      if (oldest !== undefined) {
        this.seenEvents.delete(oldest);
      }
    }
    this.rolloverDayIfNeeded();
    this.resolveIdentity(event);
    this.ring.push(event);
    if (this.ring.length > config.ringSize) {
      this.ring.shift();
    }

    const prompt =
      event.ts >= Date.now() - PROMPT_WINDOW_MS - PROMPT_PAIR_WINDOW_MS
        ? this.prompts.record(event)
        : undefined;
    const changed = this.applyToSession(event, prompt);
    this.applyDecision(event);
    const context = this.contextForUsage(event);
    const result = this.accounting.consume(event, context);
    if (result.usage) {
      this.applyUsage(result.usage, event);
      this.emit('usage', result.usage);
    }
    if (result.cumulative && !result.usage) {
      this.emit('cumulative', result.cumulative);
    }
    if (result.completion) {
      const { previous, current } = result.completion;
      const added = {
        ...current,
        dUsd: current.dUsd !== previous.dUsd ? (current.dUsd ?? 0) - (previous.dUsd ?? 0) : null,
        dTokensIn: previous.dTokensIn === null ? current.dTokensIn : null,
        dTokensOut: previous.dTokensOut === null ? current.dTokensOut : null,
      };
      const knownCostChange = Number(current.dUsd !== null) - Number(previous.dUsd !== null);
      this.applyUsage(added, { ...event, ts: current.ts }, false, knownCostChange);
      if (knownCostChange !== 0 && startOfLocalDay(current.ts) === this.dayStart) {
        this.unknownUsageCount = Math.max(0, this.unknownUsageCount - knownCostChange);
        const provider = this.providerTotals[event.provider];
        provider.unknownUsageCount = Math.max(0, provider.unknownUsageCount - knownCostChange);
      }
    }
    if (result.aliases) {
      this.emit('usage_aliases', result.aliases);
    }
    this.emit('event', event);
    if (changed || result.usage || result.completion) {
      this.emit('sessions', this.getSessions(), this.getAggregate());
    }
  }

  ingestMany(events: AgentEvent[]): void {
    for (const event of events) {
      this.ingest(event);
    }
  }

  private normalizeSession(input: AgentEvent): AgentEvent {
    const event = { ...input };
    if (event.sessionId) {
      // rawSessionId marks an already normalized internal event. External raw
      // IDs remain opaque, even if one happens to begin with "codex:".
      event.rawSessionId = event.rawSessionId ?? event.sessionId;
      event.sessionId = `${event.provider}:${event.rawSessionId}`;
    }
    if (event.parentSessionId) {
      event.rawParentSessionId ??= event.parentSessionId;
      event.parentSessionId = `${event.provider}:${event.rawParentSessionId}`;
      if (event.parentSessionId === event.sessionId) event.parentSessionId = undefined;
    }
    return event;
  }

  private resolveIdentity(event: AgentEvent): void {
    if (event.userEmail) {
      event.agent = config.anonymize ? agentLabel(event.userEmail) : event.userEmail;
      if (event.sessionId) {
        this.agentBySession.set(event.sessionId, event.agent);
      }
      if (config.anonymize) {
        event.userEmail = undefined;
      }
    } else if (event.sessionId) {
      event.agent =
        this.agentBySession.get(event.sessionId) ??
        (config.anonymize ? agentLabel(undefined, event.sessionId) : undefined);
    }
  }

  private rolloverDayIfNeeded(): boolean {
    const day = startOfLocalDay();
    if (day === this.dayStart) {
      return false;
    }
    this.dayStart = day;
    this.costTodayUsd = 0;
    this.tokensInToday = 0;
    this.tokensOutToday = 0;
    this.costKnown = false;
    this.knownCostCount = 0;
    this.providerKnownCostCounts = { claude: 0, codex: 0 };
    this.tokensKnown = false;
    this.unknownUsageCount = 0;
    this.editWriteAccepts = 0;
    this.editWriteRejects = 0;
    this.providerTotals = {
      claude: emptyProviderAggregate(),
      codex: emptyProviderAggregate(),
    };
    return true;
  }

  private applyDecision(event: AgentEvent): void {
    if (
      startOfLocalDay(event.ts) !== this.dayStart ||
      event.kind !== 'tool_decision' ||
      !['Edit', 'Write', 'File edit'].includes(event.toolName ?? '')
    ) {
      return;
    }
    if (event.decision === 'accept') {
      this.editWriteAccepts++;
      this.providerTotals[event.provider].editWriteAccepts++;
    } else if (event.decision === 'reject') {
      this.editWriteRejects++;
      this.providerTotals[event.provider].editWriteRejects++;
    }
  }

  private applyUsageToDay(
    usage: UsageDelta,
    countUnknown = true,
    knownCostChange = Number(usage.dUsd !== null),
  ): void {
    // Late exports belong to their event day. They must not reset or inflate
    // today's live total; persistence still receives the original timestamp.
    if (startOfLocalDay(usage.ts) !== this.dayStart) {
      return;
    }
    if (usage.dUsd !== null) {
      this.costTodayUsd += usage.dUsd;
    } else if (countUnknown && usage.metricName !== 'claude_code.token.usage') {
      this.unknownUsageCount++;
    }
    this.knownCostCount = Math.max(0, this.knownCostCount + knownCostChange);
    this.costKnown = this.knownCostCount > 0;
    if (usage.dTokensIn !== null) {
      this.tokensInToday += usage.dTokensIn;
      this.tokensKnown = true;
    }
    if (usage.dTokensOut !== null) {
      this.tokensOutToday += usage.dTokensOut;
      this.tokensKnown = true;
    }
    if (usage.provider === 'claude' || usage.provider === 'codex') {
      const totals = this.providerTotals[usage.provider];
      if (usage.dUsd !== null) {
        totals.costTodayUsd += usage.dUsd;
      } else if (countUnknown && usage.metricName !== 'claude_code.token.usage') {
        totals.unknownUsageCount++;
      }
      this.providerKnownCostCounts[usage.provider] = Math.max(
        0,
        this.providerKnownCostCounts[usage.provider] + knownCostChange,
      );
      totals.costKnown = this.providerKnownCostCounts[usage.provider] > 0;
      if (usage.dTokensIn !== null) {
        totals.tokensTodayInput += usage.dTokensIn;
        totals.tokensKnown = true;
      }
      if (usage.dTokensOut !== null) {
        totals.tokensTodayOutput += usage.dTokensOut;
        totals.tokensKnown = true;
      }
    }
  }

  private applyUsage(
    usage: UsageDelta,
    event: AgentEvent,
    countUnknown = true,
    knownCostChange = Number(usage.dUsd !== null),
  ): void {
    this.applyUsageToDay(usage, countUnknown, knownCostChange);
    if (!usage.sessionId) {
      return;
    }
    const totals = this.sessionTotals.get(usage.sessionId) ?? emptyTotals();
    if (usage.dUsd !== null) {
      totals.costUsd += usage.dUsd;
    }
    totals.knownCostCount = Math.max(
      0,
      (totals.knownCostCount ?? Number(totals.costKnown)) + knownCostChange,
    );
    totals.costKnown = totals.knownCostCount > 0;
    if (usage.dTokensIn !== null) {
      totals.tokensIn += usage.dTokensIn;
      totals.tokensKnown = true;
    }
    if (usage.dTokensOut !== null) {
      totals.tokensOut += usage.dTokensOut;
      totals.tokensKnown = true;
    }
    this.sessionTotals.set(usage.sessionId, totals);
    const session = this.sessionContext.get(usage.sessionId);
    if (session) {
      this.refreshSessionTotals(session);
      if (
        session.turnStartedAt !== undefined &&
        event.ts >= session.turnStartedAt &&
        (event.promptId === undefined || event.promptId === session.currentPromptId)
      ) {
        session.turnCostUsd += usage.dUsd ?? 0;
        session.turnTokens += (usage.dTokensIn ?? 0) + (usage.dTokensOut ?? 0);
      }
    }
  }

  private refreshSessionTotals(session: SessionState): void {
    const totals = this.sessionTotals.get(session.sessionId) ?? emptyTotals();
    session.sessionCostUsd = totals.costUsd;
    session.sessionTokens = totals.tokensIn + totals.tokensOut;
    session.costKnown = totals.costKnown;
    session.tokensKnown = totals.tokensKnown;
  }

  private rememberContext(session: SessionState, ts: number): void {
    const entries = this.usageContexts.get(session.sessionId) ?? [];
    const key = JSON.stringify([
      session.agent,
      session.teamId,
      session.repo,
      session.branch,
      session.ticket,
      session.projectId,
      session.workItemId,
      session.runId,
      session.parentRunId,
      session.model,
    ]);
    if (entries.at(-1)?.key !== key) {
      entries.push({ ts, key, context: { ...session, lastEventAt: ts } });
      // Keep recent scope changes, not the contents of prompts or tools. Older
      // delayed usage remains unassigned when its context has been evicted.
      if (entries.length > 100) {
        entries.shift();
      }
      this.usageContexts.set(session.sessionId, entries);
    }
  }

  private contextForUsage(event: AgentEvent): SessionState | undefined {
    if (!event.sessionId) {
      return undefined;
    }
    const entries = this.usageContexts.get(event.sessionId) ?? [];
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].ts <= event.ts) {
        return entries[index].context;
      }
    }
    return undefined;
  }

  private enrich(session: SessionState, event: AgentEvent): void {
    if (event.sessionSource) session.sessionSource = event.sessionSource;
    if (event.parentSessionId) session.parentSessionId = event.parentSessionId;
    if (event.agentType) session.agentType = event.agentType;
    if (event.sessionRole && event.sessionRole !== 'unknown') {
      // A parent-side lifecycle hook may arrive after the child's own events.
      const rank = { unknown: 0, main: 1, subagent: 2, internal: 3 };
      if (rank[event.sessionRole] >= rank[session.sessionRole ?? 'unknown'])
        session.sessionRole = event.sessionRole;
    }
    if (!session.sessionRole && event.sessionRole === 'unknown') session.sessionRole = 'unknown';
    if (event.ts < session.lastEventAt) {
      return;
    }
    if (event.branch && session.branch !== event.branch) {
      session.ticket = undefined;
      session.ticketTitle = undefined;
      session.workItemId = undefined;
    }
    if (event.client) {
      session.client = event.client;
    }
    if (event.model) {
      session.model = event.model;
    }
    if (event.teamId) {
      session.teamId = event.teamId;
    }
    if (event.department) {
      session.department = event.department;
    }
    if (event.userEmail) {
      session.userEmail = event.userEmail;
    }
    if (event.agent) {
      session.agent = event.agent;
    }
    if (event.repo) {
      session.repo = event.repo;
    }
    if (event.branch) {
      session.branch = event.branch;
    }
    if (event.ticket) {
      session.ticket = event.ticket;
    }
    if (event.ticketTitle) {
      session.ticketTitle = event.ticketTitle;
    }
    if (event.cwd) {
      session.cwd = event.cwd;
    }
    if (event.projectId) {
      session.projectId = event.projectId;
    }
    if (event.workItemId) {
      session.workItemId = event.workItemId;
    }
    if (event.runId) {
      session.runId = event.runId;
    }
    if (event.parentRunId) {
      session.parentRunId = event.parentRunId;
    }
  }

  private ensureSession(event: AgentEvent): SessionState | undefined {
    if (!event.sessionId) {
      return undefined;
    }
    let session = this.sessions.get(event.sessionId);
    const explicitStart =
      event.kind === 'user_prompt' ||
      (event.kind === 'activity' &&
        ['session_start', 'prompt_submit'].includes(event.subtype ?? ''));
    if (
      !session &&
      (event.kind === 'metric' || (this.endedSessions.has(event.sessionId) && !explicitStart))
    ) {
      return undefined;
    }
    if (!session) {
      session = {
        sessionId: event.sessionId,
        rawSessionId: event.rawSessionId,
        provider: event.provider,
        client: event.client,
        status: 'idle',
        turnTokens: 0,
        turnCostUsd: 0,
        sessionTokens: 0,
        sessionCostUsd: 0,
        costKnown: false,
        tokensKnown: false,
        promptCount: 0,
        lastEventAt: event.ts,
        startedAt: event.ts,
      };
      this.refreshSessionTotals(session);
      this.sessions.set(event.sessionId, session);
      this.sessionContext.set(event.sessionId, session);
      this.endedSessions.delete(event.sessionId);
    }
    this.enrich(session, event);
    if (event.ts >= session.lastEventAt) {
      this.rememberContext(session, event.ts);
    }
    return session;
  }

  private setStatus(session: SessionState, status: SessionStatus, tool?: string): void {
    session.status = status;
    session.currentTool = status === 'tool' ? tool : undefined;
  }

  private startTurn(session: SessionState, ts: number, promptId?: string): void {
    this.stoppedTurns.delete(session.sessionId);
    session.status = 'thinking';
    session.currentTool = undefined;
    session.turnStartedAt = ts;
    session.turnTokens = 0;
    session.turnCostUsd = 0;
    session.currentPromptId = promptId;
  }

  private applyToSession(event: AgentEvent, prompt?: PromptMatch): boolean {
    // A delayed duplicate must not reopen a session closed by its lifecycle hook.
    if (prompt && !prompt.isNew && !this.sessions.has(event.sessionId ?? '')) {
      return false;
    }
    const session = this.ensureSession(event);
    if (!session) {
      return false;
    }
    if (prompt) {
      if (prompt.isNew) {
        session.promptCount++;
      }
      if (prompt.isNew && event.ts >= session.lastEventAt) {
        this.startTurn(session, prompt.prompt.ts, prompt.prompt.promptId);
      } else if (session.turnStartedAt === prompt.prompt.ts) {
        session.currentPromptId ??= prompt.prompt.promptId;
      }
      session.lastEventAt = Math.max(session.lastEventAt, event.ts);
      return true;
    }
    if (event.ts < session.lastEventAt) {
      return false;
    }
    session.lastEventAt = event.ts;
    switch (event.kind) {
      case 'user_prompt':
        return true;
      case 'api_request':
        // Delayed usage exports must not revive a turn completed by a Stop hook.
        return true;
      case 'tool_result':
        if (!session.endedAt && !this.stoppedTurns.has(session.sessionId)) {
          this.setStatus(session, 'thinking');
        }
        return true;
      case 'activity':
        return this.applyActivity(session, event);
      case 'api_error':
      case 'tool_decision':
      case 'mcp_connection':
      case 'metric':
        return true;
    }
  }

  private applyActivity(session: SessionState, event: AgentEvent): boolean {
    switch (event.subtype) {
      case 'subagent_start':
        this.stoppedTurns.delete(session.sessionId);
        session.endedAt = undefined;
        session.turnStartedAt = event.ts;
        this.setStatus(session, 'thinking');
        return true;
      case 'subagent_stop':
        this.stoppedTurns.add(session.sessionId);
        session.endedAt = event.ts;
        session.turnStartedAt = undefined;
        this.setStatus(session, 'idle');
        return true;
      case 'session_start':
        this.setStatus(session, 'idle');
        return true;
      case 'prompt_submit':
        return true;
      case 'pre_tool':
        if (!session.endedAt) {
          this.stoppedTurns.delete(session.sessionId);
          this.setStatus(session, 'tool', event.toolName);
        }
        return true;
      case 'post_tool':
        if (!session.endedAt && !this.stoppedTurns.has(session.sessionId)) {
          this.setStatus(session, 'thinking');
        }
        return true;
      case 'stop':
        this.stoppedTurns.add(session.sessionId);
        this.setStatus(session, 'idle');
        session.turnStartedAt = undefined;
        return true;
      case 'session_end':
        this.sessions.delete(session.sessionId);
        this.endedSessions.add(session.sessionId);
        return true;
      default:
        return true;
    }
  }

  private retentionCutoff(now = Date.now()): number {
    return now - config.retentionDays * 86_400_000;
  }

  private pruneRetainedState(now: number): void {
    if (now < this.nextPruneAt) {
      return;
    }
    this.nextPruneAt = now + 60_000;
    const cutoff = this.retentionCutoff(now);
    this.accounting.prune(cutoff);
    for (const [id, ts] of this.externalUsageIds) {
      if (ts < cutoff) {
        this.externalUsageIds.delete(id);
      }
    }
    for (const [id, ts] of this.sessionLastSeen) {
      if (ts >= cutoff) {
        continue;
      }
      this.sessionLastSeen.delete(id);
      this.sessionContext.delete(id);
      this.usageContexts.delete(id);
      this.sessionTotals.delete(id);
      this.endedSessions.delete(id);
      this.stoppedTurns.delete(id);
      this.agentBySession.delete(id);
    }
  }

  private sweep(): void {
    const now = Date.now();
    this.pruneRetainedState(now);
    let changed = this.rolloverDayIfNeeded();
    // Every ancestor is needed to preserve a live descendant's path to its root.
    // Walk explicit links, including unlinked families, and guard malformed cycles.
    const familyActivity = new Map<string, number>();
    for (const session of this.sessions.values()) {
      const visited = new Set<string>();
      let ancestor: SessionState | undefined = session;
      while (
        ancestor &&
        ancestor.provider === session.provider &&
        !visited.has(ancestor.sessionId)
      ) {
        visited.add(ancestor.sessionId);
        familyActivity.set(
          ancestor.sessionId,
          Math.max(familyActivity.get(ancestor.sessionId) ?? 0, session.lastEventAt),
        );
        ancestor = ancestor.parentSessionId
          ? this.sessions.get(ancestor.parentSessionId)
          : undefined;
      }
    }
    for (const [id, session] of this.sessions) {
      if (now - (familyActivity.get(id) ?? session.lastEventAt) > config.sessionTtlMs) {
        this.sessions.delete(id);
        // Keep baselines and attribution after card eviction for late exports.
        changed = true;
        continue;
      }
      if (
        session.status !== 'idle' &&
        session.status !== 'tool' &&
        now - session.lastEventAt > config.idleMs
      ) {
        this.setStatus(session, 'idle');
        changed = true;
      }
    }
    if (changed) {
      this.emit('sessions', this.getSessions(), this.getAggregate());
    }
  }

  getSessions(): SessionState[] {
    return [...this.sessions.values()].sort((left, right) => right.lastEventAt - left.lastEventAt);
  }

  getRecentEvents(limit = 100): AgentEvent[] {
    return this.ring.slice(-limit);
  }

  getPromptEvents(promptId: string): AgentEvent[] {
    return this.ring.filter((event) => event.promptId === promptId);
  }

  getProviderAggregates(): ProviderAggregates {
    return { claude: this.getAggregate('claude'), codex: this.getAggregate('codex') };
  }

  getAggregate(provider?: AgentProvider): Aggregate {
    this.rolloverDayIfNeeded();
    const hourAgo = Date.now() - PROMPT_WINDOW_MS;
    this.prompts.prune(hourAgo - PROMPT_PAIR_WINDOW_MS);
    const events = provider ? this.ring.filter((event) => event.provider === provider) : this.ring;
    const promptsLastHour = this.prompts.count(hourAgo, provider);
    const activeSessions = groupSessions(
      this.getSessions().filter((session) => !provider || session.provider === provider),
    ).groups.filter((group) => group.active).length;
    const recentErrors = events
      .filter((event) => event.kind === 'api_error')
      .slice(-8)
      .map((event) => ({
        ts: event.ts,
        statusCode: event.statusCode,
        model: event.model,
        teamId: event.teamId,
      }));
    if (provider) {
      return { ...this.providerTotals[provider], activeSessions, promptsLastHour, recentErrors };
    }
    return {
      activeSessions,
      promptsLastHour,
      costTodayUsd: this.costTodayUsd,
      tokensTodayInput: this.tokensInToday,
      tokensTodayOutput: this.tokensOutToday,
      costKnown: this.costKnown,
      tokensKnown: this.tokensKnown,
      unknownUsageCount: this.unknownUsageCount,
      editWriteAccepts: this.editWriteAccepts,
      editWriteRejects: this.editWriteRejects,
      recentErrors,
    };
  }
}
