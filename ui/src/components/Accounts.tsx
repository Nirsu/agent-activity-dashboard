import { useRef, useState } from 'react';
import { setBrainAdminToken } from './brain/api';
import { AccountEditor } from './access/AccountEditor';
import { TeamManager } from './access/TeamManager';
import { AdministratorAccess } from './access/AdministratorAccess';
import { useAccounts } from './access/useAccounts';
import {
  AccessEmpty,
  AccessHeader,
  AccessIcon,
  AccessStatus,
  AccessToolbar,
  type AccessFilter,
} from './access/AccessUI';
import { accessDate, IssuedToken, tokenStatus, Workstations } from './access/Workstations';
import './Accounts.css';

export function Accounts() {
  const accounts = useAccounts();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AccessFilter>('all');
  const [notice, setNotice] = useState('');
  const addButton = useRef<HTMLButtonElement>(null);
  const state = accounts.state;
  const teams = state?.teams ?? [];
  const teamNames = (teamIds: string[]) =>
    teams
      .filter((team) => teamIds.includes(team.id))
      .map((team) => team.name)
      .join(', ');
  const account = state?.accounts.find((item) => item.id === selected);
  const enabled = state?.accounts.filter((item) => item.enabled).length ?? 0;
  const visible =
    state?.accounts.filter(
      (item) =>
        (filter === 'all' || item.enabled === (filter === 'enabled')) &&
        `${item.name} ${item.email} ${teamNames(item.teamIds)}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    ) ?? [];
  const closeEditor = () => {
    setSelected(null);
    addButton.current?.focus();
  };
  return (
    <section className="access-page" aria-label="Accounts">
      <AccessHeader
        title="Accounts"
        description="Manage your developers and the workstations they connect."
        busy={accounts.busy}
        unlocked={Boolean(state)}
        refresh={() => void accounts.refresh()}
        lock={() => {
          setBrainAdminToken('');
          accounts.lock();
          setSelected(null);
          setNotice('');
        }}
      >
        <button
          className="access-primary access-add"
          ref={addButton}
          disabled={accounts.busy}
          onClick={() => {
            setSelected('new');
            setNotice('');
          }}
        >
          New account
        </button>
      </AccessHeader>
      {!state && !accounts.busy && (
        <AdministratorAccess section="accounts" busy={accounts.busy} unlock={accounts.refresh} />
      )}
      {accounts.error && (
        <p role="alert" className="access-error">
          {accounts.error}
        </p>
      )}
      <div className="access-feedback" role="status">
        {accounts.busy ? 'Updating access…' : state ? notice : ''}
      </div>
      {state && (
        <>
          <div className="access-summary">
            <div>
              <span>Active accounts</span>
              <strong>
                {enabled}
                <small>of {state.accounts.length} developers</small>
              </strong>
            </div>
            <div>
              <span>Active workstation tokens</span>
              <strong>
                {state.tokens.filter((token) => tokenStatus(token) === 'Active').length}
                <small>connected credentials</small>
              </strong>
            </div>
            <div>
              <span>Workstation access</span>
              <strong className="access-summary-mode">
                Individual tokens
                <small>A token for each workstation</small>
              </strong>
            </div>
          </div>
          <section className="access-policy">
            <span className="access-policy-icon">
              <AccessIcon name="shield" />
            </span>
            <div>
              <h2>
                Individual workstation tokens <AccessStatus tone="good">Required</AccessStatus>
              </h2>
              <p>
                Activity and Brain MCP require a token assigned to a developer. Generate one for
                each workstation below.
              </p>
            </div>
          </section>
          {accounts.issued && (
            <IssuedToken
              key={accounts.issued.token.id}
              issued={accounts.issued}
              close={accounts.clearIssued}
            />
          )}
          <TeamManager
            teams={teams}
            accounts={state.accounts}
            busy={accounts.busy}
            save={accounts.saveTeam}
            remove={accounts.deleteTeam}
            notify={setNotice}
          />
          <div className={`access-account-layout${selected ? ' editing' : ''}`}>
            <section className="access-panel access-collection" aria-label="Developer accounts">
              <div className="access-collection-heading">
                <h2>
                  Developers <span className="access-count">{state.accounts.length}</span>
                </h2>
                <span>Workspace access</span>
              </div>
              <AccessToolbar
                query={query}
                setQuery={setQuery}
                filter={filter}
                setFilter={setFilter}
                total={state.accounts.length}
                enabled={enabled}
                kind="accounts"
              />
              {!state.accounts.length ? (
                <AccessEmpty
                  icon="people"
                  title="Your team starts here"
                  action={
                    <button className="access-primary" onClick={() => setSelected('new')}>
                      Add your first developer
                    </button>
                  }
                >
                  Create an account, then generate a token for each workstation. Everyone shares
                  access to registered Brain projects.
                </AccessEmpty>
              ) : !visible.length ? (
                <AccessEmpty
                  icon="search"
                  title="No matching developers"
                  action={
                    <button
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      Clear filters
                    </button>
                  }
                >
                  Try another name, email, team or account status.
                </AccessEmpty>
              ) : (
                <div className="access-list">
                  {visible.map((item) => {
                    const activeTokens = state.tokens.filter(
                      (token) => token.accountId === item.id && tokenStatus(token) === 'Active',
                    ).length;
                    return (
                      <button
                        key={item.id}
                        aria-pressed={selected === item.id}
                        className={selected === item.id ? 'selected' : ''}
                        onClick={() => {
                          setSelected(item.id);
                          setNotice('');
                        }}
                      >
                        <span className="access-avatar">
                          {item.name
                            .trim()
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((part) => part[0])
                            .join('')
                            .toUpperCase()}
                        </span>
                        <span className="access-person">
                          <strong>{item.name}</strong>
                          <span>{item.email}</span>
                          <small>
                            {teamNames(item.teamIds) || 'No teams'} <span>·</span> {activeTokens}{' '}
                            active {activeTokens === 1 ? 'token' : 'tokens'}
                          </small>
                        </span>
                        <AccessStatus tone={item.enabled ? 'good' : 'muted'}>
                          {item.enabled ? 'Active' : 'Disabled'}
                        </AccessStatus>
                        <AccessIcon name="arrow" />
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="access-collection-footer">
                {visible.length} of {state.accounts.length} developers
              </div>
            </section>
            {selected && (
              <aside className="access-panel access-detail">
                <AccountEditor
                  key={account ? JSON.stringify(account) : 'new'}
                  account={account}
                  teams={teams}
                  busy={accounts.busy}
                  close={closeEditor}
                  save={async (input, id) => {
                    const saved = await accounts.save(input, id);
                    if (saved) {
                      setSelected(saved.id);
                      if (!id) {
                        setQuery('');
                        setFilter('all');
                      }
                      setNotice(
                        id ? 'Account updated.' : 'Account created. Connect a workstation below.',
                      );
                    }
                  }}
                />
                {account && <Workstations key={account.id} account={account} access={accounts} />}
              </aside>
            )}
          </div>
          <details className="access-guide access-audit">
            <summary>
              Recent access changes<span>{state.audit.length} events</span>
            </summary>
            <p>
              Changes use the shared administrator key and do not identify an individual
              administrator.
            </p>
            {!state.audit.length && <p>No access changes recorded yet.</p>}
            {state.audit.map((entry) => (
              <div className="access-audit-entry" key={entry.id}>
                <time>{accessDate(entry.at)}</time>
                <strong>{entry.action}</strong>
                <span>{entry.target}</span>
              </div>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
