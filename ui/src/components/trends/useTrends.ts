import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/ws';
import type { TrendsPeriod, TrendsReport } from '../../../../server/src/trends/types';

export type {
  TrendsReport,
  TrendsBucket,
  TrendsTotals,
  TrendsBreakdown,
  TrendsPeriod,
} from '../../../../server/src/trends/types';

export interface TrendsSelection {
  period: TrendsPeriod;
  start?: string;
  end?: string;
}

interface RequestState {
  key: string;
  data: TrendsReport | null;
  error: string | null;
  loading: boolean;
}

export function trendsRequestPath(selection: TrendsSelection): string {
  const parameters = new URLSearchParams({ period: selection.period });
  if (selection.period === 'custom') {
    parameters.set('start', selection.start ?? '');
    parameters.set('end', selection.end ?? '');
  }
  return `/api/trends?${parameters}`;
}

export function useTrends() {
  const [selection, setSelection] = useState<TrendsSelection>({ period: '14d' });
  const [revision, setRevision] = useState(0);
  const key = trendsRequestPath(selection);
  const [state, setState] = useState<RequestState>({
    key,
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) {
        return;
      }
      pending = true;
      setState((previous) => ({
        key,
        data: previous.key === key ? previous.data : null,
        error: null,
        loading: true,
      }));
      try {
        const response = await apiFetch(key, { signal: controller.signal });
        if (!response.ok) {
          throw new Error('History request failed');
        }
        const result: TrendsReport = await response.json();
        if (!controller.signal.aborted) {
          setState({ key, data: result, error: null, loading: false });
        }
      } catch {
        if (!controller.signal.aborted) {
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : null,
            error: 'History could not be loaded. Try again using Retry loading.',
            loading: false,
          }));
        }
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [key, revision]);

  // Never display another range's totals before the new effect runs or after an
  // obsolete request returns. Failed refreshes may retain this range's data.
  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: current ? state.loading : true,
    selection,
    setSelection,
    refresh: () => setRevision((value) => value + 1),
  };
}
