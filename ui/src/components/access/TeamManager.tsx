import { useRef, useState } from 'react';
import type { Account, Team } from './useAccounts';

export function TeamManager({
  teams,
  accounts,
  busy,
  save,
  remove,
  notify,
}: {
  teams: Team[];
  accounts: Account[];
  busy: boolean;
  save: (name: string, id?: string) => Promise<Team | undefined>;
  remove: (id: string) => Promise<{ ok: true } | undefined>;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const close = () => {
    setEditing(null);
    setName('');
    addButton.current?.focus();
  };
  return (
    <section className="access-panel access-teams" aria-label="Manage teams">
      <div className="access-collection-heading">
        <div>
          <h2>
            Teams <span className="access-count">{teams.length}</span>
          </h2>
          <p>Create shared teams, then assign developers to one or more teams.</p>
        </div>
        <button
          type="button"
          ref={addButton}
          disabled={busy}
          onClick={() => {
            setEditing('new');
            setName('');
            notify('');
          }}
        >
          New team
        </button>
      </div>
      {editing && (
        <form
          className="access-team-form"
          aria-label={editing === 'new' ? 'Create team' : 'Rename team'}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !name.trim()) {
              return;
            }
            void save(name.trim(), editing === 'new' ? undefined : editing).then((team) => {
              if (team) {
                notify(editing === 'new' ? 'Team created.' : 'Team renamed.');
                close();
              }
            });
          }}
        >
          <label>
            Team name
            <input
              autoFocus
              required
              maxLength={80}
              disabled={busy}
              value={name}
              placeholder="e.g. Platform"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="access-actions">
            <button className="access-primary" disabled={busy || !name.trim()} type="submit">
              {editing === 'new' ? 'Create team' : 'Save team'}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel team editing
            </button>
          </div>
        </form>
      )}
      {!teams.length ? (
        <p className="access-teams-empty">
          No teams yet. Create a team to organize your developers.
        </p>
      ) : (
        <ul className="access-team-list">
          {teams.map((team) => {
            const members = accounts.filter((account) => account.teamIds.includes(team.id)).length;
            return (
              <li key={team.id}>
                <div>
                  <strong>{team.name}</strong>
                  <span>
                    {members} {members === 1 ? 'developer' : 'developers'}
                  </span>
                </div>
                <div className="access-actions">
                  <button
                    type="button"
                    aria-label={`Rename ${team.name}`}
                    disabled={busy}
                    onClick={() => {
                      setEditing(team.id);
                      setName(team.name);
                      notify('');
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="access-danger"
                    aria-label={`Delete ${team.name}`}
                    title={
                      members
                        ? 'Remove this team from its developers before deleting it.'
                        : undefined
                    }
                    disabled={busy || members > 0}
                    onClick={() => {
                      void remove(team.id).then((result) => {
                        if (result) {
                          if (editing === team.id) {
                            close();
                          }
                          notify('Team deleted.');
                        }
                      });
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {teams.some((team) => accounts.some((account) => account.teamIds.includes(team.id))) && (
        <p className="access-teams-hint">Remove a team's memberships before deleting it.</p>
      )}
    </section>
  );
}
