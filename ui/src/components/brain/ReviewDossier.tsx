import { brainConfig } from './config';
import { useState } from 'react';
import { formatDate, statusLabels } from './presentation';
import { CitationEvidence } from './CitationEvidence';
import type { BrainSource, Finding, OpenSource, Requirement } from './types';

export function ReviewDossier({
  finding,
  requirement,
  sources,
  reviewAllowed,
  reviewKey,
  disabled,
  savingReview = false,
  onOpenSource,
  onSaveReview,
}: {
  finding: Finding;
  requirement?: Requirement;
  sources: BrainSource[];
  reviewAllowed: boolean;
  reviewKey: string;
  disabled: boolean;
  savingReview?: boolean;
  onOpenSource: OpenSource;
  onSaveReview: (decision: string, note: string) => Promise<void>;
}) {
  return (
    <article className="brain-dossier" id="brain-analysis-dossier" aria-label={finding.title}>
      <div className="brain-section-head">
        <h3>{finding.title}</h3>
        <span className={`brain-badge ${finding.outcome}`}>{statusLabels[finding.outcome]}</span>
      </div>
      <div className="brain-evidence-grid">
        <section>
          <h4>Requirement being checked</h4>
          {requirement && (
            <div className="brain-requirement-statement">
              <p>{requirement.statement}</p>
              <small>Applies to: {requirement.scope}</small>
            </div>
          )}
          <CitationEvidence
            citations={[finding.decision]}
            sources={sources}
            onOpenSource={onOpenSource}
          />
        </section>
        <section>
          <h4>Code evidence</h4>
          {finding.evidence.length ? (
            <CitationEvidence
              citations={finding.evidence}
              sources={sources}
              onOpenSource={onOpenSource}
            />
          ) : (
            <p>Insufficient evidence in the snapshot.</p>
          )}
        </section>
      </div>
      <section className="brain-assessment">
        <h4>How the code relates to the requirement</h4>
        <p className="brain-explanation">{finding.explanation}</p>
      </section>
      {finding.question && finding.outcome !== 'aligned' && (
        <div className="brain-question">
          <span>
            {finding.outcome === 'difference' ? 'HUMAN REVIEW QUESTION' : 'ANALYSIS NOTE'}
          </span>
          <p>{finding.question}</p>
        </div>
      )}
      <section className="brain-assessment">
        <h4>Limits of this finding</h4>
        <p className="brain-limitation">{finding.limitation}</p>
      </section>
      {finding.outcome !== 'difference' && (
        <p className="brain-agents-outcome-note">
          {finding.outcome === 'aligned'
            ? 'An observed match is limited to this evidence. It is not a human approval of the project.'
            : 'Brain cannot conclude from this evidence. Add the missing specification or code, then run another analysis.'}
        </p>
      )}
      {reviewAllowed && finding.outcome === 'difference' && (
        <ReviewForm
          key={`${reviewKey}-${finding.id}-${finding.reviews[0]?.id ?? ''}`}
          finding={finding}
          disabled={disabled}
          saving={savingReview}
          onSave={onSaveReview}
        />
      )}
      {finding.reviews.length > 0 && (
        <section className="brain-review-history">
          <h4>Review history</h4>
          {finding.reviews.map((review) => (
            <div key={review.id}>
              <strong>{statusLabels[review.decision] ?? review.decision}</strong>
              <small>
                {formatDate(review.at)} · {review.actor}
              </small>
              <p>{review.note}</p>
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

function ReviewForm({
  finding,
  disabled,
  saving,
  onSave,
}: {
  finding: Finding;
  disabled: boolean;
  saving: boolean;
  onSave: (decision: string, note: string) => Promise<void>;
}) {
  const [decision, setDecision] = useState('');
  const [note, setNote] = useState('');
  const decisionInputId = `decision-${finding.id}`;
  const noteInputId = `note-${finding.id}`;
  const decisionDescriptions: Record<string, string> = {
    confirmed: 'Record that the code should change to match the specification.',
    documentation:
      'Record that the specification should be updated to reflect the intended behavior.',
    false_positive: 'Explain why the reported difference does not apply.',
    exception: 'Document the accepted deviation and the scope where it is allowed.',
    investigate: 'Record what still needs to be checked before a decision can be made.',
  };
  return (
    <form
      className="brain-review-form"
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(decision, note);
      }}
    >
      <h4>{finding.reviews.length ? 'Revise your review' : 'Your review'}</h4>
      <label htmlFor={decisionInputId}>Human decision</label>
      <select
        id={decisionInputId}
        required
        disabled={disabled}
        value={decision}
        aria-describedby={`${decisionInputId}-help`}
        onChange={(event) => setDecision(event.target.value)}
      >
        <option value="" disabled>
          Choose a decision…
        </option>
        {['confirmed', 'documentation', 'false_positive', 'exception', 'investigate'].map(
          (value) => (
            <option key={value} value={value}>
              {statusLabels[value]}
            </option>
          ),
        )}
      </select>
      <p className="brain-agents-help" id={`${decisionInputId}-help`}>
        {decisionDescriptions[decision] ?? 'Choose how to resolve the suspected difference.'}
      </p>
      <label htmlFor={noteInputId}>Reason and scope</label>
      <textarea
        id={noteInputId}
        required
        disabled={disabled}
        minLength={brainConfig.review.minNoteCharacters}
        maxLength={brainConfig.review.maxNoteCharacters}
        rows={3}
        value={note}
        aria-describedby={`${noteInputId}-help`}
        placeholder="Explain your decision and which feature or requirement it applies to."
        onChange={(event) => setNote(event.target.value)}
      />
      <small className="brain-agents-help" id={`${noteInputId}-help`}>
        At least {brainConfig.review.minNoteCharacters} characters. Your reason is preserved with
        this review.
      </small>
      <div className="brain-review-form-bottom">
        <small>Saved with your session identity. Source documents stay unchanged.</small>
        <button
          className="brain-button primary"
          disabled={
            disabled || !decision || note.trim().length < brainConfig.review.minNoteCharacters
          }
        >
          {saving ? 'Saving review…' : 'Save review'}
        </button>
      </div>
    </form>
  );
}
