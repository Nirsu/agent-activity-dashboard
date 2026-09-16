import { useEffect, useRef, useState } from 'react';
import { brainRequest } from './api';
import type { MemoryGraph, GraphNode } from './graph';
import type { Analysis, BrainSource, SourceSelection } from './types';

export function useMemoryGraph() {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [scope, setScope] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [document, setDocument] = useState<SourceSelection | null>(null);
  const [sources, setSources] = useState<BrainSource[]>([]);
  const [loadingSource, setLoadingSource] = useState(false);
  const sourceVersion = useRef(0);
  const analysisId = useRef<string>();
  const sourceOpener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    ++sourceVersion.current;
    setDocument(null);
    setLoadingSource(false);
    setSourceError('');
    analysisId.current = undefined;
    sourceOpener.current = null;
    return () => {
      ++sourceVersion.current;
    };
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    brainRequest<MemoryGraph>(`/graph${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`)
      .then((data) => {
        if (!cancelled) {
          setGraph(data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : 'Memory graph unavailable.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scope, refreshVersion]);

  async function openSource(sourceId: string, line?: number, runId = analysisId.current) {
    const version = ++sourceVersion.current;
    setLoadingSource(true);
    setSourceError('');
    try {
      const available = runId
        ? (await brainRequest<Analysis>(`/analyses/${encodeURIComponent(runId)}`)).sources
        : [await brainRequest<BrainSource>(`/sources/${encodeURIComponent(sourceId)}`)];
      const source = available.find((item) => item.id === sourceId);
      if (!source) {
        throw new Error('This source is not available in the captured analysis.');
      }
      if (version === sourceVersion.current) {
        analysisId.current = runId;
        setSources(available);
        setDocument({ source, line });
      }
    } catch (error) {
      if (version === sourceVersion.current) {
        setSourceError(error instanceof Error ? error.message : 'Source unavailable.');
      }
    } finally {
      if (version === sourceVersion.current) {
        setLoadingSource(false);
      }
    }
  }

  function openNode(node: GraphNode) {
    if (node.sourceId) {
      const activeElement = globalThis.document.activeElement;
      sourceOpener.current = activeElement instanceof HTMLElement ? activeElement : null;
      analysisId.current = node.analysisId;
      void openSource(node.sourceId, node.line, node.analysisId);
    }
  }

  function closeSource() {
    ++sourceVersion.current;
    setDocument(null);
    setLoadingSource(false);
    setSourceError('');
    const opener = sourceOpener.current;
    requestAnimationFrame(() => {
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    });
  }

  return {
    graph,
    scope,
    setScope,
    loading,
    error,
    sourceError,
    document,
    sources,
    loadingSource,
    openNode,
    openSource,
    closeSource,
    refresh: () => setRefreshVersion((version) => version + 1),
  };
}
