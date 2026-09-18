import type { AgentProvider, Aggregate } from '../types';
import { ago, usd } from '../format';

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function AggregateBar({
  agg,
  provider,
}: {
  agg: Aggregate | null;
  provider?: AgentProvider;
}) {
  if (!agg) return <div className="aggbar aggbar-empty">Waiting for telemetry…</div>;

  const total = agg.editWriteAccepts + agg.editWriteRejects;
  const acceptRate = total ? Math.round((agg.editWriteAccepts / total) * 100) : null;
  const providerLabel =
    provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'All AI';

  return (
    <div className="aggbar" role="region" aria-label={`${providerLabel} activity summary`}>
      <Stat
        label={`Active main tasks · ${provider ? providerLabel : 'all streams'}`}
        value={String(agg.activeSessions)}
        tone="accent"
      />
      <Stat label="Prompts / last hour" value={String(agg.promptsLastHour)} />
      <Stat
        label={
          agg.costKnown
            ? `Known cost today${agg.unknownUsageCount ? ' · partial' : provider ? ` · ${providerLabel}` : ' · all sources'}`
            : 'Cost unavailable · today'
        }
        value={agg.costKnown ? usd(agg.costTodayUsd) : '—'}
        tone={agg.unknownUsageCount ? 'warn' : 'accent'}
      />
      <Stat
        label="Edit/Write tool permissions"
        value={acceptRate === null ? '—' : `${acceptRate}%`}
        tone={acceptRate !== null && acceptRate < 60 ? 'warn' : ''}
      />
      <div className="stat errors">
        <div className={`stat-value ${agg.recentErrors.length ? 'bad' : ''}`}>
          {agg.recentErrors.length}
        </div>
        <div className="stat-label">Recent API errors</div>
        {agg.recentErrors.length > 0 && (
          <div className="error-list">
            {agg.recentErrors
              .slice(-3)
              .reverse()
              .map((e, i) => (
                <span key={i} className="error-chip">
                  {e.statusCode ?? 'err'} · {ago(e.ts)}
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
