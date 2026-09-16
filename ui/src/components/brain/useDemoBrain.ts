import { brainConfig } from './config';
import { useEffect, useRef, useState } from 'react';
import { brainRequest } from './api';
import { formatDate, statusLabels } from './presentation';
import type {
  BrainSource,
  BrainTab,
  DemoRule,
  DemoState,
  SearchResult,
  SourceSelection,
} from './types';

function currentTab(): BrainTab {
  const value = location.hash.split('/')[1];
  return value === 'rules' || value === 'review' || value === 'runs' || value === 'agents'
    ? value
    : 'memory';
}

export function useDemoBrain() {
  const [state, setState] = useState<DemoState | null>(null);
  const [tab, setTab] = useState<BrainTab>(currentTab);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [kind, setKind] = useState('all');
  const [document, setDocument] = useState<SourceSelection | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [historical, setHistorical] = useState(false);
  const [activationNote, setActivationNote] = useState(
    'Apply the baseline to the dashboard for this demo only; business scope requires human review.',
  );
  const sourceRequest = useRef(0);
  const stateRequest = useRef(0);
  const searchRequest = useRef(0);

  function navigate(nextTab: BrainTab) {
    setTab(nextTab);
    location.hash = nextTab === 'memory' ? 'brain' : `brain/${nextTab}`;
  }

  async function refresh() {
    const version = ++stateRequest.current;
    const next = await brainRequest<DemoState>('');
    if (version === stateRequest.current) {
      setState(next);
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
    const onHash = () => setTab(currentTab());
    addEventListener('hashchange', onHash);
    void poll();
    return () => {
      stopped = true;
      ++stateRequest.current;
      clearTimeout(timer);
      removeEventListener('hashchange', onHash);
    };
  }, []);

  async function performAction(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
      setNotice(message);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'An error occurred.');
    } finally {
      setBusy(false);
    }
  }

  async function openSource(sourceId: string, line?: number) {
    const version = ++sourceRequest.current;
    setLoadingSource(true);
    try {
      const source = await brainRequest<BrainSource>(`/sources/${sourceId}`);
      if (version === sourceRequest.current) {
        setDocument({ source, line });
      }
    } catch (error) {
      if (version === sourceRequest.current) {
        setError(error instanceof Error ? error.message : 'Source unavailable.');
      }
    } finally {
      if (version === sourceRequest.current) {
        setLoadingSource(false);
      }
    }
  }

  function closeSource() {
    ++sourceRequest.current;
    setLoadingSource(false);
    setDocument(null);
  }

  const sources = state?.sources ?? [];
  const currentFindings = state?.findings.filter((finding) => finding.current) ?? [];
  const pending = currentFindings.filter(
    (finding) =>
      finding.outcome === 'difference' &&
      (!finding.reviews.length || finding.reviews[0].decision === 'investigate'),
  );
  const activeRuleCount = state?.rules.filter((rule) => rule.active).length ?? 0;
  const locked = busy || Boolean(state?.activeRun);
  const shownFindings = state?.findings.filter((finding) => historical || finding.current) ?? [];
  const selectedFinding =
    shownFindings.find((finding) => finding.id === selectedFindingId) ??
    shownFindings.find((finding) => finding.outcome === 'difference') ??
    shownFindings[0];

  function importSources() {
    return performAction(async () => {
      ++searchRequest.current;
      await brainRequest('/runs', { kind: 'import' });
      navigate('rules');
      setResults(null);
    }, 'Import started. Sources will become available together once reading is complete.');
  }

  function runComparison() {
    return performAction(async () => {
      await brainRequest('/runs', { kind: 'compare' });
      navigate('review');
    }, 'Comparison started on the imported snapshot.');
  }

  function changeQuery(value: string) {
    ++searchRequest.current;
    setQuery(value);
    setResults(null);
  }

  function searchMemory() {
    return performAction(async () => {
      const version = ++searchRequest.current;
      const data = await brainRequest<{ results: SearchResult[] }>(
        `/search?q=${encodeURIComponent(query)}`,
      );
      if (version === searchRequest.current) {
        setResults(data.results);
      }
    }, 'Text search complete. Excerpts are shown without a generated answer.');
  }

  function toggleRule(rule: DemoRule) {
    return performAction(
      () =>
        brainRequest(
          `/rules/${rule.id}`,
          {
            active: !rule.active,
            note: activationNote,
          },
          'PUT',
        ),
      rule.active ? 'Rule deactivated.' : 'Rule activated for this demo scope.',
    );
  }

  async function saveReview(decision: string, note: string) {
    if (!selectedFinding) {
      return;
    }
    await performAction(
      () =>
        brainRequest(`/findings/${selectedFinding.id}/reviews`, {
          decision,
          note,
          expectedReviewId: selectedFinding.reviews[0]?.id ?? '',
        }),
      'Review saved. Update the sources manually if needed.',
    );
  }

  function exportReport() {
    if (!state) {
      return;
    }
    const sourceName = (sourceId: string) =>
      sources.find((source) => source.id === sourceId)?.title ?? 'Archived source revision';
    const text = [
      '# Harmony Brain — demo report',
      '',
      `Date: ${formatDate(new Date().toISOString(), 'medium')}`,
      `Mode: ${state.engine}`,
      `Scope: ${state.scope}`,
      `Commit: ${state.snapshot?.commit ?? 'not imported'}`,
      '',
      ...currentFindings.flatMap((finding) => [
        `## ${finding.title} — ${statusLabels[finding.outcome]}`,
        finding.explanation,
        '',
        finding.question,
        `Source: ${sourceName(finding.decision.sourceId)} · line ${finding.decision.line}`,
        `> ${finding.decision.quote}`,
        '',
        ...finding.evidence.flatMap((citation) => [
          `Evidence: ${sourceName(citation.sourceId)} · line ${citation.line}`,
          `> ${citation.quote}`,
        ]),
        `Limitations: ${finding.limitation}`,
        ...finding.reviews.flatMap((review) => [
          `Review: ${statusLabels[review.decision]} · ${formatDate(review.at, 'medium')}`,
          review.note,
          `Reviewer: ${review.actor}`,
        ]),
        '',
      ]),
      'These reviews did not modify any Notion source or repository.',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = 'harmony-brain-demo.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), brainConfig.ui.downloadUrlReleaseDelayMs);
  }

  return {
    state,
    tab,
    navigate,
    error,
    busy,
    locked,
    notice,
    query,
    results,
    kind,
    setKind,
    document,
    loadingSource,
    sources,
    currentFindings,
    pending,
    activeRuleCount,
    shownFindings,
    selectedFinding,
    selectFinding: setSelectedFindingId,
    historical,
    setHistorical,
    activationNote,
    setActivationNote,
    openSource,
    closeSource,
    dismissError: () => setError(''),
    importSources,
    runComparison,
    changeQuery,
    searchMemory,
    toggleRule,
    saveReview,
    exportReport,
  };
}
