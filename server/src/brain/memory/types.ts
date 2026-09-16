import type { Source } from '../sources.js';

export type SourceRegistration = {
  id: string;
  kind: 'notion' | 'git' | 'review';
  title: string;
  url?: string;
  pageId?: string;
  git?: { projectId: string; path: string };
  projectIds: string[];
  shared: boolean;
  mandatory: boolean;
  approval: 'draft' | 'approved' | 'withdrawn';
  status: 'pending' | 'syncing' | 'ready' | 'failed' | 'withdrawn';
  currentSourceId?: string;
  datasetId?: string;
  indexVersion?: string;
  revision?: string;
  lastSyncedAt?: string;
  error?: string;
  properties?: Record<string, unknown>;
  reviewContent?: string;
};

export type SyncJob = {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  attempts: number;
};

export type SourceExcerpt = {
  sourceId: string;
  startLine: number;
  endLine: number;
};

export type RetrievedEvidence = {
  sources: Source[];
  excerpts: SourceExcerpt[];
  datasets: string[];
  sourceIds: string[];
  retrievedAt: string;
  query: string;
  memoryVersion: string;
  contextVersion: string;
};
