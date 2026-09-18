import type { SessionState } from '../types';
import { ago, since, statusLabel, tokens, usd } from '../format';
import type { SessionGroup } from '../../../server/src/session-hierarchy';

export function SessionCard({
  s,
  onClick,
  group,
}: {
  s: SessionState;
  onClick: () => void;
  group?: SessionGroup;
}) {
  const delegated = s.status === 'idle' && group?.active;
  const status = delegated ? 'thinking' : s.status;
  const childCount =
    group?.children.filter((child) => child.sessionRole !== 'internal').length ?? 0;
  const internalCount = (group?.children.length ?? 0) - childCount;
  const ticket = s.ticket
    ? s.ticketTitle && s.ticketTitle !== s.ticket
      ? `${s.ticket} · ${s.ticketTitle}`
      : s.ticket
    : null;

  return (
    <button
      className={`card status-${status}`}
      onClick={onClick}
      title="View task, subagents and timeline"
    >
      <div className="card-top">
        <span className={`pill pill-${status}`}>
          <span className="dot" />
          {delegated ? 'Delegated work running' : statusLabel[s.status]}
          {s.status === 'tool' && s.currentTool ? `: ${s.currentTool}` : ''}
        </span>
        <span className="card-provider" data-provider={s.provider}>
          {s.provider === 'claude' ? 'Claude' : 'Codex'}
          {s.client && s.client !== 'unknown' ? ` · ${s.client}` : ''}
        </span>
        <span className="card-actor">{s.agent ?? s.userEmail ?? s.sessionId.slice(0, 8)}</span>
      </div>

      <div className="card-task-label">
        <span>Main task · {s.rawSessionId?.slice(-8) ?? s.sessionId.slice(-8)}</span>
        <span aria-hidden="true">↗</span>
      </div>

      <div className="card-repo">
        {s.repo ?? <span className="muted">unknown repo</span>}
        {s.branch && <span className="branch">⎇ {s.branch}</span>}
      </div>

      {ticket ? (
        <div className="card-ticket">{ticket}</div>
      ) : (
        <div className="card-ticket muted">no ticket</div>
      )}

      <div className="card-metrics">
        <span className="metric-time" title="Active turn: time since the current prompt started">
          ⏱ {s.status === 'idle' ? '—' : since(s.turnStartedAt)}
        </span>
        <span className="metric-tokens" title="AI tokens: text units processed in this session">
          ◇ {s.tokensKnown ? tokens(s.sessionTokens) : 'Tokens unavailable'}
        </span>
        <span className="metric-cost" title="Estimated AI usage cost for this session">
          {s.costKnown ? usd(s.sessionCostUsd) : 'Cost unavailable'}
        </span>
      </div>

      <div className="card-foot">
        <span className="metric-prompts" title="Prompts submitted in this session">
          {s.promptCount} prompt{s.promptCount === 1 ? '' : 's'}
        </span>
        <span className="metric-activity" title="Time since the latest agent event">
          {ago(s.lastEventAt)}
        </span>
      </div>
      <div className="card-children">
        <span>
          {childCount} {childCount === 1 ? 'subagent' : 'subagents'}
          {internalCount ? ` · ${internalCount} internal` : ''}
        </span>
        <span>View activity →</span>
      </div>
    </button>
  );
}
