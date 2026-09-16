import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BrainSource } from './brain/types';

const sourceGroups = {
  notion: 'Notion documents',
  code: 'Repository files',
  review: 'Human decisions',
};

export default function BrainSourceViewer({
  source,
  sources,
  line,
  loading,
  error,
  onSelect,
  onClose,
}: {
  source: BrainSource;
  sources: BrainSource[];
  line?: number;
  loading: boolean;
  error?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const markdown = source.kind !== 'code' || source.path.endsWith('.md');
  const [raw, setRaw] = useState(Boolean(line) || !markdown);
  const [feedback, setFeedback] = useState('');
  const [wrap, setWrap] = useState(true);
  const lines = (source.content ?? '').split('\n');
  const groupedKinds = (['notion', 'code', 'review'] as const).filter((kind) =>
    sources.some((item) => item.kind === kind),
  );
  const sourceRevision =
    source.kind === 'code' ? (source.origin?.revision ?? source.revision) : source.revision;
  const revisionLabel =
    source.kind === 'notion'
      ? 'Notion snapshot'
      : source.kind === 'review'
        ? 'Recorded decision'
        : source.origin?.revision || source.status === 'observed'
          ? 'Git commit'
          : 'Captured revision';
  useEffect(() => {
    const reader = dialog.current;
    const previousOverflow = document.documentElement.style.overflow;
    reader?.showModal();
    document.documentElement.style.overflow = 'hidden';
    return () => {
      reader?.close();
      document.documentElement.style.overflow = previousOverflow;
    };
  }, []);
  useEffect(() => {
    setRaw(Boolean(line) || !markdown);
    setFeedback('');
  }, [source.id, line, markdown]);
  useEffect(() => {
    content.current?.scrollTo(0, 0);
    if (raw && line) {
      content.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
    }
  }, [source.id, source.content, line, raw]);
  const rendered = useMemo(
    () => (
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Source documents are untrusted: do not load remote images or embed raw HTML.
          img: ({ alt }) => (
            <span className="brain-image-placeholder">
              Illustration: {alt || 'image not loaded'}
            </span>
          ),
          a: ({ href, children }) =>
            /^https?:\/\//i.test(href ?? '') ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children} ↗
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({ children }) => (
            <div className="brain-markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {(source.content ?? '').replace(/^<\/?aside>\s*$/gm, '')}
      </Markdown>
    ),
    [source.content],
  );
  function closeReader() {
    dialog.current?.close();
    onClose();
  }
  return (
    <dialog
      ref={dialog}
      className="brain-reader"
      aria-labelledby="brain-reader-title"
      onCancel={(event) => {
        event.preventDefault();
        closeReader();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          closeReader();
        }
      }}
    >
      <div className={`brain-reader-shell ${sources.length < 2 ? 'single-source' : ''}`}>
        <aside className="brain-reader-files" aria-label="Memory files">
          <strong>Memory sources</strong>
          {groupedKinds.map((kind) => (
            <section key={kind}>
              <h3>{sourceGroups[kind]}</h3>
              {sources
                .filter((s) => s.kind === kind)
                .map((s) => (
                  <button
                    key={s.id}
                    className={s.id === source.id ? 'selected' : ''}
                    aria-current={s.id === source.id ? 'true' : undefined}
                    disabled={loading}
                    onClick={() => onSelect(s.id)}
                  >
                    <span>{s.kind === 'code' ? s.path : s.title}</span>
                  </button>
                ))}
            </section>
          ))}
        </aside>
        <div className="brain-reader-main" aria-busy={loading}>
          <header className="brain-reader-header">
            <div>
              <span className={`brain-badge ${source.status}`}>
                {source.kind === 'review'
                  ? 'Recorded human decision'
                  : source.status === 'published'
                    ? source.kind === 'notion'
                      ? 'Approved · Notion'
                      : 'Specification · Git'
                    : source.status === 'draft'
                      ? 'Awaiting approval'
                      : 'Observed code'}
              </span>
              <h2 id="brain-reader-title">{source.title}</h2>
              <p>
                {revisionLabel} <code title={sourceRevision}>{sourceRevision.slice(0, 12)}</code> ·{' '}
                {source.lines} lines
              </p>
            </div>
            <button
              className="brain-button"
              aria-label="Close reader"
              autoFocus
              onClick={closeReader}
            >
              Close ×
            </button>
          </header>
          {sources.length > 1 && (
            <label className="brain-reader-file-picker">
              Source in this analysis
              <select
                value={source.id}
                disabled={loading}
                onChange={(event) => onSelect(event.target.value)}
              >
                {groupedKinds.map((kind) => (
                  <optgroup key={kind} label={sourceGroups[kind]}>
                    {sources
                      .filter((item) => item.kind === kind)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.kind === 'code' ? item.path : item.title}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <div className="brain-reader-tools">
            {markdown && (
              <div className="brain-segmented" aria-label="Reading mode">
                <button aria-pressed={!raw} onClick={() => setRaw(false)}>
                  Reading
                </button>
                <button aria-pressed={raw} onClick={() => setRaw(true)}>
                  Source
                </button>
              </div>
            )}
            {raw && (
              <label>
                <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />{' '}
                Wrap lines
              </label>
            )}
            <button
              className="brain-button"
              disabled={loading || source.content === undefined}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(source.content ?? '');
                  setFeedback('Source copied.');
                } catch {
                  setFeedback('Copy unavailable. Select the text in the reader.');
                }
              }}
            >
              Copy source
            </button>
            {source.url && /^https?:\/\//i.test(source.url) && (
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.kind === 'notion' ? 'Current Notion page' : 'Original source'} ↗
              </a>
            )}
          </div>
          {error && (
            <p className="brain-reader-error" role="alert">
              {error} The previously opened source is still shown. Select a source to try again.
            </p>
          )}
          <div className="brain-reader-context" role="status">
            {loading
              ? 'Loading source…'
              : feedback ||
                (line
                  ? `Cited evidence · line ${line}${raw ? ' highlighted in the source' : ' — open “Source” to find it'}.`
                  : source.kind === 'notion'
                    ? 'Saved snapshot: the current Notion page may have changed.'
                    : source.kind === 'review'
                      ? 'Recorded human decision, preserved with its analysis evidence.'
                      : 'Imported commit version, excluding local changes.')}
          </div>
          <div
            ref={content}
            className="brain-reader-content"
            role="region"
            aria-label="Source content"
            tabIndex={0}
          >
            {raw ? (
              <ol className={`brain-source-lines ${wrap ? '' : 'nowrap'}`}>
                {lines.map((value, i) => (
                  <li data-line={i + 1} className={line === i + 1 ? 'highlight' : ''} key={i}>
                    <code>{value || ' '}</code>
                  </li>
                ))}
              </ol>
            ) : (
              <article className="brain-markdown">{rendered}</article>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
