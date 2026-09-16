import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import BrainSourceViewer from '../ui/src/components/BrainSourceViewer';

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

test('a Git specification is labeled as a specification, not an export or observed code', () => {
  const specification = { ...source, kind: 'code' as const, path: 'README.md', title: 'README.md' };
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
  assert.doesNotMatch(html, /Published · export|Observed code/);
});
