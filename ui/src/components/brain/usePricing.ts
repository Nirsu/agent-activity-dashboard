import { useCallback, useEffect, useRef, useState } from 'react';
import { brainAdminRequest, brainRequest } from './api';
import { brainConfig } from './config';
import type { PricingState } from './pricingTypes';
export function usePricing(onAdminRequired: () => void) {
  const [state, setState] = useState<PricingState>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const writing = useRef(false);
  const refresh = useCallback(async () => {
    if (writing.current) {
      return;
    }
    const version = ++generation.current;
    try {
      const next = await brainRequest<PricingState>('/pricing');
      if (mounted.current && version === generation.current) {
        setState(next);
        setLoadError('');
      }
    } catch (error) {
      if (mounted.current && version === generation.current) {
        setLoadError(error instanceof Error ? error.message : 'Cannot load pricing.');
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if ((state?.job?.status !== 'running' && !state?.automation?.enabled) || busy) {
      return;
    }
    let pending = false;
    const timer = window.setInterval(
      async () => {
        if (pending) {
          return;
        }
        pending = true;
        await refresh();
        pending = false;
      },
      state?.job?.status === 'running'
        ? brainConfig.pricing.pollIntervalMs
        : brainConfig.pricing.automaticIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, [state?.job?.status, state?.automation?.enabled, busy, refresh]);
  function clearFeedback() {
    setError('');
    setNotice('');
  }
  async function action(path: string, body: unknown, successMessage = '') {
    if (writing.current) {
      return false;
    }
    writing.current = true;
    const version = ++generation.current;
    setBusy(true);
    clearFeedback();
    try {
      const next = await brainAdminRequest<PricingState>(`/pricing/${path}`, body);
      if (mounted.current && version === generation.current) {
        setState(next);
        setNotice(successMessage);
        setLoadError('');
      }
      return true;
    } catch (error) {
      if (mounted.current) {
        setError(error instanceof Error ? error.message : 'The pricing action failed.');
        if (error instanceof Error && 'status' in error && error.status === 403) {
          onAdminRequired();
        }
      }
      return false;
    } finally {
      writing.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  }
  return { state, error, loadError, notice, busy, refresh, action, clearFeedback };
}
