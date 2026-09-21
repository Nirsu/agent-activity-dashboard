import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/ws';
import { brainConfig } from './config';

export interface BrainActivityRun {
  id: string;
  projectId: string;
  projectName: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  stage: string;
  startedAt: string;
  finishedAt?: string;
  model: string;
  commit?: string;
  ticket?: string;
  workItemId?: string;
  originSessionId?: string;
  parentRunId?: string;
  usage: { inputTokens: number; outputTokens: number };
  usageKnown?: boolean;
  costUsd?: number | null;
  knownCostUsd?: number;
  costBasis?: 'calls' | 'legacy_uncached';
  activeRole?: string;
  callCount?: number | null;
  findingCount: number;
  differenceCount: number;
  pendingReviewCount?: number;
}

export function useBrainActivity() {
  const [runs, setRuns] = useState<BrainActivityRun[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await apiFetch('/api/brain/activity', { signal: controller.signal });
        if (!response.ok) {
          throw new Error('Brain activity is unavailable.');
        }
        const payload = (await response.json()) as { runs: BrainActivityRun[] };
        if (!controller.signal.aborted) {
          setRuns(payload.runs);
          setLoaded(true);
          setUpdatedAt(Date.now());
          setError('');
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(
            'Brain activity could not be refreshed. The last received state may be out of date.',
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(refresh, brainConfig.ui.pollIntervalMs);
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return { runs, error, loaded, updatedAt };
}
