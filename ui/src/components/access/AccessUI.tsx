import type { ReactNode } from 'react';

export function AccessIcon({
  name,
}: {
  name: 'people' | 'folder' | 'search' | 'shield' | 'device' | 'arrow';
}) {
  const paths = {
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" />
      </>
    ),
    folder: (
      <path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0h10" />
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    device: (
      <>
        <rect x="3" y="3" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-5v5" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function AccessHeader({
  title,
  description,
  busy,
  unlocked,
  refresh,
  lock,
  children,
}: {
  title: string;
  description: string;
  busy: boolean;
  unlocked: boolean;
  refresh: () => void;
  lock: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="access-heading">
      <div>
        <div className="access-eyebrow">
          Workspace settings <span>/</span> {title}
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="access-actions">
        <button disabled={busy} onClick={refresh}>
          Refresh
        </button>
        {unlocked && (
          <>
            <button className="access-quiet" disabled={busy} onClick={lock}>
              Lock page
            </button>
            {children}
          </>
        )}
      </div>
    </header>
  );
}

export function AccessStatus({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'good' | 'muted' | 'warning';
}) {
  return (
    <span className={`access-badge ${tone}`}>
      <span />
      {children}
    </span>
  );
}

export function AccessEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon: 'people' | 'folder' | 'search' | 'device';
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="access-empty">
      <span className="access-empty-icon">
        <AccessIcon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export type AccessFilter = 'all' | 'enabled' | 'disabled';

export function AccessToolbar({
  query,
  setQuery,
  filter,
  setFilter,
  total,
  enabled,
  kind,
}: {
  query: string;
  setQuery: (value: string) => void;
  filter: AccessFilter;
  setFilter: (value: AccessFilter) => void;
  total: number;
  enabled: number;
  kind: 'accounts' | 'projects';
}) {
  const activeLabel = kind === 'accounts' ? 'Active' : 'Enabled';
  return (
    <div className="access-toolbar">
      <div className="access-filters" role="group" aria-label={`Filter ${kind} by status`}>
        {(
          [
            ['all', 'All', total],
            ['enabled', activeLabel, enabled],
            ['disabled', 'Disabled', total - enabled],
          ] as const
        ).map(([value, label, count]) => (
          <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}
            <span>{count}</span>
          </button>
        ))}
      </div>
      <label className="access-search">
        <AccessIcon name="search" />
        <input
          type="search"
          aria-label={`Search ${kind}`}
          placeholder={
            kind === 'accounts'
              ? 'Search name, email or team…'
              : 'Search name, remote or Brain project…'
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
    </div>
  );
}

export function AccessPolicy({
  title,
  description,
  enabled,
  action,
  busy,
  onChange,
}: {
  title: string;
  description: string;
  enabled: boolean;
  action: string;
  busy: boolean;
  onChange: () => void;
}) {
  return (
    <section className="access-policy">
      <span className="access-policy-icon">
        <AccessIcon name="shield" />
      </span>
      <div>
        <h2>
          {title}
          <AccessStatus tone={enabled ? 'good' : 'warning'}>
            {enabled ? 'Enabled' : 'Transition mode'}
          </AccessStatus>
        </h2>
        <p>{description}</p>
      </div>
      <button disabled={busy} onClick={onChange}>
        {action}
      </button>
    </section>
  );
}
