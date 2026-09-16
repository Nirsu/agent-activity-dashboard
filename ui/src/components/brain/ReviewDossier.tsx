import { brainConfig } from './config';
import { useState } from 'react';
import { formatDate, statusLabels } from './presentation';
import type { BrainSource, Citation, Finding, OpenSource } from './types';

export function CitationButton({
  citation,
  sources,
  onOpenSource,
  missingSourceLabel = 'Source',
}: {
  citation: Citation;
  sources: BrainSource[];
  onOpenSource: OpenSource;
  missingSourceLabel?: string;
}) {
  const sourceTitle =
    sources.find((source) => source.id === citation.sourceId)?.title ?? missingSourceLabel;
  return (
    <button
      className="brain-citation"
      onClick={() => onOpenSource(citation.sourceId, citation.line)}
    >
      <span>
        {sourceTitle} <small>· line {citation.line} ↗</small>
      </span>
      <code>{citation.quote}</code>
    </button>
  );
}

export function ReviewDossier({
  finding,
  sources,
  variant,
  historical = false,
  reviewAllowed,
  reviewKey,
  disabled,
  onOpenSource,
  onSaveReview,
}: {
  finding: Finding;
  sources: BrainSource[];
  variant: 'analysis' | 'demo';
  historical?: boolean;
  reviewAllowed: boolean;
  reviewKey: string;
  disabled: boolean;
  onOpenSource: OpenSource;
  onSaveReview: (decision: string, note: string) => Promise<void>;
}) {
  const isDemo = variant === 'demo';
  const missingSourceLabel = isDemo ? 'Archived source revision' : 'Source';
  return (
    <article className="brain-dossier">
      <div className="brain-section-head">
        <h3>{finding.title}</h3>
        <span className={`brain-badge ${finding.outcome}`}>{statusLabels[finding.outcome]}</span>
      </div>
      {historical && (
        <p className="brain-warning">
          Read-only archive. Sources or rules have changed: run the comparison again to review the
          current scope.
        </p>
      )}
      <p className="brain-explanation">{finding.explanation}</p>
      <div className="brain-evidence-grid">
        <section>
          <h4>{isDemo ? '01 / What the decision says' : 'What the specification says'}</h4>
          <CitationButton
            citation={finding.decision}
            sources={sources}
            onOpenSource={onOpenSource}
            missingSourceLabel={missingSourceLabel}
          />
        </section>
        <section>
          <h4>{isDemo ? '02 / What the code declares' : 'What the code shows'}</h4>
          {finding.evidence.length ? (
            finding.evidence.map((citation, index) => (
              <div key={index}>
                <CitationButton
                  citation={citation}
                  sources={sources}
                  onOpenSource={onOpenSource}
                  missingSourceLabel={missingSourceLabel}
                />
              </div>
            ))
          ) : (
            <p>Insufficient evidence in the snapshot.</p>
          )}
        </section>
      </div>
      {(isDemo || finding.question) && (
        <div className="brain-question">
          <span>THE QUESTION TO RESOLVE</span>
          <p>{finding.question}</p>
        </div>
      )}
      <p className="brain-limitation">{finding.limitation}</p>
      {reviewAllowed && finding.outcome === 'difference' && (
        <ReviewForm
          key={`${reviewKey}-${finding.id}-${finding.reviews[0]?.id ?? ''}`}
          finding={finding}
          variant={variant}
          disabled={disabled}
          onSave={onSaveReview}
        />
      )}
      {finding.reviews.length > 0 && (
        <section className="brain-review-history">
          <h4>Review history</h4>
          {finding.reviews.map((review) => (
            <div key={review.id}>
              <strong>{statusLabels[review.decision] ?? review.decision}</strong>
              {isDemo ? (
                <time>{formatDate(review.at, 'medium')}</time>
              ) : (
                <small>
                  {formatDate(review.at)} · {review.actor}
                </small>
              )}
              <p>{review.note}</p>
              {isDemo && <small>{review.actor}</small>}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

function ReviewForm({
  finding,
  variant,
  disabled,
  onSave,
}: {
  finding: Finding;
  variant: 'analysis' | 'demo';
  disabled: boolean;
  onSave: (decision: string, note: string) => Promise<void>;
}) {
  const [decision, setDecision] = useState('');
  const [note, setNote] = useState('');
  const isDemo = variant === 'demo';
  const decisionInputId = isDemo ? `decision-${finding.id}` : 'brain-agent-decision';
  const noteInputId = isDemo ? `note-${finding.id}` : 'brain-agent-note';
  return (
    <form
      className="brain-review-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(decision, note);
      }}
    >
      <h4>{isDemo && finding.reviews.length ? 'Add to or revise the review' : 'Your review'}</h4>
      <label htmlFor={decisionInputId}>Human decision</label>
      <select
        id={decisionInputId}
        required
        value={decision}
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
      <label htmlFor={noteInputId}>Reason and scope</label>
      <textarea
        id={noteInputId}
        required
        minLength={brainConfig.review.minNoteCharacters}
        maxLength={brainConfig.review.maxNoteCharacters}
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={
          isDemo
            ? 'For example: The dashboard is an internal demo tool. SQLite is accepted for this local scope.'
            : undefined
        }
      />
      <div className="brain-review-form-bottom">
        <small>
          {isDemo ? (
            <>
              Local session · identity not verified.
              <br />
              This review changes neither Notion nor the code.
            </>
          ) : (
            'Session identity · sources are not changed automatically.'
          )}
        </small>
        <button
          className="brain-button primary"
          disabled={
            disabled || !decision || note.trim().length < brainConfig.review.minNoteCharacters
          }
        >
          Save review
        </button>
      </div>
    </form>
  );
}
