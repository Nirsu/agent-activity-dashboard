import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDate } from './presentation';
import { formatPrice, pricingColumns } from './pricingPresentation';
import { pricingEvidenceRows } from './pricingEvidence';
import type { PricingVerification as Verification } from './pricingTypes';

export default function PricingVerification({
  verification,
  onClose,
}: {
  verification: Verification;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const panel = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.documentElement.style.overflow;
    panel?.showModal();
    document.documentElement.style.overflow = 'hidden';
    return () => {
      panel?.close();
      document.documentElement.style.overflow = overflow;
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  const rows = pricingEvidenceRows(verification.evidence ?? '');
  return (
    <dialog
      ref={dialog}
      className="brain-pricing-reader"
      aria-labelledby="pricing-verification-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="brain-pricing-reader-header">
        <div>
          <span className="brain-eyebrow">PRICE VERIFICATION</span>
          <h2 id="pricing-verification-title">{verification.model}</h2>
        </div>
        <button className="brain-button" onClick={onClose} autoFocus>
          Close
        </button>
      </header>
      <div className="brain-pricing-reader-content">
        <div className="brain-pricing-reader-source">
          <a href={verification.sourceUrl} target="_blank" rel="noreferrer">
            Open official pricing page ↗
          </a>
          {verification.checkedAt && <span>Checked {formatDate(verification.checkedAt)}</span>}
        </div>
        <section aria-labelledby="pricing-verification-rates">
          <h3 id="pricing-verification-rates">
            {verification.proposed ? 'Proposed prices' : 'Saved prices'}
          </h3>
          <p className="brain-pricing-reader-caption">
            USD per 1 million tokens · Standard, short-context text usage
          </p>
          <dl className="brain-pricing-reader-rates">
            {pricingColumns.map(({ key, label }) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{formatPrice(verification.rates?.[key])}</dd>
              </div>
            ))}
          </dl>
        </section>
        {verification.notes && (
          <section className="brain-pricing-reader-notes">
            <h3>Scope & limitations</h3>
            <p>{verification.notes}</p>
          </section>
        )}
        {rows.length > 0 && (
          <section>
            <h3>Values from the official source</h3>
            <p className="brain-pricing-reader-caption">
              The quoted column headers and model rows are paired below for readability. Additional
              context and cache-write rates are not included in the saved estimate.
            </p>
            {rows.map((row, index) => (
              <dl className="brain-pricing-source-values" key={index}>
                {row.fields.map(({ label, value }, cell) => (
                  <div key={cell}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ))}
          </section>
        )}
        <details className="brain-pricing-original-excerpts" open={rows.length ? undefined : true}>
          <summary>Original source excerpts</summary>
          {(verification.evidence ?? '').split(/\n\s*\[…\]\s*\n/).map((excerpt, index) => (
            <section key={index}>
              <h4>Excerpt {index + 1}</h4>
              <Markdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  img: ({ alt }) => <span>{alt}</span>,
                  a: ({ children }) => <span>{children}</span>,
                  table: ({ children }) => (
                    <div className="brain-pricing-excerpt-table">
                      <table>{children}</table>
                    </div>
                  ),
                }}
              >
                {excerpt}
              </Markdown>
            </section>
          ))}
        </details>
      </div>
    </dialog>
  );
}
