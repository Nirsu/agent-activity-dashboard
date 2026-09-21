import { useState } from 'react';
import { setBrainAdminToken } from './brain/api';
import { brainConfig } from './brain/config';
import { AccountEditor } from './access/AccountEditor';
import { AdministratorAccess } from './access/AdministratorAccess';
import { useAccounts, type WorkstationToken } from './access/useAccounts';
import './Accounts.css';

function tokenStatus(token: WorkstationToken) {
  return token.revokedAt
    ? 'Revoked'
    : Date.parse(token.expiresAt) <= Date.now()
      ? 'Expired'
      : 'Active';
}
const date = (value?: string) => (value ? new Date(value).toLocaleString() : 'Never');

export function Accounts() {
  const accounts = useAccounts();
  const [selected, setSelected] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(brainConfig.access.defaultTokenDays);
  const [copied, setCopied] = useState(false);
  const state = accounts.state;
  const account = state?.accounts.find((item) => item.id === selected);
  const tokens = state?.tokens.filter((token) => token.accountId === selected) ?? [];
  return (
    <main className="access-page">
      <div className="access-heading">
        <div>
          <span className="access-eyebrow">ADMINISTRATION</span>
          <h1>Accounts & access</h1>
          <p>Connect developer workstations and control their access to Harmony Brain.</p>
        </div>
        <div className="access-actions">
          <button disabled={accounts.busy} onClick={() => void accounts.refresh()}>
            Refresh
          </button>
          {state && (
            <button
              disabled={accounts.busy}
              onClick={() => {
                setBrainAdminToken('');
                accounts.lock();
              }}
            >
              Lock page
            </button>
          )}
        </div>
      </div>
      {!state && (
        <AdministratorAccess section="accounts" busy={accounts.busy} unlock={accounts.refresh} />
      )}
      {accounts.error && (
        <p role="alert" className="access-error">
          {accounts.error}
        </p>
      )}
      {accounts.busy && <p role="status">Updating access…</p>}
      {state && (
        <>
          <div className="access-summary">
            <div>
              <strong>{state.accounts.filter((account) => account.enabled).length}</strong>
              <span>Active accounts</span>
            </div>
            <div>
              <strong>
                {state.tokens.filter((token) => tokenStatus(token) === 'Active').length}
              </strong>
              <span>Active workstation tokens</span>
            </div>
            <div>
              <strong>{state.requireDeviceTokens ? 'Individual' : 'Transition'}</strong>
              <span>Authentication mode</span>
            </div>
          </div>
          <section className="access-panel access-policy">
            <div>
              <h2>Require individual workstation tokens</h2>
              <p>
                {state.requireDeviceTokens
                  ? 'Telemetry and Brain MCP require a token assigned to a developer.'
                  : 'Shared keys remain accepted during rollout. Switch after each workstation has its individual token.'}{' '}
                Dashboard access stays separate.
              </p>
            </div>
            <button
              disabled={accounts.busy}
              onClick={() => void accounts.requireTokens(!state.requireDeviceTokens)}
            >
              {state.requireDeviceTokens ? 'Allow shared keys' : 'Require individual tokens'}
            </button>
          </section>
          <div className="access-grid">
            <aside className="access-panel">
              <div className="access-list-heading">
                <h2>Developers</h2>
                <button onClick={() => setSelected(null)}>New account</button>
              </div>
              {!state.accounts.length && (
                <p>Create an account, then issue a token for each of its workstations.</p>
              )}
              <div className="access-list">
                {state.accounts.map((item) => (
                  <button
                    key={item.id}
                    aria-pressed={selected === item.id}
                    className={selected === item.id ? 'selected' : ''}
                    onClick={() => {
                      setSelected(item.id);
                      setLabel('');
                    }}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.email}</span>
                    <small>
                      {item.enabled ? 'Active' : 'Disabled'} · {item.team || 'No team'}
                    </small>
                  </button>
                ))}
              </div>
            </aside>
            <section className="access-panel">
              <AccountEditor
                key={account ? JSON.stringify(account) : 'new'}
                account={account}
                busy={accounts.busy}
                save={async (input, id) => {
                  const saved = await accounts.save(input, id);
                  if (saved) setSelected(saved.id);
                }}
              />
              {account && (
                <div className="access-workstations">
                  <h2>Workstations</h2>
                  <p>
                    One token sends activity and queries the authorized Brain projects. It cannot
                    open the dashboard or perform administration.
                  </p>
                  <form
                    className="access-token-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setCopied(false);
                      void accounts.issue(account.id, label, days);
                    }}
                  >
                    <label>
                      Workstation name
                      <input
                        required
                        maxLength={160}
                        placeholder="Windows laptop"
                        value={label}
                        onChange={(event) => setLabel(event.target.value)}
                      />
                    </label>
                    <label>
                      Expires in days
                      <input
                        type="number"
                        required
                        min={1}
                        max={brainConfig.access.maxTokenDays}
                        value={days}
                        onChange={(event) => setDays(Number(event.target.value))}
                      />
                    </label>
                    <button
                      disabled={accounts.busy || !account.enabled || Boolean(accounts.issued)}
                    >
                      Generate token
                    </button>
                  </form>
                  {!tokens.length && <p>No workstation tokens yet.</p>}
                  {tokens.map((token) => (
                    <div className="access-token" key={token.id}>
                      <div>
                        <strong>{token.label}</strong>
                        <span>
                          {tokenStatus(token)} · Expires {date(token.expiresAt)}
                        </span>
                        <small>Last used: {date(token.lastUsedAt)}</small>
                      </div>
                      {tokenStatus(token) === 'Active' && (
                        <button
                          className="access-danger"
                          disabled={accounts.busy}
                          onClick={() => void accounts.revoke(token.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
          <details className="access-panel access-audit">
            <summary>Recent access changes</summary>
            <p>
              Administration currently uses the shared administrator key; these entries do not
              identify an individual administrator.
            </p>
            {state.audit.map((entry) => (
              <div key={entry.id}>
                <time>{date(entry.at)}</time> <strong>{entry.action}</strong>{' '}
                <span>{entry.target}</span>
              </div>
            ))}
          </details>
        </>
      )}
      {accounts.issued && (
        <section
          className="access-secret access-panel"
          role="region"
          aria-label="New workstation token"
        >
          <h2>Copy this token now</h2>
          <p>
            For {accounts.issued.token.label}. This secret is shown only once. Deliver it through
            your secure channel; it cannot be retrieved later.
          </p>
          <label>
            Workstation token
            <textarea readOnly rows={3} value={accounts.issued.secret} spellCheck={false} />
          </label>
          <div className="access-actions">
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(accounts.issued!.secret);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <button onClick={accounts.clearIssued}>I have saved it — close</button>
          </div>
          <p>
            On the workstation, provide this value as <code>HARMONIE_TOKEN</code> in the environment
            that launches your clients. Install with:
          </p>
          <pre>
            npm run agents:setup -- --url &lt;dashboard-url&gt; --project &lt;repository-path&gt;
            --individual-token --apply
          </pre>
          <p>
            Restart the relay and clients after configuring the token. Approve the installed hooks
            and MCP connection.
          </p>
        </section>
      )}
    </main>
  );
}
