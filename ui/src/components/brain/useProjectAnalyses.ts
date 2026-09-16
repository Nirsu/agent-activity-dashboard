import { brainConfig } from './config';
import { useEffect, useRef, useState } from 'react';
import { brainRequest } from './api';
import type { Analysis, AnalysisRun, AnalysesState, SourceSelection } from './types';

export function useProjectAnalyses() {
  const [state, setState] = useState<AnalysesState | null>(null);
  const [projectId, setProjectId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [findingId, setFindingId] = useState('');
  const [commit, setCommit] = useState('');
  const [baseCommit, setBaseCommit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [document, setDocument] = useState<SourceSelection | null>(null);
  const detailVersion = useRef(0);
  const stateVersion = useRef(0);

  async function refresh() {
    const version = ++stateVersion.current;
    const next = await brainRequest<AnalysesState>('/agents');
    if (version === stateVersion.current) {
      setState(next);
      setProjectId((currentId) =>
        next.projects.some((project) => project.id === currentId)
          ? currentId
          : next.projects[0]?.id || '',
      );
    }
    return next;
  }

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refresh();
      } catch (error) {
        if (!stopped) {
          setError(error instanceof Error ? error.message : 'Connection interrupted.');
        }
      }
      if (!stopped) {
        timer = setTimeout(poll, brainConfig.ui.pollIntervalMs);
      }
    }
    void poll();
    return () => {
      stopped = true;
      ++stateVersion.current;
      ++detailVersion.current;
      clearTimeout(timer);
    };
  }, []);

  const project = state?.projects.find((project) => project.id === projectId);
  const runs = state?.runs.filter((run) => run.projectId === projectId) ?? [];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0];

  async function loadDetail(runId: string) {
    const version = ++detailVersion.current;
    const next = await brainRequest<Analysis>(`/analyses/${encodeURIComponent(runId)}`);
    if (version === detailVersion.current) {
      setAnalysis(next);
    }
  }

  useEffect(() => {
    if (!selectedRun) {
      ++detailVersion.current;
      setAnalysis(null);
      return;
    }
    void loadDetail(selectedRun.id).catch((error) => {
      setError(error instanceof Error ? error.message : 'Analysis unavailable.');
    });
    return () => {
      ++detailVersion.current;
    };
  }, [selectedRun, state?.activeRunId]);

  const detail = analysis?.id === selectedRun?.id ? analysis : null;
  const finding =
    detail?.findings.find((finding) => finding.id === findingId) ??
    detail?.findings.find((finding) => finding.outcome === 'difference') ??
    detail?.findings[0];
  const sources = detail?.sources ?? [];
  const locked = busy || Boolean(state?.activeRunId);

  function selectProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    setSelectedRunId('');
    setFindingId('');
    setCommit('');
    setBaseCommit('');
    setDocument(null);
  }

  function selectRun(runId: string) {
    setSelectedRunId(runId);
    setFindingId('');
    setDocument(null);
  }

  function openSource(sourceId: string, line?: number) {
    const source = sources.find((source) => source.id === sourceId);
    if (source) {
      setDocument({ source, line });
    } else {
      setError('This source is unavailable in the analysis snapshot.');
    }
  }

  async function startAnalysis() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const run = await brainRequest<AnalysisRun>('/analyses', {
        projectId,
        ...(commit.trim() ? { commit: commit.trim() } : {}),
        ...(baseCommit.trim() ? { baseCommit: baseCommit.trim() } : {}),
      });
      setSelectedRunId(run.id);
      setFindingId('');
      await refresh();
      setNotice('Analysis started. Stages and evidence will appear here.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to start the analysis.');
    } finally {
      setBusy(false);
    }
  }

  async function saveReview(decision: string, note: string) {
    if (!detail || !finding) {
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await brainRequest(`/analyses/${encodeURIComponent(detail.id)}/reviews`, {
        findingId: finding.id,
        decision,
        note,
        expectedReviewId: finding.reviews[0]?.id ?? '',
      });
      await loadDetail(detail.id);
      await refresh();
      setNotice('Review saved in memory.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Review was not saved.');
    } finally {
      setBusy(false);
    }
  }

  return {
    state,
    projectId,
    project,
    runs,
    selectedRun,
    detail,
    finding,
    sources,
    commit,
    setCommit,
    baseCommit,
    setBaseCommit,
    busy,
    locked,
    error,
    notice,
    document,
    selectProject,
    selectRun,
    selectFinding: setFindingId,
    openSource,
    closeSource: () => setDocument(null),
    dismissError: () => setError(''),
    startAnalysis,
    saveReview,
  };
}
