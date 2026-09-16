import type { DemoState } from './types';

export function DemoOverview({
  state,
  locked,
  activeRuleCount,
  sourceCount,
  pendingCount,
  hasDifferences,
  error,
  notice,
  loadingSource,
  onDismissError,
  onImport,
  onCompare,
}: {
  state: DemoState | null;
  locked: boolean;
  activeRuleCount: number;
  sourceCount: number;
  pendingCount: number;
  hasDifferences: boolean;
  error: string;
  notice: string;
  loadingSource: boolean;
  onDismissError: () => void;
  onImport: () => Promise<void>;
  onCompare: () => Promise<void>;
}) {
  const importLabel =
    state?.activeRun?.kind === 'import'
      ? 'Importing…'
      : state?.snapshot
        ? 'Refresh sources'
        : '1. Import sources';
  const stages = [
    {
      number: '01',
      title: 'Sources',
      subtitle: 'Notion exports + Git commit',
      done: Boolean(state?.snapshot),
    },
    {
      number: '02',
      title: 'Reading A / B',
      subtitle: 'Fixed extraction and classification',
      done: Boolean(state?.snapshot),
    },
    {
      number: '03',
      title: 'Memory',
      subtitle: `${sourceCount} documents and files`,
      done: Boolean(state?.snapshot),
    },
    {
      number: '04',
      title: 'Comparison',
      subtitle: `${activeRuleCount} active rules`,
      done: Boolean(state?.comparisonReady),
    },
    {
      number: '05',
      title: 'Human review',
      subtitle: `${pendingCount} questions to review`,
      done: hasDifferences && pendingCount === 0,
    },
  ];

  return (
    <>
      <div className="brain-hero">
        <div>
          <div className="brain-eyebrow">SHARED MEMORY / LOCAL PILOT</div>
          <h1>
            Harmony Brain<span className="brain-demo">DEMO</span>
          </h1>
          <p>Decisions and code, with evidence for human review.</p>
        </div>
        <div className="brain-actions">
          <button
            className={`brain-button ${state?.snapshot ? '' : 'primary'}`}
            disabled={locked || !state}
            onClick={() => void onImport()}
          >
            {importLabel}
          </button>
          <button
            className={`brain-button ${activeRuleCount ? 'primary' : ''}`}
            disabled={locked || !activeRuleCount}
            onClick={() => void onCompare()}
          >
            {state?.activeRun?.kind === 'compare' ? 'Analyzing…' : 'Run comparison'}
          </button>
        </div>
      </div>
      <div className="brain-mode">
        <span className="brain-mode-dot" />
        <strong>Demo without AI</strong> · fixed extraction and rules
        <span className="brain-mode-right">Read-only sources · local session</span>
      </div>
      {error && (
        <div className="brain-error" role="alert">
          {error}
          <button onClick={onDismissError} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {(state?.activeRun || notice || loadingSource) && (
        <div className="brain-notice" role="status">
          {state?.activeRun?.stage ?? (loadingSource ? 'Opening source…' : notice)}
        </div>
      )}
      <div className="brain-pipeline" aria-label="Pipeline stages">
        {stages.map((stage) => (
          <div className={`brain-step ${stage.done ? 'done' : ''}`} key={stage.number}>
            <span className="brain-step-number">{stage.done ? '✓' : stage.number}</span>
            <div>
              <strong>{stage.title}</strong>
              <small>{stage.subtitle}</small>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
