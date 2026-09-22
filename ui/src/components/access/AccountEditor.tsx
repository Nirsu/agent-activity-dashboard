import { useState } from 'react';
import type { Account, AccountInput } from './useAccounts';

export function AccountEditor({
  account,
  busy,
  save,
  close,
}: {
  account?: Account;
  busy: boolean;
  save: (input: AccountInput, id?: string) => Promise<void>;
  close: () => void;
}) {
  const [name, setName] = useState(account?.name ?? '');
  const [email, setEmail] = useState(account?.email ?? '');
  const [team, setTeam] = useState(account?.team ?? '');
  const input = { name, email, team, enabled: account?.enabled ?? true };
  return (
    <form
      className="access-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(input, account?.id);
      }}
    >
      <div className="access-section-heading">
        <div>
          <span className="access-eyebrow">Developer settings</span>
          <h2>{account ? 'Account details' : 'New developer account'}</h2>
        </div>
        <button
          type="button"
          className="access-close"
          aria-label="Close account editor"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </div>
      <label>
        Name
        <input
          autoFocus
          disabled={busy}
          placeholder="e.g. Alex Morgan"
          required
          maxLength={160}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Email
        <input
          required
          type="email"
          disabled={busy}
          placeholder="alex@company.com"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        Team
        <input
          maxLength={80}
          disabled={busy}
          pattern="[a-zA-Z0-9_.-]*"
          value={team}
          onChange={(event) => setTeam(event.target.value)}
          placeholder="e.g. platform-team"
        />
      </label>
      <p>
        All active accounts share access to the registered Brain projects. Manage the common
        repository filter in <a href="#projects">Projects</a>.
      </p>
      {account && (
        <p>
          Activity label: <strong>{account.activityLabel}</strong>
        </p>
      )}
      <div className="access-form-footer">
        <button className="access-primary" disabled={busy} type="submit">
          {account ? 'Save changes' : 'Create account'}
        </button>
        {account && (
          <button
            className={account.enabled ? 'access-danger' : ''}
            disabled={busy}
            type="button"
            onClick={() => void save({ ...input, enabled: !account.enabled }, account.id)}
          >
            {account.enabled ? 'Disable & revoke all tokens' : 'Enable account'}
          </button>
        )}
      </div>
      {account && !account.enabled && (
        <p>Re-enabling this account does not restore its revoked tokens.</p>
      )}
    </form>
  );
}
