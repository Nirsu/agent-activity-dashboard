import { useCallback, useEffect, useRef, useState } from 'react';
import { brainAdminRequest, brainRequest } from './api';
import { brainConfig } from './config';
import type { BrainSource, SourceSelection } from './types';
import type { MemoryState, SourceRegistration } from './memoryTypes';

export function useBrainMemory() {
  const [state, setState] = useState<MemoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [adminRequired, setAdminRequired] = useState(false);
  const [notice, setNotice] = useState('');
  const [document, setDocument] = useState<SourceSelection | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const sourceVersion = useRef(0);
  const stateVersion = useRef(0);
  const sourceOpener = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    const version = ++stateVersion.current;
    try {
      const next = await brainRequest<MemoryState>('/memory');
      if (version === stateVersion.current) {
        setState(next);
        setConnectionError('');
      }
      return next;
    } catch (error) {
      if (version === stateVersion.current) {
        setConnectionError(error instanceof Error ? error.message : 'Memory is unavailable.');
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refresh();
      } catch {}
      if (!stopped) {
        timer = setTimeout(poll, brainConfig.ui.pollIntervalMs);
      }
    }
    void poll();
    return () => {
      stopped = true;
      ++stateVersion.current;
      ++sourceVersion.current;
      clearTimeout(timer);
    };
  }, [refresh]);

  async function mutate(path: string, body: unknown, method: string, message: string) {
    setBusy(true);
    setError('');
    setAdminRequired(false);
    setNotice('');
    try {
      await brainAdminRequest(path, body, method);
      setNotice(message);
      // The write succeeded even if refreshing its presentation fails afterward.
      try {
        await refresh();
      } catch {}
      return true;
    } catch (error) {
      setAdminRequired(error instanceof Error && 'status' in error && error.status === 403);
      setError(error instanceof Error ? error.message : 'The change could not be saved.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openSource(sourceId: string, line?: number) {
    if (!document) {
      const activeElement = globalThis.document.activeElement;
      sourceOpener.current = activeElement instanceof HTMLElement ? activeElement : null;
    }
    const version = ++sourceVersion.current;
    setLoadingSource(true);
    setError('');
    setAdminRequired(false);
    try {
      const source = await brainRequest<BrainSource>(`/sources/${encodeURIComponent(sourceId)}`);
      if (version === sourceVersion.current) {
        setDocument({ source, line });
      }
    } catch (error) {
      if (version === sourceVersion.current) {
        setError(error instanceof Error ? error.message : 'The captured source is unavailable.');
      }
    } finally {
      if (version === sourceVersion.current) {
        setLoadingSource(false);
      }
    }
  }

  function closeSource() {
    ++sourceVersion.current;
    setDocument(null);
    setLoadingSource(false);
    setError('');
    const opener = sourceOpener.current;
    sourceOpener.current = null;
    requestAnimationFrame(() => {
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    });
  }

  return {
    state,
    busy,
    error,
    connectionError,
    adminRequired,
    notice,
    document,
    loadingSource,
    refresh,
    openSource,
    closeSource,
    dismissError: () => {
      setError('');
      setConnectionError('');
      setAdminRequired(false);
    },
    retry: () => {
      void refresh().catch(() => {});
    },
    addSource: (source: SourceRegistration) =>
      mutate('/memory/sources', source, 'POST', 'Page added. Synchronization queued.'),
    updateSource: (sourceId: string, source: Omit<SourceRegistration, 'pageId' | 'title'>) =>
      mutate(
        `/memory/sources/${encodeURIComponent(sourceId)}`,
        source,
        'PUT',
        'Source settings saved.',
      ),
    approveSubpages: (sourceId: string) =>
      mutate(
        `/memory/sources/${encodeURIComponent(sourceId)}/approve-subpages`,
        {},
        'POST',
        'Current draft subpages approved. Indexing queued; future subpages keep the branch policy.',
      ),
    sync: (sourceId?: string) =>
      mutate(
        '/memory/sync',
        sourceId ? { sourceId } : {},
        'POST',
        'Synchronization queued. Follow its progress below.',
      ),
  };
}
