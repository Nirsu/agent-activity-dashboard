import { createHash } from 'node:crypto';
import type {
  AgentEvent,
  CumulativeSnapshot,
  SessionState,
  UsageAliasUpdate,
  UsageDelta,
} from '../types.js';
import { estimateModelCost } from '../model-cost.js';
import { config } from '../config.js';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function measurement(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenMeasurement(value: number | undefined): number | null {
  const count = measurement(value);
  return count !== null && Number.isSafeInteger(count) ? count : null;
}

function sampleTime(event: AgentEvent): bigint {
  return event.metricEndTimeUnixNano
    ? BigInt(event.metricEndTimeUnixNano)
    : BigInt(Math.trunc(event.ts)) * 1_000_000n;
}

function previousTime(snapshot: CumulativeSnapshot): bigint {
  return snapshot.endTimeUnixNano
    ? BigInt(snapshot.endTimeUnixNano)
    : BigInt(Math.trunc(snapshot.ts)) * 1_000_000n;
}

interface AccountingResult {
  usage?: UsageDelta;
  cumulative?: CumulativeSnapshot;
  aliases?: UsageAliasUpdate;
  completion?: { previous: UsageDelta; current: UsageDelta };
}

/**
 * One canonical consumption source per provider: Claude metrics and Codex logs.
 * Claude request logs enrich the timeline only. A logs-only Claude installation
 * therefore has unknown usage until metrics arrive; falling back to logs would
 * double count when its delayed cumulative export eventually arrives.
 */
export class UsageAccounting {
  private cumulative = new Map<string, CumulativeSnapshot>();
  private seen = new Map<string, number>();
  private usageIdentity = new Map<string, string>();
  private requests = new Map<string, UsageDelta>();

  restoreCumulative(snapshots: Map<string, CumulativeSnapshot>): void {
    this.cumulative = new Map(snapshots);
  }

  restoreUsageIds(ids: Iterable<string>): void {
    for (const id of ids) {
      this.seen.set(id, Date.now());
    }
  }

  restoreUsageIdentityMap(identities: Map<string, string>): void {
    this.usageIdentity = new Map(identities);
    this.restoreUsageIds(identities.keys());
  }

  restoreRequestUsage(observations: UsageDelta[]): void {
    for (const observation of observations) {
      this.requests.set(observation.usageId, observation);
      for (const id of [observation.usageId, ...(observation.dedupeKeys ?? [])]) {
        this.seen.set(id, observation.ts);
      }
    }
  }

  prune(before: number): void {
    for (const [key, value] of this.cumulative) {
      if (value.ts < before) {
        this.cumulative.delete(key);
      }
    }
    for (const [key, ts] of this.seen) {
      if (ts < before) {
        this.seen.delete(key);
      }
    }
    for (const [key, value] of this.requests) {
      if (value.ts < before) {
        this.requests.delete(key);
      }
    }
    for (const [key] of this.usageIdentity) {
      if (!this.seen.has(key)) {
        this.usageIdentity.delete(key);
      }
    }
  }

  consume(event: AgentEvent, session?: SessionState): AccountingResult {
    if (event.provider === 'claude' && event.kind === 'metric') {
      return this.consumeMetric(event, session);
    }
    if (event.provider === 'codex' && event.kind === 'api_request') {
      return this.consumeRequest(event, session);
    }
    return {};
  }

  private context(event: AgentEvent, session?: SessionState) {
    return {
      ts: event.ts,
      sessionId: event.sessionId,
      provider: event.provider,
      client: event.client ?? session?.client,
      agent: event.agent ?? session?.agent,
      teamId: event.teams !== undefined ? event.teams[0]?.name : (event.teamId ?? session?.teamId),
      teams: event.teams ?? session?.teams,
      ticket: event.ticket ?? session?.ticket,
      repo: event.repo ?? session?.repo,
      projectId: event.projectId ?? session?.projectId,
      workItemId: event.workItemId ?? session?.workItemId ?? event.ticket ?? session?.ticket,
      runId: event.runId ?? session?.runId,
      parentRunId: event.parentRunId ?? session?.parentRunId,
      model: event.model ?? session?.model,
    };
  }

  private consumeRequest(event: AgentEvent, session?: SessionState): AccountingResult {
    const reportedCost = measurement(event.costUsd);
    const dTokensIn = tokenMeasurement(event.inputTokens);
    const dTokensOut = tokenMeasurement(event.outputTokens);
    const dUsd =
      reportedCost ??
      estimateModelCost({
        ts: event.ts,
        model: event.model ?? session?.model,
        inputTokens: dTokensIn ?? undefined,
        outputTokens: dTokensOut ?? undefined,
        cachedInputTokens: event.cachedInputTokens,
      });
    // Transport events with no usage are activity, not a fabricated zero-cost
    // request. A later response.completed event may supply the actual usage.
    if (dUsd === null && dTokensIn === null && dTokensOut === null) {
      return {};
    }
    const namespace = ['codex_logs', event.sessionId ?? null];
    const dedupeKeys: string[] = [];
    if (event.requestId) {
      dedupeKeys.push(`codex_logs:request:${digest([...namespace, event.requestId])}`);
    }
    if (event.responseId) {
      dedupeKeys.push(`codex_logs:response:${digest([...namespace, event.responseId])}`);
    }
    const usageId = dedupeKeys[0] ?? `codex_logs:event:${event.id}`;
    const knownId = [usageId, ...dedupeKeys]
      .map((key) => this.usageIdentity.get(key) ?? (this.seen.has(key) ? key : undefined))
      .find((key) => key !== undefined);
    if (knownId) {
      const newAliases = dedupeKeys.filter((key) => !this.usageIdentity.has(key));
      for (const key of dedupeKeys) {
        this.seen.set(key, event.ts);
        this.usageIdentity.set(key, knownId);
      }
      const previous = this.requests.get(knownId);
      if (previous) {
        const current: UsageDelta = {
          ...previous,
          dedupeKeys: [...new Set([...(previous.dedupeKeys ?? []), ...dedupeKeys])],
          dTokensIn: previous.dTokensIn ?? dTokensIn,
          dTokensOut: previous.dTokensOut ?? dTokensOut,
          cachedInputTokens:
            previous.cachedInputTokens ?? tokenMeasurement(event.cachedInputTokens) ?? undefined,
          model: previous.model ?? event.model ?? session?.model,
        };
        // Old records without provenance may contain reported values (including
        // zero). Preserve them; only revise values we know were model estimates.
        const preserveCost = previous.dUsd !== null && previous.costOrigin !== 'model';
        current.costOrigin = preserveCost
          ? previous.costOrigin
          : reportedCost !== null
            ? 'reported'
            : 'model';
        current.dUsd = preserveCost
          ? previous.dUsd
          : (reportedCost ??
            estimateModelCost({
              ts: current.ts,
              model: current.model,
              inputTokens: current.dTokensIn ?? undefined,
              outputTokens: current.dTokensOut ?? undefined,
              cachedInputTokens: current.cachedInputTokens,
            }));
        current.costStatus = current.dUsd === null ? 'unknown' : 'estimated';
        this.requests.set(knownId, current);
        const changed =
          current.dUsd !== previous.dUsd ||
          current.dTokensIn !== previous.dTokensIn ||
          current.dTokensOut !== previous.dTokensOut ||
          current.cachedInputTokens !== previous.cachedInputTokens ||
          current.model !== previous.model ||
          current.costOrigin !== previous.costOrigin;
        if (changed) {
          return {
            completion: { previous, current },
            aliases: {
              usageId: knownId,
              dedupeKeys: current.dedupeKeys!,
              measurements: {
                dUsd: current.dUsd,
                dTokensIn: current.dTokensIn,
                dTokensOut: current.dTokensOut,
                cachedInputTokens: current.cachedInputTokens,
                model: current.model,
                costOrigin: current.costOrigin,
              },
            },
          };
        }
      }
      return newAliases.length ? { aliases: { usageId: knownId, dedupeKeys } } : {};
    }
    this.seen.set(usageId, event.ts);
    this.usageIdentity.set(usageId, usageId);
    for (const key of dedupeKeys) {
      this.seen.set(key, event.ts);
      this.usageIdentity.set(key, usageId);
    }
    const usage: UsageDelta = {
      ...this.context(event, session),
      usageId,
      dedupeKeys,
      source: 'codex_logs',
      dUsd,
      dTokensIn,
      dTokensOut,
      cachedInputTokens: tokenMeasurement(event.cachedInputTokens) ?? undefined,
      costOrigin: reportedCost !== null ? 'reported' : 'model',
      costStatus: dUsd === null ? 'unknown' : 'estimated',
    };
    this.requests.set(usageId, usage);
    return { usage };
  }

  private consumeMetric(event: AgentEvent, session?: SessionState): AccountingResult {
    const metricName = event.metricName;
    const value = measurement(event.metricValue);
    if (
      !event.sessionId ||
      value === null ||
      (metricName !== 'claude_code.cost.usage' && metricName !== 'claude_code.token.usage')
    ) {
      return {};
    }
    if (metricName === 'claude_code.token.usage' && !Number.isSafeInteger(value)) {
      return {};
    }
    const seriesKey = `claude_metrics:${digest([
      event.sessionId,
      metricName,
      event.metricSeriesId ?? [event.model ?? null, event.tokenType ?? null],
    ])}`;
    const previous = this.cumulative.get(seriesKey);
    let delta = value;
    let cumulative: CumulativeSnapshot | undefined;
    // Unspecified is the legacy Claude cumulative export. Explicit OTLP delta
    // points are already increments and must never be subtracted from each other.
    if (event.metricTemporality !== 'delta') {
      if (previous) {
        if (sampleTime(event) < previousTime(previous)) {
          return {};
        }
        const start = event.metricStartTimeUnixNano;
        const previousStart = previous.startTimeUnixNano;
        if (start && previousStart && BigInt(start) < BigInt(previousStart)) {
          return {};
        }
        const reset =
          start !== undefined &&
          (previousStart !== undefined
            ? BigInt(start) > BigInt(previousStart)
            : BigInt(start) > previousTime(previous));
        if (!reset) {
          // A decrease without a newer startTime is ambiguous (late export or
          // reset). Keep the high-water mark instead of inventing consumption.
          if (value < previous.value) {
            return {};
          }
          delta = value - previous.value;
        }
      }
      cumulative = {
        seriesKey,
        provider: event.provider,
        sessionId: event.sessionId,
        metricName,
        tokenType: event.tokenType,
        model: event.model,
        startTimeUnixNano: event.metricStartTimeUnixNano ?? previous?.startTimeUnixNano,
        endTimeUnixNano: event.metricEndTimeUnixNano,
        value,
        ts: event.ts,
      };
      this.cumulative.set(seriesKey, cumulative);
      const start = event.metricStartTimeUnixNano ? BigInt(event.metricStartTimeUnixNano) : 0n;
      const cutoff =
        BigInt(Math.trunc(Date.now() - config.retentionDays * 86_400_000)) * 1_000_000n;
      if (!previous && start > 0n && start < cutoff) {
        // The previous baseline expired. Re-establish it without charging the
        // counter's entire lifetime as new usage; subsequent deltas are known.
        return { cumulative };
      }
    }
    const usageId = `claude_metrics:sample:${digest([
      seriesKey,
      event.metricTemporality ?? 'unspecified',
      event.metricStartTimeUnixNano ?? null,
      event.metricEndTimeUnixNano ?? event.ts,
      value,
    ])}`;
    if (this.seen.has(usageId) || (cumulative && previous && delta === 0)) {
      return { cumulative };
    }
    this.seen.set(usageId, event.ts);
    const isCost = metricName === 'claude_code.cost.usage';
    const tokenType = event.tokenType?.toLowerCase().replace(/[_-]/g, '');
    const isOutput = tokenType === 'output';
    const isInput =
      tokenType === 'input' || tokenType === 'cacheread' || tokenType === 'cachecreation';
    return {
      cumulative,
      usage: {
        ...this.context(event, session),
        usageId,
        source: 'claude_metrics',
        metricName,
        dUsd: isCost ? delta : null,
        dTokensIn: !isCost && isInput ? delta : null,
        dTokensOut: !isCost && isOutput ? delta : null,
        costStatus: isCost ? 'estimated' : 'unknown',
        cumulative,
      },
    };
  }
}
