import { useEffect, useRef, useState } from 'react';
import type {
  AgentEvent,
  Aggregate,
  ProviderAggregates,
  ServerMessage,
  SessionState,
} from '../types';

const configuredServerUrl = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(
  /\/$/,
  '',
);
const SERVER_URL =
  configuredServerUrl || (import.meta.env.DEV ? 'http://localhost:4318' : location.origin);

// Viewer token (for a TLS+auth cloud deploy): pass ?token=… once; it's kept in
// localStorage thereafter. Empty for open localhost dev.
//
// The token is never sent in a URL — that would leak it into browser history,
// referrers and server access logs. REST calls use the x-aad-token header, and
// /live uses the WebSocket subprotocol (browsers cannot set handshake headers).
// The bootstrap ?token= is stripped from the address bar as soon as it is read.
const WS_TOKEN_PROTOCOL_PREFIX = 'aad-token.';
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  localStorage.setItem('aad_token', urlToken);
  const clean = new URL(location.href);
  clean.searchParams.delete('token');
  history.replaceState(null, '', clean.toString());
}
const viewerToken = urlToken ?? localStorage.getItem('aad_token') ?? '';

/** Headers carrying the viewer token for REST fetches. */
export function authHeaders(): Record<string, string> {
  return viewerToken ? { 'x-aad-token': viewerToken } : {};
}

/** Build a URL to the server for REST fetches. Pair it with authHeaders(). */
export function apiUrl(path: string): string {
  return SERVER_URL + path;
}

/**
 * fetch() against the server with the viewer token attached as a header.
 * Always use this instead of bare fetch(apiUrl(...)) so no call site can
 * forget the token and silently 401 on an authenticated deployment.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });
}

const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/live';
// Subprotocol values are RFC6455 tokens, so the value is percent-encoded.
const WS_PROTOCOLS = viewerToken
  ? [WS_TOKEN_PROTOCOL_PREFIX + encodeURIComponent(viewerToken)]
  : undefined;

const MAX_EVENTS = 300;

export interface DashboardState {
  connected: boolean;
  sessions: SessionState[];
  aggregate: Aggregate | null;
  providerAggregates: ProviderAggregates | null;
  events: AgentEvent[];
}

/** Subscribes to the server WS, auto-reconnecting. Returns live dashboard state. */
export function useDashboard(): DashboardState {
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [aggregate, setAggregate] = useState<Aggregate | null>(null);
  const [providerAggregates, setProviderAggregates] = useState<ProviderAggregates | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let closed = false;

    const connect = () => {
      const ws = new WebSocket(WS_URL, WS_PROTOCOLS);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retryRef.current = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (msg.type === 'snapshot') {
          setSessions(msg.sessions);
          setAggregate(msg.aggregate);
          setProviderAggregates(msg.providerAggregates ?? null);
          setEvents(msg.recentEvents.slice(-MAX_EVENTS));
        } else if (msg.type === 'sessions') {
          setSessions(msg.sessions);
          setAggregate(msg.aggregate);
          setProviderAggregates(msg.providerAggregates ?? null);
        } else if (msg.type === 'event') {
          setEvents((prev) => [...prev, msg.event].slice(-MAX_EVENTS));
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { connected, sessions, aggregate, providerAggregates, events };
}

export { SERVER_URL };
