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
          <p>Read specifications, compare the commit, then prepare the human review.</p>
        </div>
        <span className="brain-badge">
          {state?.configured ? 'AI configured' : 'Setup required'}
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
      {!state ? (
        <p role="status">Loading projects…</p>
      ) : (
        <>
          <AnalysisSetup
            state={state}
            projectId={analyses.projectId}
            project={analyses.project}
            commit={analyses.commit}
            baseCommit={analyses.baseCommit}
            busy={analyses.busy}
            locked={analyses.locked}
            onSelectProject={analyses.selectProject}
            onCommitChange={analyses.setCommit}
            onBaseCommitChange={analyses.setBaseCommit}
            onStart={analyses.startAnalysis}
          />
          <AnalysisResults
            projectName={analyses.project?.name}
            configured={state.configured}
            runs={analyses.runs}
            selectedRun={analyses.selectedRun}
            detail={analyses.detail}
            finding={analyses.finding}
            busy={analyses.busy}
            locked={analyses.locked}
            onSelectRun={analyses.selectRun}
            onSelectFinding={analyses.selectFinding}
            onOpenSource={analyses.openSource}
            onSaveReview={analyses.saveReview}
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
