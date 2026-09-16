import { brainConfig } from './config.js';
import { createHash } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export const normalizeText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export type Source = {
  id: string;
  kind: 'notion' | 'code';
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
};

function sourceTopic(kind: Source['kind'], title: string, path: string) {
  if (kind === 'notion') {
    return normalizeText(title).includes('socle') ? 'Architecture & foundations' : 'Harmony Brain';
  }
  if (path.startsWith('ui/')) {
    return 'Web extranet';
  }
  return /db\.ts|compose/.test(path) ? 'Storage & runtime' : 'Backend & tooling';
}

export function makeSource(
  kind: Source['kind'],
  path: string,
  raw: string,
  commit?: string,
): Source {
  // Line-preserving minimization for the local pilot. This is not a general secret scanner.
  const content = raw
    .replace(/\r\n/g, '\n')
    .replace(/^(Owner|Porteur):.*$/gm, '$1: [not indexed]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g, '[secret redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, (value) =>
      value
        .split('\n')
        .map(() => '[secret redacted]')
        .join('\n'),
    );
  const title = kind === 'notion' ? (content.match(/^# (.+)$/m)?.[1] ?? path) : path;
  const isPublished = /^Statut:\s*Publié\s*$/m.test(content);
  const status: Source['status'] =
    kind === 'code' ? 'observed' : isPublished ? 'published' : 'draft';
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
    topic: sourceTopic(kind, title, path),
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
