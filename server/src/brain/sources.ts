import { brainConfig } from './config.js';
import { createHash } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export type Source = {
  id: string;
  kind: 'notion' | 'code' | 'review';
  title: string;
  path: string;
  revision: string;
  status: 'published' | 'draft' | 'observed';
  topic: string;
  summary: string;
  content: string;
  lines: number;
  importedAt: string;
  url?: string;
  origin?: { properties: Record<string, unknown>; revision?: string; raw?: string };
};

export function minimizeSourceContent(raw: string): string {
  // Line-preserving minimization for the local pilot. This is not a general secret scanner.
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/^(Owner|Porteur):.*$/gm, '$1: [not indexed]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g, '[secret redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, (value) =>
      value
        .split('\n')
        .map(() => '[secret redacted]')
        .join('\n'),
    );
}

export function makeSource(
  kind: Source['kind'],
  path: string,
  raw: string,
  commit?: string,
): Source {
  const content = minimizeSourceContent(raw);
  const title = kind === 'notion' ? (content.match(/^# (.+)$/m)?.[1] ?? path) : path;
  const status: Source['status'] = kind === 'code' ? 'observed' : 'draft';
  const revision = commit ?? hash(content);
  const extracts = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(#|<|!\[|Owner:|Porteur:|Projet:|Related)/.test(line));
  const notionId = path.match(/([a-f0-9]{32})\.md$/)?.[1];
  return {
    id: hash(`${kind}:${path}:${revision}`),
    kind,
    title,
    path,
    revision,
    status,
    topic: '',
    summary:
      kind === 'code' && path.endsWith('package.json')
        ? manifestSummary(content)
        : extracts
            .slice(0, brainConfig.memory.summaryLines)
            .join(' ')
            .slice(0, brainConfig.memory.summaryCharacters),
    content,
    lines: content.split('\n').length,
    importedAt: new Date().toISOString(),
    url: notionId ? `https://www.notion.so/${notionId}` : undefined,
  };
}

function manifestSummary(content: string) {
  try {
    const manifest = JSON.parse(content);
    const dependencies = Object.keys(manifest.dependencies ?? {}).join(', ') || 'none';
    return `Manifest ${manifest.name ?? ''}. Declared dependencies: ${dependencies}.`;
  } catch {
    return 'Unreadable manifest: verification is not possible.';
  }
}
