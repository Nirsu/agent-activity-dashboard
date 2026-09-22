import { useCallback, useEffect, useState } from 'react';
import { brainAdminRequest } from '../brain/api';

export interface Account {
  id: string;
  name: string;
  email: string;
  team: string;
  enabled: boolean;
  activityLabel: string;
}
export interface WorkstationToken {
  id: string;
  accountId: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}
export interface AccessState {
  accounts: Account[];
  tokens: WorkstationToken[];
  projects: { id: string; name: string }[];
  audit: { id: string; at: string; actor: string; action: string; target: string }[];
  requireDeviceTokens: boolean;
  repositories: Repository[];
  filterRepositories: boolean;
}
export interface Repository {
  id: string;
  name: string;
  remote: string;
  enabled: boolean;
  brainProjectId?: string;
}
export type AccountInput = Pick<Account, 'name' | 'email' | 'team' | 'enabled'>;

export function useAccounts() {
  const [state, setState] = useState<AccessState | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<{ secret: string; token: WorkstationToken } | null>(null);
  const refresh = useCallback(async () => {
    setState(await brainAdminRequest<AccessState>('/access', undefined, 'GET'));
  }, []);
  const action = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError('');
      try {
        const result = await work();
        await refresh();
        return result;
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'status' in error &&
          [401, 403].includes(Number(error.status))
        ) {
          setState(null);
          setIssued(null);
        }
        setError(error instanceof Error ? error.message : 'The request failed.');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  useEffect(() => {
    void action(async () => {});
  }, [action]);
  return {
    state,
    busy,
    error,
    issued,
    clearIssued: () => setIssued(null),
    refresh: () => action(async () => {}),
    save: (input: AccountInput, id?: string) =>
      action(() =>
        brainAdminRequest<Account>(
          `/access/accounts${id ? `/${id}` : ''}`,
          input,
          id ? 'PUT' : 'POST',
        ),
      ),
    issue: (accountId: string, label: string, expiresInDays: number) =>
      action(async () => {
        setIssued(await brainAdminRequest('/access/tokens', { accountId, label, expiresInDays }));
      }),
    revoke: (id: string) =>
      action(async () => {
        await brainAdminRequest(`/access/tokens/${id}`, undefined, 'DELETE');
        setIssued((current) => (current?.token.id === id ? null : current));
      }),
    requireTokens: (required: boolean) =>
      action(() => brainAdminRequest('/access/policy', { required }, 'PUT')),
    saveRepository: (input: Omit<Repository, 'id'>, id?: string) =>
      action(() =>
        brainAdminRequest<Repository>(
          `/access/repositories${id ? `/${id}` : ''}`,
          input,
          id ? 'PUT' : 'POST',
        ),
      ),
    filterRepositories: (enabled: boolean) =>
      action(() => brainAdminRequest('/access/repository-policy', { enabled }, 'PUT')),
    lock: () => {
      setState(null);
      setIssued(null);
      setError('');
    },
  };
}
