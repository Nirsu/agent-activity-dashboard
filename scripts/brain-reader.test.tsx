import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import BrainSourceViewer from '../ui/src/components/BrainSourceViewer';
import { notionReadingMarkdown } from '../ui/src/components/brain/notionMarkdown';

// Keep the source language to verify faithful rendering of untranslated documents.
const source = {
  id: 'source',
  kind: 'notion' as const,
  title: 'Test document',
  path: 'source.md',
  revision: 'revision',
  status: 'published' as const,
  topic: 'Test',
  summary: '',
  lines: 12,
  importedAt: '2026-09-15T00:00:00Z',
  content:
    '# Décision\n\n<aside>\nUn contexte à conserver.\n</aside>\n\n| Couche | Choix |\n| --- | --- |\n| BFF | NestJS |\n\n<script>alert(1)</script>\n\n![Image](https://example.invalid/tracking.png)\n\n[lien](javascript:alert)\n',
};
test('reader renders tables and callout text without executing HTML or loading remote images', () => {
  const html = renderToStaticMarkup(
    <BrainSourceViewer
      source={source}
      sources={[source]}
      loading={false}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /<table>/);
  assert.match(html, /<td>NestJS<\/td>/);
  assert.match(html, /Un contexte à conserver/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/i);
});

const notionBlocks = [
  '<callout icon="🧱">',
  '\tSocle technique retenu pour la nouvelle application.',
  '</callout>',
  '<table header-row="true">',
  '<tr><td>Couche</td><td>Technologie</td></tr>',
  '<tr><td>Application mobile</td><td>React Native avec Expo</td></tr>',
  '<tr><td>BFF</td><td>**NestJS**</td></tr>',
  '</table>',
  '## Ce qui vaut pour toutes les couches',
  'La marque blanche doit être dans les fondations dès le premier jour.',
].join('\n');

function renderNotion(content: string, line?: number) {
  return renderToStaticMarkup(
    <BrainSourceViewer
      source={{ ...source, content }}
      sources={[]}
      line={line}
      loading={false}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
}

test('Notion callouts and HTML tables preserve the following text without blank separators', () => {
  const html = renderNotion(notionBlocks);
  assert.match(html, /<blockquote>/);
  assert.match(html, /Socle technique retenu/);
  assert.match(html, /<th>Couche<\/th>/);
  assert.match(html, /<td>React Native avec Expo<\/td>/);
  assert.match(html, /<strong>NestJS<\/strong>/);
  assert.match(html, /<h2>Ce qui vaut pour toutes les couches<\/h2>/);
  assert.match(html, /La marque blanche/);
  assert.doesNotMatch(html, /<callout|header-row=/);
  const raw = renderNotion(notionBlocks, 5);
  assert.match(raw, /data-line="5" class="highlight"><code>&lt;tr&gt;&lt;td&gt;Couche/);
  assert.match(raw, /&lt;callout icon=&quot;🧱&quot;&gt;/);
});

test('Notion block examples stay literal in fenced, inline and indented code', () => {
  const content = `\`\`\`html\n${notionBlocks}\n\`\`\`\n\n~~~html\n${notionBlocks}\n~~~\n\n\`<callout>Example</callout>\`\n\n    <table>\n    <tr><td>Literal</td></tr>\n    </table>`;
  const html = renderNotion(content);
  assert.doesNotMatch(html, /<table>|<blockquote>/);
  assert.equal((html.match(/&lt;callout icon=/g) ?? []).length, 2);
  assert.match(html, /<code>&lt;callout&gt;Example&lt;\/callout&gt;<\/code>/);
  assert.match(html, /&lt;td&gt;Literal&lt;\/td&gt;/);
});

test('unsupported or malformed Notion blocks remain readable and unsafe markup stays inert', () => {
  const html = renderNotion(
    [
      '<unknown-block>',
      'Text must remain visible.',
      '</unknown-block>',
      '',
      '<table><tr><td>Unclosed table',
      '',
      '<script>alert(1)</script>',
      '',
      '<callout onclick="alert(1)">',
      '\t[Unsafe](javascript:alert) ![Remote](https://example.invalid/tracking.png)',
      '</callout>',
    ].join('\n'),
  );
  assert.match(html, /Text must remain visible/);
  assert.match(html, /Unclosed table/);
  assert.match(html, /Illustration: Remote/);
  assert.doesNotMatch(html, /<script|<img|onclick=|href="javascript:/i);
});

test('submitted code is labeled as a snapshot rather than a Git commit', () => {
  const snapshot = {
    ...source,
    kind: 'code' as const,
    status: 'observed' as const,
    path: 'hook.js',
    origin: { properties: { captureMode: 'agent-submitted' } },
  };
  const html = renderToStaticMarkup(
    <BrainSourceViewer
      source={snapshot}
      sources={[snapshot]}
      loading={false}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /Submitted snapshot/);
  assert.doesNotMatch(html, /Git commit/);
});
test('a citation opens raw text with the exact line highlighted', () => {
  const html = renderToStaticMarkup(
    <BrainSourceViewer
      source={source}
      sources={[source]}
      line={9}
      loading={false}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /data-line="9" class="highlight"/);
  assert.doesNotMatch(html, /<table>|<script|<img/);
});

test('Notion subpages have a distinct link while raw evidence and code examples stay intact', () => {
  const id = '3dddeff1b9078054960df84e5ed1214f';
  const page = `<page url="{{https://app.notion.com/p/${id}}}">Vercel [React] *practices*</page>`;
  const content = `Parent text.\n${page}\n\n\`\`\`html\n${page}\n\`\`\`\n\n<page url="javascript:alert(1)">Unsafe</page>`;
  const render = (line?: number) =>
    renderToStaticMarkup(
      <BrainSourceViewer
        source={{ ...source, content }}
        sources={[]}
        line={line}
        loading={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
  const html = render();
  assert.equal((html.match(/title="Open subpage in Notion"/g) ?? []).length, 1);
  assert.match(html, new RegExp(`href="https://www.notion.so/${id}"`));
  assert.match(html, /Subpage<\/span>/);
  assert.match(html, /Vercel \[React\] \*practices\*/);
  assert.doesNotMatch(html, /<page|href="javascript:|<em>practices/);
  const raw = render(2);
  assert.match(raw, /data-line="2" class="highlight"><code>&lt;page/);
  assert.doesNotMatch(raw, /title="Open subpage in Notion"/);
  const literals = `~~~html\n${page}\n~~~\n\n\`${page}\`\n\\${page}`;
  assert.equal(notionReadingMarkdown(literals), literals);
  assert.equal(
    notionReadingMarkdown('<page url="https://example.com/no-page">Example</page>'),
    '<page url="https://example.com/no-page">Example</page>',
  );
});

test('a Git specification is labeled as a specification, not an export or observed code', () => {
  const specification = {
    ...source,
    kind: 'code' as const,
    path: 'README.md',
    title: 'README.md',
    origin: { properties: {}, revision: 'a'.repeat(40) },
  };
  const html = renderToStaticMarkup(
    <BrainSourceViewer
      source={specification}
      sources={[specification]}
      loading={false}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /Specification · Git/);
  assert.match(html, /Git commit/);
  assert.match(html, new RegExp(`title="${'a'.repeat(40)}"`));
  assert.doesNotMatch(html, /title="revision"/);
  assert.doesNotMatch(html, /Published · export|Observed code/);
});

test('human decisions remain distinct from specifications and unsafe source links stay inert', () => {
  const decision = { ...source, kind: 'review' as const, url: 'javascript:alert(1)' };
  const html = renderToStaticMarkup(
    <BrainSourceViewer
      source={decision}
      sources={[decision]}
      loading={false}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /Human decisions/);
  assert.match(html, /Recorded human decision/);
  assert.doesNotMatch(html, /href="javascript:|Specification · Git|Notion export/);
});

test('the mobile source picker preserves source groups and cannot switch or copy during loading', () => {
  const code = {
    ...source,
    id: 'code',
    kind: 'code' as const,
    title: 'hook.js',
    path: 'hooks/hook.js',
    status: 'observed' as const,
  };
  const html = renderToStaticMarkup(
    <BrainSourceViewer
      source={code}
      sources={[source, code]}
      loading
      error="The requested source is unavailable."
      onSelect={() => {}}
      onClose={() => {}}
    />,
  );
  assert.match(html, /<select disabled="">/);
  assert.match(html, /<optgroup label="Notion documents">/);
  assert.match(html, /<option value="code" selected="">hooks\/hook.js<\/option>/);
  assert.match(html, /disabled="">Copy source<\/button>/);
  assert.match(html, /role="region" aria-label="Source content" tabindex="0"/);
  assert.match(html, /role="alert">The requested source is unavailable\./);
  assert.match(html, /The previously opened source is still shown/);
});
