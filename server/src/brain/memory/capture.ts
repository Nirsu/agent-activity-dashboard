import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brainConfig } from '../config.js';
import type { Project } from '../analysis/types.js';
import { minimizeSourceContent, type Source } from '../sources.js';
import type { SourceRegistration } from './types.js';
import { fail } from '../analysis/validation.js';
import { prepareGithubRevision } from '../analysis/github.js';

export const sourceHash = (value: string) => createHash('sha256').update(value).digest('hex');
const executeFile = promisify(execFile);

export function makeCapture(
  registration: SourceRegistration,
  content: string,
  properties: Record<string, unknown> = {},
  externalRevision?: string,
  raw?: string,
): Source {
  if (Buffer.byteLength(content) > brainConfig.analysis.maxSourceBytes || content.includes('\0')) {
    fail('Source is too large or contains binary data. Narrow its scope.');
  }
  if (registration.kind === 'git') {
    content = minimizeSourceContent(content);
  }
  const revision = sourceHash(
    JSON.stringify({ content, properties, externalRevision, approval: registration.approval }),
  );
  const lines = content.split('\n');
  return {
    id: sourceHash(`${registration.id}:${revision}`),
    kind: registration.kind === 'git' ? 'code' : registration.kind,
    title: registration.title,
    path:
      registration.kind === 'notion'
        ? `${registration.pageId}.md`
        : (registration.git?.path ?? registration.id),
    revision,
    status: registration.approval === 'approved' ? 'published' : 'draft',
    topic: registration.shared ? 'Shared requirements' : registration.projectIds.join(', '),
    summary: lines
      .filter((line) => line.trim())
      .slice(0, brainConfig.memory.summaryLines)
      .join(' ')
      .slice(0, brainConfig.memory.summaryCharacters),
    content,
    lines: lines.length,
    importedAt: new Date().toISOString(),
    url: registration.url,
    origin: { properties, revision: externalRevision, raw },
  };
}

export async function captureGitDocument(project: Project, path: string) {
  const revision = await prepareGithubRevision(project);
  async function git(args: string[]) {
    const result = await executeFile(
      process.env.BRAIN_GIT_BINARY ?? 'git',
      ['-C', project.repoPath, ...args],
      {
        encoding: 'utf8',
        timeout: brainConfig.git.timeoutMs,
        maxBuffer: brainConfig.git.maxBufferBytes,
        windowsHide: true,
      },
    );
    return result.stdout;
  }
  const commit = (await git(['rev-parse', '--verify', `${revision ?? 'HEAD'}^{commit}`])).trim();
  const entry = await git(['ls-tree', commit, '--', path]);
  if (!/^100(?:644|755) blob /.test(entry)) {
    fail('Git specification is missing or is a symbolic link.');
  }
  return { content: await git(['show', `${commit}:${path}`]), commit };
}
