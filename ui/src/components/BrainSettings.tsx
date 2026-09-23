import { useEffect, useRef, useState } from 'react';
import { brainAdminRequest, hasBrainAdminToken, setBrainAdminToken } from './brain/api';
import { useBrainMemory } from './brain/useBrainMemory';
import { formatDate } from './brain/presentation';
import { notionPageId } from './brain/notionPageId';
import { brainConfig } from './brain/config';
import './BrainMemory.css';
import { BrainPricing } from './brain/BrainPricing';
import './brain/BrainPricing.css';

type ConnectionAction = 'connect' | 'disconnect' | 'test' | 'cognee';
let pendingAuthorization: { url: string; expiresAt: number } | undefined;
const connectionLabels: Record<string, string> = {
  unconfigured: 'Setup required',
  disconnected: 'Not connected',
  connecting: 'Waiting for Notion',
  connected: 'Connected',
  reconnect_required: 'Reconnect required',
  error: 'Connection problem',
};

export default function BrainSettings() {
  const memory = useBrainMemory();
  const [activeAction, setActiveAction] = useState<ConnectionAction | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authorization, setAuthorization] = useState(pendingAuthorization);
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');
  const [adminAccess, setAdminAccess] = useState(hasBrainAdminToken);
  const adminSection = useRef<HTMLDetailsElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const notion = memory.state?.notion;
  const cognee = memory.state?.cognee;
  const busy = activeAction !== null;
  const authorizationUrl =
    authorization && authorization.expiresAt > Date.now() ? authorization.url : '';

  useEffect(() => {
    if (notion?.status === 'connected') {
      pendingAuthorization = undefined;
      setAuthorization(undefined);
    }
  }, [notion?.status]);

  function showAdminAccess() {
    if (adminSection.current) {
      adminSection.current.open = true;
      tokenInput.current?.focus();
    }
  }

  async function connectionAction(action: ConnectionAction) {
    setActiveAction(action);
    setError('');
    setNotice('');
    try {
      if (action === 'connect') {
        const result = await brainAdminRequest<{ authorizationUrl: string }>(
          '/connections/notion/connect',
          {},
        );
        const destination = new URL(result.authorizationUrl);
        if (destination.protocol !== 'https:') {
          throw new Error('Brain returned an invalid authorization address.');
        }
        pendingAuthorization = {
          url: destination.toString(),
          expiresAt: Date.now() + brainConfig.notionMcp.authorizationTimeoutMs,
        };
        setAuthorization(pendingAuthorization);
      } else if (action === 'disconnect') {
        await brainAdminRequest('/connections/notion', undefined, 'DELETE');
        pendingAuthorization = undefined;
        setAuthorization(undefined);
        setNotice('Notion disconnected. Saved sources and analyses are kept.');
      } else if (action === 'cognee') {
        const result = await brainAdminRequest<{ available: boolean }>(
          '/memory/connection-test',
          {},
        );
        setNotice(
          result.available
            ? 'Cognee is available.'
            : 'Cognee is unavailable. See its connection details below.',
        );
      } else {
        const result = await brainAdminRequest<{ page?: { title: string } }>(
          '/connections/notion/test',
          pageId.trim() ? { pageId: notionPageId(pageId) } : {},
        );
        setNotice(
          result.page ? `Brain can read “${result.page.title}”.` : 'Notion connection verified.',
        );
      }
      try {
        await memory.refresh();
      } catch {}
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The connection action failed.');
      if (error instanceof Error && 'status' in error && error.status === 403) {
        showAdminAccess();
      }
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <section className="brain-memory brain-settings" aria-labelledby="brain-settings-title">
      <header className="brain-live-header">
        <div>
          <h2 id="brain-settings-title">Harmony Brain</h2>
          <p>Manage model pricing, reference connections and Brain’s memory service.</p>
        </div>
        <button className="brain-button" onClick={showAdminAccess}>
          Administrator access{adminAccess ? ' · set' : ''}
        </button>
      </header>
      {(error || memory.connectionError) && (
        <div className="brain-error" role="alert">
          <span>{error || memory.connectionError}</span>
          <div className="brain-memory-actions">
            {memory.connectionError && <button onClick={memory.retry}>Retry</button>}
            <button
              aria-label="Dismiss error"
              onClick={() => {
                setError('');
                memory.dismissError();
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className="brain-notice" role="status">
          {notice}
        </p>
      )}
      <BrainPricing onAdminRequired={showAdminAccess} />
      {!memory.state ? (
        <div className="brain-memory-empty" role="status">
          <h2>{memory.connectionError ? 'Settings are unavailable' : 'Loading connections…'}</h2>
          {memory.connectionError && (
            <button className="brain-button" onClick={memory.retry}>
              Try again
            </button>
          )}
        </div>
      ) : (
        <div className="brain-settings-grid">
          <article className="brain-settings-card" aria-labelledby="brain-notion-title">
            <div className="brain-settings-card-heading">
              <div>
                <span className="brain-eyebrow">REFERENCE DOCUMENTS</span>
                <h2 id="brain-notion-title">Notion</h2>
              </div>
              <span
                className={`brain-memory-status ${notion?.connected ? 'ready' : notion?.status === 'error' ? 'failed' : 'pending'}`}
              >
                {connectionLabels[notion?.status ?? ''] ?? 'Unavailable'}
              </span>
            </div>
            <p>Read the pages selected for your projects.</p>
            {notion?.workspace && (
              <dl>
                <dt>Workspace</dt>
                <dd>{notion.workspace}</dd>
              </dl>
            )}
            {notion?.lastCheckedAt && (
              <dl>
                <dt>Last checked</dt>
                <dd>{formatDate(notion.lastCheckedAt)}</dd>
              </dl>
            )}
            {notion?.error && <p className="brain-settings-warning">{notion.error}</p>}
            {notion && !notion.configured && !notion.error && (
              <p className="brain-settings-warning">
                An administrator must finish Notion setup on the server.
              </p>
            )}
            {authorizationUrl ? (
              <div className="brain-settings-authorization" role="status">
                <strong>One step left</strong>
                <a
                  className="brain-button primary"
                  href={authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Continue in Notion ↗
                </a>
                <p>Choose your workspace and approve access. Return here when you’re done.</p>
              </div>
            ) : (
              notion?.status === 'connecting' && (
                <p className="brain-settings-warning">
                  The authorization link is no longer available. Start a new connection below.
                </p>
              )
            )}
            <div className="brain-memory-actions">
              {notion?.connected && (
                <a className="brain-button primary" href="#brain/memory">
                  Manage sources →
                </a>
              )}
              <button
                className={`brain-button${notion?.connected || authorizationUrl ? '' : ' primary'}`}
                disabled={busy || !notion?.configured}
                onClick={() => void connectionAction('connect')}
              >
                {activeAction === 'connect'
                  ? 'Connecting…'
                  : authorizationUrl || notion?.status === 'connecting'
                    ? 'Start again'
                    : notion?.connected || notion?.status === 'reconnect_required'
                      ? 'Reconnect'
                      : 'Connect Notion'}
              </button>
              {notion?.configured &&
                (notion.connected ||
                  ['error', 'reconnect_required', 'connecting'].includes(notion.status)) && (
                  <button
                    className="brain-button"
                    disabled={busy}
                    onClick={() => void connectionAction('disconnect')}
                  >
                    {activeAction === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                )}
            </div>
            {notion?.connected && (
              <details className="brain-settings-diagnostics">
                <summary>Check connection or page access</summary>
                <form
                  className="brain-settings-test"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connectionAction('test');
                  }}
                >
                  <label>
                    Notion page link or ID (optional)
                    <input
                      value={pageId}
                      disabled={busy}
                      maxLength={brainConfig.projects.maxLocalPathCharacters}
                      onChange={(event) => setPageId(event.target.value)}
                      placeholder="Leave empty to check the connection"
                    />
                  </label>
                  <button className="brain-button" disabled={busy}>
                    {activeAction === 'test' ? 'Checking…' : 'Check access'}
                  </button>
                </form>
              </details>
            )}
            <p className="brain-memory-help">
              Access renews automatically. Reconnect here if Notion revokes it.
            </p>
          </article>
          <article className="brain-settings-card" aria-labelledby="brain-cognee-title">
            <div className="brain-settings-card-heading">
              <div>
                <span className="brain-eyebrow">MEMORY SEARCH</span>
                <h2 id="brain-cognee-title">Cognee</h2>
              </div>
              <span className={`brain-memory-status ${cognee?.available ? 'ready' : 'pending'}`}>
                {cognee?.available
                  ? 'Available'
                  : cognee?.configured
                    ? 'Unavailable'
                    : 'Setup required'}
              </span>
            </div>
            <p>Find relevant passages within each project and its shared references.</p>
            {cognee?.reason && <p className="brain-settings-warning">{cognee.reason}</p>}
            <div className="brain-memory-actions">
              <button
                className="brain-button"
                disabled={busy}
                onClick={() => void connectionAction('cognee')}
              >
                {activeAction === 'cognee' ? 'Checking…' : 'Check service'}
              </button>
              <a href="#brain/graph">Explore memory graph →</a>
            </div>
            <p className="brain-memory-help">
              Indexing new or changed sources uses the models configured on the server and may incur
              usage charges.
            </p>
          </article>
        </div>
      )}
      <details ref={adminSection} className="brain-settings-admin">
        <summary>
          Administrator access{' '}
          <span>
            {adminAccess
              ? 'Credential supplied for this session'
              : 'Required on shared deployments'}
          </span>
        </summary>
        <p>
          Use an administrator token to manage sources, connections and human reviews. It stays in
          this page session and is cleared when the page reloads.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBrainAdminToken(token.trim());
            setAdminAccess(Boolean(token.trim()));
            setToken('');
            setNotice(
              'Administrator credential supplied for this session. Retry the action you wanted to perform.',
            );
          }}
        >
          <label>
            Administrator token
            <input
              ref={tokenInput}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button className="brain-button" disabled={!token.trim()}>
            Use token
          </button>
          {adminAccess && (
            <button
              className="brain-button"
              type="button"
              onClick={() => {
                setBrainAdminToken('');
                setAdminAccess(false);
                setToken('');
                setNotice('Administrator credential cleared.');
              }}
            >
              Clear token
            </button>
          )}
        </form>
      </details>
    </section>
  );
}
