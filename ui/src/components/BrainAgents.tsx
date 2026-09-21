import { lazy, Suspense } from 'react';
import { AnalysisResults } from './brain/AnalysisResults';
import { AnalysisSetup } from './brain/AnalysisSetup';
import { useProjectAnalyses } from './brain/useProjectAnalyses';
import './BrainAgents.css';

const BrainSourceViewer = lazy(() => import('./BrainSourceViewer'));

export default function BrainAgents() {
  const analyses = useProjectAnalyses();
  const { state } = analyses;
  return (
    <div className="brain-agents">
      <header className="brain-section-head">
        <div>
          <div className="brain-eyebrow">DECISIONS / PROJECT CODE / HUMAN REVIEW</div>
          <h1>Project analyses</h1>
          <p>
            Select a project to review analysis results, inspect the evidence and record decisions.
          </p>
        </div>
        <span className="brain-badge">
          {!state ? 'Connecting…' : state.configured ? 'AI configured' : 'Setup required'}
        </span>
      </header>
      {analyses.error && (
        <div className="brain-error" role="alert">
          {analyses.error}
          <button onClick={analyses.dismissError} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {analyses.notice && (
        <p className="brain-notice" role="status">
          {analyses.notice}
        </p>
      )}
      {analyses.connectionError && (
        <p className="brain-warning" role="alert">
          {analyses.connectionError} Retrying automatically; displayed results may be out of date.
        </p>
      )}
      {!state ? (
        !analyses.connectionError && <p role="status">Loading projects…</p>
      ) : (
        <>
          <AnalysisSetup
            state={state}
            projectId={analyses.projectId}
            project={analyses.project}
            commit={analyses.commit}
            baseCommit={analyses.baseCommit}
            feature={analyses.feature}
            ticket={analyses.ticket}
            busy={analyses.busy}
            locked={analyses.locked}
            onSelectProject={analyses.selectProject}
            onCommitChange={analyses.setCommit}
            onBaseCommitChange={analyses.setBaseCommit}
            onFeatureChange={analyses.setFeature}
            onTicketChange={analyses.setTicket}
            onStart={analyses.startAnalysis}
            onShowActiveRun={() => {
              analyses.showActiveRun();
              document.getElementById('brain-analysis-results')?.scrollIntoView({ block: 'start' });
              document.getElementById('brain-analysis-results')?.focus({ preventScroll: true });
            }}
          />
          <AnalysisResults
            projectName={analyses.project?.name}
            configured={state.configured}
            runs={analyses.runs}
            selectedRun={analyses.selectedRun}
            detail={analyses.detail}
            detailError={analyses.detailError}
            savingReview={analyses.savingReview}
            finding={analyses.finding}
            busy={analyses.busy}
            locked={analyses.locked || Boolean(analyses.connectionError)}
            onSelectRun={analyses.selectRun}
            onSelectFinding={analyses.selectFinding}
            onOpenSource={analyses.openSource}
            onSaveReview={analyses.saveReview}
            onRetryDetail={analyses.retryDetail}
            onPrepareRetry={() => {
              analyses.prepareRetry();
              const setup = document.getElementById('brain-analysis-setup');
              if (setup instanceof HTMLDetailsElement) {
                setup.open = true;
              }
              setup?.scrollIntoView({ block: 'start' });
              document.getElementById('brain-agent-commit')?.focus({ preventScroll: true });
            }}
          />
        </>
      )}
      {analyses.document && (
        <Suspense fallback={<p role="status">Opening reader…</p>}>
          <BrainSourceViewer
            source={analyses.document.source}
            line={analyses.document.line}
            sources={analyses.sources}
            loading={false}
            onSelect={analyses.openSource}
            onClose={analyses.closeSource}
          />
        </Suspense>
      )}
    </div>
  );
}
