import type { AccessPrincipal } from './store.js';
import type { AgentEvent } from '../types.js';
import type { AuthorizedRepository } from './repositories.js';

declare module 'fastify' {
  interface FastifyRequest {
    accessPrincipal?: AccessPrincipal | null;
    authorizedRepository?: AuthorizedRepository | null;
  }
}

export function deviceId(principal: AccessPrincipal, value: string | undefined) {
  return value ? `${principal.account.id}/${principal.token.id}/${value}` : undefined;
}

export function deviceOriginSession(principal: AccessPrincipal, value: string | undefined) {
  const match = /^(codex|claude):(.*)$/.exec(value ?? '');
  return match ? `${match[1]}:${deviceId(principal, match[2])}` : deviceId(principal, value);
}

export function attributeEvent(event: AgentEvent, principal?: AccessPrincipal | null): AgentEvent {
  if (!principal) return event;
  return {
    ...event,
    id: deviceId(principal, event.id)!,
    sessionId: deviceId(principal, event.sessionId),
    rawSessionId: undefined,
    parentSessionId: deviceId(principal, event.parentSessionId),
    rawParentSessionId: undefined,
    promptId: deviceId(principal, event.promptId),
    requestId: deviceId(principal, event.requestId),
    responseId: deviceId(principal, event.responseId),
    metricSeriesId: deviceId(principal, event.metricSeriesId),
    userEmail: `account:${principal.account.id}`,
    agent: undefined,
    teamId: principal.account.team || undefined,
    department: undefined,
  };
}
