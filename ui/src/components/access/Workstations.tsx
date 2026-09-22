import { useState } from 'react';
import { brainConfig } from '../brain/config';
import { AccessEmpty, AccessIcon, AccessStatus } from './AccessUI';
import type { Account, useAccounts, WorkstationToken } from './useAccounts';

export function tokenStatus(token: WorkstationToken) {
  if (token.revokedAt) return 'Revoked';
  if (token.expiresAt === null) return 'Active';
  if (typeof token.expiresAt !== 'string') return 'Invalid';
  const expiresAt = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAt)) return 'Invalid';
  return expiresAt <= Date.now() ? 'Expired' : 'Active';
}
export const accessDate = (value?: string) => (value ? new Date(value).toLocaleString() : 'Never');

export function Workstations({
  account,
  access,
}: {
  account: Account;
  access: ReturnType<typeof useAccounts>;
}) {
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState(false);
  const [days, setDays] = useState(String(brainConfig.access.defaultTokenDays));
  const [validationError, setValidationError] = useState('');
  const tokens = access.state?.tokens.filter((token) => token.accountId === account.id) ?? [];
  return (
    <section className="access-workstations">
      <div className="access-section-heading">
        <h2>
          <AccessIcon name="device" /> Workstations{' '}
          <span className="access-count">{tokens.length}</span>
        </h2>
      </div>
      <p>
        Each workstation gets its own token for activity and Brain queries. Tokens do not grant
        dashboard or administrator access.
      </p>
      {!account.enabled && (
        <p className="access-inline-warning">
          Enable this account to generate a workstation token.
        </p>
      )}
      <form
        className="access-token-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const duration = Number(days);
          if (
            expires &&
            (!Number.isInteger(duration) ||
              duration < 1 ||
              duration > brainConfig.access.maxTokenDays)
          ) {
            setValidationError(
              `Enter a duration from 1 to ${brainConfig.access.maxTokenDays} days.`,
            );
            return;
          }
          setValidationError('');
          await access.issue(account.id, label, expires ? duration : undefined);
        }}
      >
        <label>
          Workstation name
          <input
            disabled={access.busy || !account.enabled}
            required
            maxLength={160}
            placeholder="e.g. Work laptop"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <div className="access-token-expiration">
          <label>
            Expiration
            <select
              disabled={access.busy || !account.enabled}
              value={expires ? 'duration' : 'none'}
              onChange={(event) => {
                setExpires(event.target.value === 'duration');
                setValidationError('');
              }}
            >
              <option value="none">No expiration</option>
              <option value="duration">Expires after</option>
            </select>
          </label>
          {expires && (
            <label>
              Expires in days
              <input
                disabled={access.busy || !account.enabled}
                type="number"
                required
                min={1}
                max={brainConfig.access.maxTokenDays}
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </label>
          )}
        </div>
        {validationError && (
          <p className="access-inline-warning" role="alert">
            {validationError}
          </p>
        )}
        <button disabled={access.busy || !account.enabled || Boolean(access.issued)}>
          Generate token
        </button>
      </form>
      {!tokens.length && (
        <AccessEmpty icon="device" title="No workstations yet">
          Generate a token above to connect this developer’s first workstation.
        </AccessEmpty>
      )}
      {tokens.map((token) => (
        <div className="access-token" key={token.id}>
          <span className="access-token-icon">
            <AccessIcon name="device" />
          </span>
          <div>
            <strong>{token.label}</strong>
            <small>
              {token.expiresAt === null
                ? 'No expiration'
                : !Number.isFinite(Date.parse(token.expiresAt))
                  ? 'Expiration unknown'
                  : `Expires ${accessDate(token.expiresAt)}`}
            </small>
            <small>Last used {accessDate(token.lastUsedAt)}</small>
          </div>
          <div className="access-token-actions">
            <AccessStatus tone={tokenStatus(token) === 'Active' ? 'good' : 'muted'}>
              {tokenStatus(token)}
            </AccessStatus>
            {tokenStatus(token) === 'Active' && (
              <button
                className="access-danger"
                disabled={access.busy}
                onClick={() => void access.revoke(token.id)}
              >
                Revoke
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

export function IssuedToken({
  issued,
  close,
}: {
  issued: NonNullable<ReturnType<typeof useAccounts>['issued']>;
  close: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <section
      className="access-secret access-panel"
      role="region"
      aria-label="New workstation token"
    >
      <div className="access-section-heading">
        <h2>Copy this token now</h2>
        <AccessStatus tone="warning">Shown once</AccessStatus>
      </div>
      <p>
        For <strong>{issued.token.label}</strong>. Save this secret and deliver it through your
        secure channel. It cannot be retrieved later.
      </p>
      <label>
        Workstation token
        <textarea
          autoFocus
          readOnly
          rows={2}
          value={issued.secret}
          spellCheck={false}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <div className="access-actions">
        <button
          className="access-primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(issued.secret);
              setCopied(true);
              setCopyError(false);
            } catch {
              setCopyError(true);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy token'}
        </button>
        <button onClick={close}>I have saved it — close</button>
      </div>
      {copyError && (
        <p role="alert">
          Could not copy automatically. Select the token above and copy it manually.
        </p>
      )}
      <details className="access-token-setup">
        <summary>How to use this token</summary>
        <p>
          On the workstation, provide this value as <code>HARMONIE_TOKEN</code> in the environment
          that launches your clients. Install with:
        </p>
        <pre>
          npm run agents:setup -- --url &lt;dashboard-url&gt; --project &lt;repository-path&gt;
          --apply
        </pre>
        <p>Restart the relay and clients, then approve the installed hooks and MCP connection.</p>
      </details>
    </section>
  );
}
