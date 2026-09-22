import { useState } from 'react';
import { setDashboardToken } from '../../api/ws';
import { setBrainAdminToken } from '../brain/api';

export function AdministratorAccess({
  section,
  busy,
  unlock,
}: {
  section: 'accounts' | 'projects';
  busy: boolean;
  unlock: () => Promise<unknown>;
}) {
  const [dashboardToken, setDashboardTokenInput] = useState('');
  const [adminToken, setAdminToken] = useState('');
  return (
    <form
      className="access-panel access-form access-unlock"
      onSubmit={(event) => {
        event.preventDefault();
        if (dashboardToken.trim()) setDashboardToken(dashboardToken.trim());
        setDashboardTokenInput('');
        setBrainAdminToken(adminToken);
        setAdminToken('');
        void unlock();
      }}
    >
      <h2>Administrator access</h2>
      <p>
        Use your administrator token. Shared deployments also require a dashboard access token.
        Local development can use trusted localhost access.
      </p>
      <label>
        Dashboard token (if not already connected)
        <input
          type="password"
          autoComplete="off"
          value={dashboardToken}
          onChange={(event) => setDashboardTokenInput(event.target.value)}
        />
      </label>
      <label>
        Administrator token
        <input
          type="password"
          autoComplete="off"
          value={adminToken}
          onChange={(event) => setAdminToken(event.target.value)}
        />
      </label>
      <button className="access-primary" disabled={busy}>{`Unlock ${section}`}</button>
    </form>
  );
}
