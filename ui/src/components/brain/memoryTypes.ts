export type SourceApproval = 'draft' | 'approved' | 'withdrawn';

export type MemorySource = {
  id: string;
  kind: 'notion' | 'git' | 'review';
  title: string;
  url?: string;
  pageId?: string;
  projectIds: string[];
  shared: boolean;
  mandatory: boolean;
  approval: SourceApproval;
  status: 'pending' | 'syncing' | 'ready' | 'failed' | 'withdrawn';
  currentSourceId?: string;
  revision?: string;
  lastSyncedAt?: string;
  error?: string;
};

export type SyncJob = {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type NotionConnection = {
  configured: boolean;
  connected: boolean;
  status: string;
  workspace?: string;
  lastCheckedAt?: string;
  error?: string;
};

export type MemoryState = {
  sources: MemorySource[];
  jobs: SyncJob[];
  cognee: { configured: boolean; available: boolean; reason?: string };
  notion: NotionConnection;
  projects: { id: string; name: string }[];
  syncIntervalMs: number;
};

export type SourceRegistration = {
  pageId: string;
  title?: string;
  projectIds: string[];
  shared: boolean;
  mandatory: boolean;
  approval: SourceApproval;
};
