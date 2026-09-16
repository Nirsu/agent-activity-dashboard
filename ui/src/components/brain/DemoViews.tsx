import { brainConfig } from './config';
import { formatDate, statusLabels } from './presentation';
import { CitationButton, ReviewDossier } from './ReviewDossier';
import type { BrainSource, DemoFinding, DemoRule, DemoRun, OpenSource } from './types';

export function DemoRules({
  rules,
  scope,
  sources,
  activeRuleCount,
  activationNote,
  locked,
  onActivationNoteChange,
  onToggleRule,
  onOpenSource,
}: {
  rules: DemoRule[];
  scope: string;
  sources: BrainSource[];
  activeRuleCount: number;
  activationNote: string;
  locked: boolean;
  onActivationNoteChange: (note: string) => void;
  onToggleRule: (rule: DemoRule) => Promise<void>;
  onOpenSource: OpenSource;
}) {
  return (
    <>
      <div className="brain-section-head">
        <div>
          <h2>Confirm how decisions apply to code</h2>
          <p>
            Three checks proposed from the published document. Activation is explicit and recorded.
          </p>
        </div>
        <span className="brain-badge">
          {activeRuleCount} / {rules.length} active
        </span>
      </div>
      <div className="brain-scope">
        <strong>Demo scope</strong>
        <p>{scope}</p>
        <label htmlFor="brain-scope-note">Reason for activation</label>
        <textarea
          id="brain-scope-note"
          value={activationNote}
          maxLength={brainConfig.review.maxActivationNoteCharacters}
          onChange={(event) => onActivationNoteChange(event.target.value)}
          rows={2}
        />
      </div>
      <div className="brain-rule-list">
        {rules.map((rule) => (
          <article key={rule.id} className="brain-rule">
            <div className="brain-rule-title">
              <span className={`brain-rule-dot ${rule.active ? 'active' : ''}`} />
              <div>
                <h3>{rule.title}</h3>
                <p>{rule.description}</p>
              </div>
              <button
                className={`brain-button ${rule.active ? '' : 'primary'}`}
                disabled={
                  locked ||
                  (!rule.active &&
                    activationNote.trim().length < brainConfig.review.minNoteCharacters)
                }
                onClick={() => void onToggleRule(rule)}
              >
                {rule.active ? 'Deactivate' : 'Activate for demo'}
              </button>
            </div>
            <CitationButton
              citation={rule.source}
              sources={sources}
              onOpenSource={onOpenSource}
              missingSourceLabel="Archived source revision"
            />
            <small>
              {rule.active
                ? `Activated on ${formatDate(rule.activatedAt!, 'medium')} · ${rule.activationNote}`
                : 'Inactive proposal · publication alone does not establish applicability.'}
            </small>
          </article>
        ))}
      </div>
      {!rules.length && (
        <div className="brain-empty">
          <h3>No proposed rules</h3>
          <p>
            The pilot expects the BFF / NestJS, database / PostgreSQL and extranet / React + Vite
            entries in the published baseline.
          </p>
        </div>
      )}
    </>
  );
}

export function DemoReviews({
  currentFindings,
  shownFindings,
  selectedFinding,
  sources,
  activeRuleCount,
  historical,
  locked,
  onHistoricalChange,
  onSelectFinding,
  onOpenSource,
  onSaveReview,
  onExport,
}: {
  currentFindings: DemoFinding[];
  shownFindings: DemoFinding[];
  selectedFinding?: DemoFinding;
  sources: BrainSource[];
  activeRuleCount: number;
  historical: boolean;
  locked: boolean;
  onHistoricalChange: (historical: boolean) => void;
  onSelectFinding: (findingId: string) => void;
  onOpenSource: OpenSource;
  onSaveReview: (decision: string, note: string) => Promise<void>;
  onExport: () => void;
}) {
  return (
    <>
      <div className="brain-section-head">
        <div>
          <h2>Comparison produces a question.</h2>
          <p>
            A technical difference may be justified. Review the evidence and scope before deciding.
          </p>
        </div>
        <button className="brain-button" disabled={!currentFindings.length} onClick={onExport}>
          Export report ↓
        </button>
      </div>
      <div className="brain-review-summary">
        <span>
          <b>{currentFindings.filter((finding) => finding.outcome === 'difference').length}</b>{' '}
          suspected differences
        </span>
        <span>
          <b>{currentFindings.filter((finding) => finding.outcome === 'aligned').length}</b> matches
        </span>
        <span>
          <b>{currentFindings.filter((finding) => finding.outcome === 'insufficient').length}</b>{' '}
          need more evidence
        </span>
        <label>
          <input
            type="checkbox"
            checked={historical}
            onChange={(event) => onHistoricalChange(event.target.checked)}
          />{' '}
          Include history
        </label>
      </div>
      {!shownFindings.length ? (
        <div className="brain-empty">
          <h3>{activeRuleCount ? 'Ready to compare' : 'Activate rules first'}</h3>
          <p>
            {activeRuleCount
              ? 'Run the comparison to prepare the review cases.'
              : 'Open “Rules & scope” to choose which checks to run.'}
          </p>
        </div>
      ) : (
        <div className="brain-review-layout">
          <aside className="brain-finding-list" aria-label="Comparison results">
            {shownFindings.map((finding) => (
              <button
                className={selectedFinding?.id === finding.id ? 'selected' : ''}
                key={finding.id}
                onClick={() => onSelectFinding(finding.id)}
              >
                <span className={`brain-badge ${finding.outcome}`}>
                  {statusLabels[finding.outcome]}
                </span>
                <strong>{finding.title}</strong>
                <small>
                  {!finding.current ? 'Archive · ' : ''}
                  {finding.reviews[0]
                    ? statusLabels[finding.reviews[0].decision]
                    : finding.outcome === 'difference'
                      ? 'Needs review'
                      : 'Check result'}
                </small>
              </button>
            ))}
          </aside>
          {selectedFinding && (
            <ReviewDossier
              key={selectedFinding.id}
              finding={selectedFinding}
              sources={sources}
              variant="demo"
              historical={!selectedFinding.current}
              reviewAllowed={selectedFinding.current}
              reviewKey={selectedFinding.id}
              disabled={locked}
              onOpenSource={onOpenSource}
              onSaveReview={onSaveReview}
            />
          )}
        </div>
      )}
    </>
  );
}

export function DemoRuns({ runs }: { runs: DemoRun[] }) {
  return (
    <>
      <div className="brain-section-head">
        <div>
          <h2>Traceable runs</h2>
          <p>
            Each run preserves its status. The last complete memory remains available after a
            failure.
          </p>
        </div>
        <span className="brain-badge">AI cost: €0 · no calls</span>
      </div>
      <div className="brain-runs">
        {runs.map((run) => (
          <details key={run.id} open={run.status === 'running' || run.status === 'failed'}>
            <summary>
              <span className={`brain-badge ${run.status}`}>{statusLabels[run.status]}</span>
              <strong>
                {run.kind === 'import' ? 'Import & memory' : 'Comparison & review preparation'}
              </strong>
              <time>{formatDate(run.startedAt, 'medium')}</time>
            </summary>
            <p>
              <code>{run.id}</code>
              {run.finishedAt && ` · Finished: ${formatDate(run.finishedAt, 'medium')}`}
            </p>
            <ol>
              {run.events.map((event, index) => (
                <li key={index}>
                  <time>{new Date(event.at).toLocaleTimeString('en-GB')}</time>
                  {event.message}
                </li>
              ))}
            </ol>
            {run.error && <p className="brain-warning">{run.error}</p>}
          </details>
        ))}
      </div>
    </>
  );
}
