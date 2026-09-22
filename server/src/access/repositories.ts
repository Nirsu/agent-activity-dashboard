import { createRequire } from 'node:module';

export const { normalizeRepositoryRemote } = createRequire(import.meta.url)(
  '../../../fleet/repository-url.cjs',
) as {
  normalizeRepositoryRemote(value: unknown): string | undefined;
};

export interface AuthorizedRepository {
  id: string;
  name: string;
  remote: string;
  enabled: boolean;
  brainProjectId?: string;
  brainScope?: string;
  brainCodePaths?: string[];
  createdAt: string;
}

export type BrainProjectStatus = {
  state: 'ready' | 'needs_access' | 'needs_references' | 'unverified' | 'disabled' | 'unsupported';
  message: string;
  checkedAt?: string;
};
