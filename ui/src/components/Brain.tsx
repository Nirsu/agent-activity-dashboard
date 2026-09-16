import { lazy, Suspense } from 'react';
import { DemoOverview } from './brain/DemoOverview';
import { DemoReviews, DemoRules, DemoRuns } from './brain/DemoViews';
import { SourceLibrary } from './brain/SourceLibrary';
import { useDemoBrain } from './brain/useDemoBrain';
import './Brain.css';

export type { BrainSource } from './brain/types';

const BrainSourceViewer = lazy(() => import('./BrainSourceViewer'));
const BrainAgents = lazy(() => import('./BrainAgents'));

export function Brain() {
  const brain = useDemoBrain();
  const { state, tab } = brain;
  const tabs = [
    ['memory', 'Memory'],
    ['rules', 'Rules & scope'],
    ['review', `Reviews${brain.pending.length ? ` · ${brain.pending.length}` : ''}`],
    ['runs', 'Runs'],
    ['agents', 'Project analyses'],
  ] as const;

  return (
    <section className="brain" aria-label="Harmony Brain">
      {tab !== 'agents' && (
        <DemoOverview
          state={state}
          locked={brain.locked}
          activeRuleCount={brain.activeRuleCount}
          sourceCount={brain.sources.length}
          pendingCount={brain.pending.length}
          hasDifferences={brain.currentFindings.some((finding) => finding.outcome === 'difference')}
          error={brain.error}
          notice={brain.notice}
          loadingSource={brain.loadingSource}
          onDismissError={brain.dismissError}
          onImport={brain.importSources}
          onCompare={brain.runComparison}
        />
      )}
      <div className="brain-toolbar">
        <nav aria-label="Brain views">
          {tabs.map(([value, label]) => (
            <button
              key={value}
              className={tab === value ? 'active' : ''}
              onClick={() => brain.navigate(value)}
              aria-current={tab === value ? 'page' : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
        {tab !== 'agents' && state?.snapshot && (
          <span className="brain-revision" title={state.snapshot.commit}>
            {state.repo} <code>{state.snapshot.commit.slice(0, 8)}</code>
          </span>
        )}
      </div>
      <BrainContent brain={brain} />
      <footer className="brain-footer">
        <span>HARMONY BRAIN / MVP</span>
        <p>
          {tab === 'agents'
            ? 'Project specifications, Git snapshots and reviews preserved in memory.'
            : 'Captured sources, fixed checks and recorded decisions. No AI model is connected in this demo.'}
        </p>
      </footer>
      {brain.document && (
        <Suspense fallback={<p role="status">Opening reader…</p>}>
          <BrainSourceViewer
            source={brain.document.source}
            line={brain.document.line}
            sources={brain.sources}
            loading={brain.loadingSource}
            onSelect={brain.openSource}
            onClose={brain.closeSource}
          />
        </Suspense>
      )}
    </section>
  );
}

function BrainContent({ brain }: { brain: ReturnType<typeof useDemoBrain> }) {
  const { state, tab } = brain;
  if (tab === 'agents') {
    return (
      <Suspense fallback={<p role="status">Loading analyses…</p>}>
        <BrainAgents />
      </Suspense>
    );
  }
  if (!state) {
    return (
      <div className="brain-empty">
        <h2>Connecting to Brain…</h2>
        <p>Loading local memory.</p>
      </div>
    );
  }
  if (!state.snapshot) {
    return (
      <div className="brain-empty">
        <span className="brain-empty-symbol">◎</span>
        <h2>Sources are ready to read.</h2>
        <p>
          Import the available Notion exports and selected files from <strong>{state.repo}</strong>.
          <br />
          Browse the memory, activate rules, then review differences.
        </p>
        <div className="brain-empty-details">
          <span>01 · Dated sources</span>
          <span>02 · Browsable evidence</span>
          <span>03 · Recorded human decisions</span>
        </div>
      </div>
    );
  }

  switch (tab) {
    case 'memory':
      return (
        <SourceLibrary
          sources={brain.sources}
          snapshot={state.snapshot}
          repo={state.repo}
          query={brain.query}
          results={brain.results}
          kind={brain.kind}
          busy={brain.busy}
          onQueryChange={brain.changeQuery}
          onSearch={brain.searchMemory}
          onFilterChange={brain.setKind}
          onOpenSource={brain.openSource}
        />
      );
    case 'rules':
      return (
        <DemoRules
          rules={state.rules}
          scope={state.scope}
          sources={brain.sources}
          activeRuleCount={brain.activeRuleCount}
          activationNote={brain.activationNote}
          locked={brain.locked}
          onActivationNoteChange={brain.setActivationNote}
          onToggleRule={brain.toggleRule}
          onOpenSource={brain.openSource}
        />
      );
    case 'review':
      return (
        <DemoReviews
          currentFindings={brain.currentFindings}
          shownFindings={brain.shownFindings}
          selectedFinding={brain.selectedFinding}
          sources={brain.sources}
          activeRuleCount={brain.activeRuleCount}
          historical={brain.historical}
          locked={brain.locked}
          onHistoricalChange={brain.setHistorical}
          onSelectFinding={brain.selectFinding}
          onOpenSource={brain.openSource}
          onSaveReview={brain.saveReview}
          onExport={brain.exportReport}
        />
      );
    case 'runs':
      return <DemoRuns runs={state.runs} />;
  }
}
