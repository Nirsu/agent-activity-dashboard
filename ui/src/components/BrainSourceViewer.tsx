import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BrainSource } from './brain/types';

export default function BrainSourceViewer({
  source,
  sources,
  line,
  loading,
  onSelect,
  onClose,
}: {
  source: BrainSource;
  sources: BrainSource[];
  line?: number;
  loading: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const markdown = source.kind === 'notion' || source.path.endsWith('.md');
  const [raw, setRaw] = useState(Boolean(line) || !markdown);
  const [feedback, setFeedback] = useState('');
  const [wrap, setWrap] = useState(true);
  const lines = (source.content ?? '').split('\n');
  useEffect(() => {
    dialog.current?.showModal();
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
  }, [source.id, line, raw]);
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
  return (
    <dialog
      ref={dialog}
      className="brain-reader"
      aria-labelledby="brain-reader-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="brain-reader-shell">
        <aside className="brain-reader-files" aria-label="Memory files">
          <strong>Memory sources</strong>
          {(['notion', 'code'] as const).map((kind) => (
            <section key={kind}>
              <h3>{kind === 'notion' ? 'Notion documents' : 'Repository files'}</h3>
              {sources
                .filter((s) => s.kind === kind)
                .map((s) => (
                  <button
                    key={s.id}
                    className={s.id === source.id ? 'selected' : ''}
                    aria-current={s.id === source.id ? 'true' : undefined}
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
                {source.status === 'published'
                  ? source.kind === 'notion'
                    ? 'Published · export'
                    : 'Specification · Git'
                  : source.status === 'draft'
                    ? 'Proposal / scope'
                    : 'Observed code'}
              </span>
              <h2 id="brain-reader-title">{source.title}</h2>
              <p>
                {source.kind === 'notion' ? 'Notion export' : 'Git commit'}{' '}
                <code title={source.revision}>{source.revision.slice(0, 12)}</code> · {source.lines}{' '}
                lines
              </p>
            </div>
            <button className="brain-button" aria-label="Close reader" autoFocus onClick={onClose}>
              Close ×
            </button>
          </header>
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
            {source.url && (
              <a href={source.url} target="_blank" rel="noreferrer">
                Current Notion page ↗
              </a>
            )}
          </div>
          <div className="brain-reader-context" role="status">
            {loading
              ? 'Loading source…'
              : feedback ||
                (line
                  ? `Cited evidence · line ${line}${raw ? ' highlighted in the source' : ' — open “Source” to find it'}.`
                  : source.kind === 'notion'
                    ? 'Saved snapshot: the current Notion page may have changed.'
                    : 'Imported commit version, excluding local changes.')}
          </div>
          <div ref={content} className="brain-reader-content">
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
