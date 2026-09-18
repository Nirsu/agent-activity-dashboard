import { brainConfig } from './config';
import { useEffect, useRef, useState } from 'react';
import { brainAdminRequest, brainRequest } from './api';
import type { Analysis, AnalysisRun, AnalysesState, SourceSelection } from './types';

export function useProjectAnalyses() {
  const [state, setState] = useState<AnalysesState | null>(null);
  const [projectId, setProjectId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [findingId, setFindingId] = useState('');
  const [commit, setCommit] = useState('');
  const [baseCommit, setBaseCommit] = useState('');
  const [feature, setFeature] = useState('');
  const [ticket, setTicket] = useState('');
  const [pendingAction, setPendingAction] = useState<'analysis' | 'review' | null>(null);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [detailError, setDetailError] = useState<{ runId: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [document, setDocument] = useState<SourceSelection | null>(null);
  const detailVersion = useRef(0);
  const stateVersion = useRef(0);
  const linkedRunApplied = useRef('');

  async function refresh() {
    const version = ++stateVersion.current;
    const next = await brainRequest<AnalysesState>('/agents');
    if (version === stateVersion.current) {
      setState(next);
      setConnectionError('');
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
          setConnectionError(error instanceof Error ? error.message : 'Connection interrupted.');
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

  useEffect(() => {
    const linkedId = location.hash.split('/')[2];
    if (!linkedId || linkedRunApplied.current === linkedId) {
      return;
    }
    let decodedId: string;
    try {
      decodedId = decodeURIComponent(linkedId);
    } catch {
      return;
    }
    const linked = state?.runs.find((run) => run.id === decodedId);
    if (linked) {
      setProjectId(linked.projectId);
      setSelectedRunId(linked.id);
      linkedRunApplied.current = linkedId;
    }
  }, [state]);

  async function loadDetail(runId: string) {
    const version = ++detailVersion.current;
    try {
      const next = await brainRequest<Analysis>(`/analyses/${encodeURIComponent(runId)}`);
      if (version === detailVersion.current) {
        setAnalysis(next);
        setDetailError(null);
      }
    } catch (error) {
      if (version === detailVersion.current) {
        setDetailError({
          runId,
          message: error instanceof Error ? error.message : 'Analysis unavailable.',
        });
      }
    }
  }

  useEffect(() => {
    if (!selectedRun) {
      ++detailVersion.current;
      setAnalysis(null);
      return;
    }
    void loadDetail(selectedRun.id);
    return () => {
      ++detailVersion.current;
    };
  }, [selectedRun?.id, selectedRun?.detailVersion]);

  const detail = analysis?.id === selectedRun?.id ? analysis : null;
  const finding =
    detail?.findings.find((finding) => finding.id === findingId) ??
    detail?.findings.find((finding) => finding.outcome === 'difference') ??
    detail?.findings[0];
  const sources = detail?.sources ?? [];
  const busy = pendingAction !== null;
  const locked = busy || Boolean(state?.activeRunId);

  function selectProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    setSelectedRunId('');
    setFindingId('');
    setCommit('');
    setBaseCommit('');
    setFeature('');
    setTicket('');
    setDocument(null);
    setError('');
    setNotice('');
  }

  function selectRun(runId: string) {
    setSelectedRunId(runId);
    setFindingId('');
    setDocument(null);
    setError('');
    setNotice('');
  }

  function showActiveRun() {
    const run = state?.runs.find((run) => run.id === state.activeRunId);
    if (run) {
      selectProject(run.projectId);
      selectRun(run.id);
    }
  }

  function prepareRetry() {
    if (!selectedRun) {
      return;
    }
    setCommit(selectedRun.commit ?? '');
    setBaseCommit(selectedRun.baseCommit ?? '');
    setFeature(selectedRun.feature ?? '');
    setTicket(selectedRun.correlation?.ticket ?? '');
    setError('');
    setNotice('Previous setup restored. Check the settings above, then choose Run AI analysis.');
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
    setPendingAction('analysis');
    setError('');
    setNotice('');
    try {
      const run = await brainRequest<AnalysisRun>('/analyses', {
        projectId,
        ...(commit.trim() ? { commit: commit.trim() } : {}),
        ...(baseCommit.trim() ? { baseCommit: baseCommit.trim() } : {}),
        ...(feature.trim() ? { feature: feature.trim() } : {}),
        ...(ticket.trim() ? { ticket: ticket.trim(), workItemId: ticket.trim() } : {}),
      });
      ++stateVersion.current;
      setSelectedRunId(run.id);
      setFindingId('');
      setState(
        (current) =>
          current && {
            ...current,
            activeRunId: run.id,
            runs: [run, ...current.runs.filter((item) => item.id !== run.id)],
          },
      );
      setNotice('Analysis started. Stages and evidence will appear here.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to start the analysis.');
    } finally {
      setPendingAction(null);
    }
  }

  async function saveReview(decision: string, note: string) {
    if (!detail || !finding) {
      return;
    }
    setPendingAction('review');
    setError('');
    setNotice('');
    try {
      await brainAdminRequest(`/analyses/${encodeURIComponent(detail.id)}/reviews`, {
        findingId: finding.id,
        decision,
        note,
        expectedReviewId: finding.reviews[0]?.id ?? '',
      });
      setNotice('Review saved in memory.');
      await loadDetail(detail.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Review was not saved.');
    } finally {
      setPendingAction(null);
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
    feature,
    setFeature,
    ticket,
    setTicket,
    busy,
    savingReview: pendingAction === 'review',
    locked,
    error,
    connectionError,
    detailError: detailError?.runId === selectedRun?.id ? detailError?.message : undefined,
    notice,
    document,
    selectProject,
    selectRun,
    showActiveRun,
    prepareRetry,
    retryDetail: () => (selectedRun ? loadDetail(selectedRun.id) : Promise.resolve()),
    selectFinding: setFindingId,
    openSource,
    closeSource: () => setDocument(null),
    dismissError: () => setError(''),
    startAnalysis,
    saveReview,
  };
}
