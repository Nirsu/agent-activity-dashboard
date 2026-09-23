import { useEffect, useMemo, useRef } from 'react';
import type { AgentEvent, SessionState } from '../types';
import { clock, duration, since, statusLabel, tokens, usd } from '../format';
import { sessionRole, type SessionGroup } from '../../../server/src/session-hierarchy';
import { SessionRow } from './LiveSessions';
import { sessionTeams } from '../teams';

function rowLabel(e: AgentEvent): string {
  switch (e.kind) {
    case 'user_prompt':
      return 'Prompt submitted';
    case 'tool_result':
      return `Tool · ${e.toolName ?? '?'}`;
    case 'tool_decision':
      return `Decision · ${e.toolName ?? '?'} → ${e.decision ?? '?'}`;
    case 'api_request':
      return `LLM · ${e.model ?? 'request'}`;
    case 'api_error':
      return `API error · ${e.statusCode ?? ''}`;
    case 'mcp_connection':
      return `MCP · ${e.mcpServer ?? ''} ${e.mcpState ?? ''}`;
    case 'metric':
      return `metric · ${e.metricName ?? ''}`;
    case 'activity':
      return `hook · ${e.subtype ?? ''}${e.toolName ? ` (${e.toolName})` : ''}`;
  }
}

function rowMeta(e: AgentEvent): string {
  const bits: string[] = [];
  if (e.durationMs != null) bits.push(duration(e.durationMs));
  if (e.inputTokens || e.outputTokens)
    bits.push(`◇ ${tokens((e.inputTokens ?? 0) + (e.outputTokens ?? 0))}`);
  if (e.costUsd) bits.push(usd(e.costUsd));
  return bits.join(' · ');
}

export function SessionDetail({
  session,
  events,
  onClose,
  group,
  onSelect,
}: {
  session: SessionState;
  events: AgentEvent[];
  onClose: () => void;
  group?: SessionGroup;
  onSelect?: (id: string) => void;
}) {
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const previousOverflow = typeof document !== 'undefined' ? document.body.style.overflow : '';
    if (typeof document !== 'undefined') {
      document.body.style.overflow = 'hidden';
    }
    drawer.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const buttons = drawer.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === drawer.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      if (typeof document !== 'undefined') {
        document.body.style.overflow = previousOverflow;
      }
      if (typeof HTMLElement !== 'undefined' && previous instanceof HTMLElement)
        previous.focus({ preventScroll: true });
    };
  }, []);
  const timeline = useMemo(() => {
    const byPrompt = session.currentPromptId
      ? events.filter(
          (e) => e.sessionId === session.sessionId && e.promptId === session.currentPromptId,
        )
      : [];
    // Fallback (hooks-only, no prompt.id): last events for this session.
    const list = byPrompt.length
      ? byPrompt
      : events.filter((e) => e.sessionId === session.sessionId).slice(-40);
    return [...list].reverse();
  }, [events, session]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Session activity"
        ref={drawer}
        tabIndex={-1}
      >
        <header className="drawer-head">
          <div>
            <div className="drawer-title">{session.repo ?? session.sessionId.slice(0, 12)}</div>
            <div className="drawer-sub">
              {session.agent ?? session.userEmail ?? '—'} ·{' '}
              {sessionTeams(session)
                .map((team) => team.name)
                .join(', ')}
              {session.ticket ? ` · ${session.ticket}` : ''}
            </div>
            <div className="drawer-provider">
              {session.provider === 'claude' ? 'Claude' : 'Codex'}
              {session.client && session.client !== 'unknown' ? ` · ${session.client}` : ''}
              {' · '}
              {sessionRole(session) === 'main'
                ? 'Main task'
                : sessionRole(session) === 'internal'
                  ? 'Internal task'
                  : sessionRole(session) === 'subagent'
                    ? 'Subagent'
                    : 'Unclassified session'}
            </div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {group && onSelect && (
          <section className="drawer-children" aria-label="Task sessions">
            <div className="timeline-head">
              Task activity <span>{group.children.length} linked sessions</span>
            </div>
            {group.root.sessionId !== session.sessionId && (
              <button
                className="scope-clear"
                type="button"
                onClick={() => onSelect(group.root.sessionId)}
              >
                ← Back to main task
              </button>
            )}
            {group.children.length === 0 ? (
              <p className="muted">No subagents reported for this task.</p>
            ) : (
              group.children.map((child) => (
                <div
                  className={child.sessionId === session.sessionId ? 'session-row-selected' : ''}
                  key={child.sessionId}
                >
                  <SessionRow session={child} onClick={() => onSelect(child.sessionId)} />
                </div>
              ))
            )}
            <p className="session-usage-note">
              Usage below belongs to the selected session. Child usage is shown separately when the
              client reports it.
            </p>
          </section>
        )}
        {!group && (
          <p className="drawer-unlinked">
            {session.parentSessionId
              ? 'The parent task is no longer in the live view.'
              : 'No parent task was reported for this session.'}
          </p>
        )}

        <div className="drawer-summary">
          <div>
            <span className={`pill pill-${session.status}`}>
              <span className="dot" />
              {statusLabel[session.status]}
              {session.status === 'tool' && session.currentTool ? `: ${session.currentTool}` : ''}
            </span>
          </div>
          <div className="drawer-summary-grid">
            <span className="metric-time" title="Active turn">
              ⏱ {session.status === 'idle' ? '—' : since(session.turnStartedAt)}
            </span>
            <span className="metric-tokens" title="AI tokens in this session">
              ◇{' '}
              {session.tokensKnown
                ? `${tokens(session.sessionTokens)} tokens`
                : 'Tokens unavailable'}
            </span>
            <span className="metric-cost" title="Estimated AI usage cost for this session">
              {session.costKnown ? `${usd(session.sessionCostUsd)} session` : 'Cost unavailable'}
            </span>
          </div>
        </div>

        <div className="drawer-timeline">
          <div className="timeline-head">Current turn timeline</div>
          {timeline.length === 0 && (
            <div className="muted timeline-empty">No events yet for this turn.</div>
          )}
          {timeline.map((e) => (
            <div
              key={e.id}
              className={`tl-row tl-${e.kind} ${e.success === false ? 'tl-fail' : ''}`}
            >
              <span className="tl-time">{clock(e.ts)}</span>
              <span className="tl-label">{rowLabel(e)}</span>
              <span className="tl-meta">{rowMeta(e)}</span>
              {e.kind === 'tool_result' && (
                <span className={`tl-badge ${e.success ? 'ok' : 'fail'}`}>
                  {e.success ? '✓' : '✕'}
                </span>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
