import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/ws';

export interface TrendDay {
  day: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  prompts: number;
  sessions: number;
  costKnown: boolean;
  tokensKnown: boolean;
  unknownUsageCount: number;
  unattributedCostUsd: number;
}

export interface TrendsData {
  enabled: boolean;
  days: TrendDay[];
  byStream: Array<{
    teamId: string;
    teamName?: string;
    costUsd: number;
    tokens: number;
    costKnown: boolean;
  }>;
}

export function useTrends() {
  const [data, setData] = useState<TrendsData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) {
        return;
      }
      pending = true;
      setLoading(true);
      try {
        const response = await apiFetch('/api/trends?days=14', { signal: controller.signal });
        if (!response.ok) {
          throw new Error('History request failed');
        }
        const result: TrendsData = await response.json();
        if (!controller.signal.aborted) {
          setData(result);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [revision]);

  return { data, error, loading, refresh: () => setRevision((value) => value + 1) };
}
