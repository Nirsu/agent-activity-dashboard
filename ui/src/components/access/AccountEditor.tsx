import { useState } from 'react';
import type { Account, AccountInput } from './useAccounts';

export function AccountEditor({
  account,
  busy,
  save,
}: {
  account?: Account;
  busy: boolean;
  save: (input: AccountInput, id?: string) => Promise<void>;
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
      <h2>{account ? 'Account details' : 'New developer account'}</h2>
      <label>
        Name
        <input
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
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        Team
        <input
          maxLength={80}
          pattern="[a-zA-Z0-9_.-]*"
          value={team}
          onChange={(event) => setTeam(event.target.value)}
          placeholder="equipe-mobile"
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
      <div className="access-actions">
        <button disabled={busy} type="submit">
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
