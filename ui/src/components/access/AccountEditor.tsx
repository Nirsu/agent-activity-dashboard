import { useState } from 'react';
import type { Account, AccountInput, Team } from './useAccounts';

export function AccountEditor({
  account,
  teams,
  busy,
  save,
  close,
}: {
  account?: Account;
  teams: Team[];
  busy: boolean;
  save: (input: AccountInput, id?: string) => Promise<void>;
  close: () => void;
}) {
  const [name, setName] = useState(account?.name ?? '');
  const [email, setEmail] = useState(account?.email ?? '');
  const [teamIds, setTeamIds] = useState(account?.teamIds ?? []);
  const input = {
    name,
    email,
    teamIds: teamIds.filter((id) => teams.some((team) => team.id === id)),
    enabled: account?.enabled ?? true,
  };
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
      <fieldset className="access-team-selection" disabled={busy}>
        <legend>Teams</legend>
        <p>Select all teams this developer belongs to. Membership is optional.</p>
        {!teams.length ? (
          <p>Create a team in the Teams section above to assign this developer.</p>
        ) : (
          <div className="access-team-options">
            {teams.map((team) => (
              <label key={team.id}>
                <input
                  type="checkbox"
                  name="teamIds"
                  value={team.id}
                  checked={teamIds.includes(team.id)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setTeamIds((current) =>
                      checked
                        ? [...current.filter((id) => id !== team.id), team.id]
                        : current.filter((id) => id !== team.id),
                    );
                  }}
                />
                <span>{team.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
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
