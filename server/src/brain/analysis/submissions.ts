import { createHash } from 'node:crypto';
import { brainConfig } from '../config.js';
import { makeSource, minimizeSourceContent } from '../sources.js';
import { isAllowedCodePath, requireRepoPath } from './projects.js';
import type { AnalysisRun, Project, SubmittedFile } from './types.js';
import { fail, requireList, requireObject } from './validation.js';

export function validateSubmittedFiles(input: unknown, project: Project): SubmittedFile[] {
  let bytes = 0;
  const seen = new Set<string>();
  const files = requireList(input, brainConfig.analysis.maxSources).map((value) => {
    const entry = requireObject(value);
    const path = requireRepoPath(entry.path);
    if (!isAllowedCodePath(project, path) || seen.has(path)) {
      fail('Submitted paths must be unique allowed code files, never specifications or secrets.');
    }
    seen.add(path);
    if (entry.content !== null && typeof entry.content !== 'string') {
      fail('Supply full file content, or null for a deleted file.');
    }
    if (typeof entry.content === 'string') {
      bytes += Buffer.byteLength(entry.content);
      if (entry.content.includes('\0') || bytes > brainConfig.codeRetrieval.maxSubmissionBytes) {
        fail('Submitted code is too large or binary. Narrow the change.');
      }
    }
    return { path, content: entry.content === null ? null : minimizeSourceContent(entry.content) };
  });
  if (!files.length) {
    fail('Submit at least one changed code file.');
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function submissionInfo(baselineCommit: string, files: SubmittedFile[]) {
  const id = createHash('sha256').update(JSON.stringify({ baselineCommit, files })).digest('hex');
  return { id, baselineCommit, paths: files.map((file) => file.path) };
}

export function applySubmittedFiles(run: AnalysisRun, project: Project, files: SubmittedFile[]) {
  const submission = submissionInfo(run.commit!, files);
  const { id } = submission;
  const paths = files.map((file) => file.path);
  // An overlay is evidence only. Never write it to the registered checkout or memory specifications.
  run.sources = run.sources.filter(
    (source) => source.status === 'published' || !paths.includes(source.path),
  );
  for (const file of files) {
    if (file.content === null) {
      continue;
    }
    const source = makeSource('code', file.path, file.content, id);
    source.topic = project.name;
    source.origin = {
      properties: { captureMode: 'agent-submitted', baselineCommit: run.commit, snapshotId: id },
    };
    run.sources.push(source);
  }
  if (
    run.sources.length > brainConfig.analysis.maxSources ||
    run.sources
      .filter((source) => source.status === 'observed')
      .reduce((total, source) => total + Buffer.byteLength(source.content), 0) >
      brainConfig.codeRetrieval.maxSubmissionBytes
  ) {
    fail('The submitted snapshot exceeds the capture budget. Narrow the submitted change.');
  }
  run.submission = submission;
  run.changedFiles = paths;
}
