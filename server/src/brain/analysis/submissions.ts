import { createHash } from 'node:crypto';
import { brainConfig } from '../config.js';
import { makeSource, minimizeSourceContent } from '../sources.js';
import { isAllowedCodePath, requireRepoPath } from './projects.js';
import type { AnalysisRun, Project, SubmittedFile } from './types.js';
import { fail, requireObject } from './validation.js';

export function validateSubmittedFiles(input: unknown, project: Project): SubmittedFile[] {
  if (!Array.isArray(input)) {
    fail('Submitted files must be an array of full file contents or deletions.');
  }
  if (input.length > brainConfig.submission.maxFiles) {
    fail(
      `Submitted snapshot contains ${input.length} files; the configured limit is ${brainConfig.submission.maxFiles} files (submission.maxFiles).`,
    );
  }
  let bytes = 0;
  const seen = new Set<string>();
  const files = input.map((value) => {
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
      const fileBytes = Buffer.byteLength(entry.content, 'utf8');
      if (entry.content.includes('\0')) {
        fail(`Submitted file ${path} contains binary content.`);
      }
      if (fileBytes > brainConfig.submission.maxFileBytes) {
        fail(
          `Submitted file ${path} contains ${fileBytes} UTF-8 bytes; the configured limit is ${brainConfig.submission.maxFileBytes} bytes per file (submission.maxFileBytes).`,
        );
      }
      bytes += fileBytes;
    }
    return { path, content: entry.content === null ? null : minimizeSourceContent(entry.content) };
  });
  if (!files.length) {
    fail('Submit at least one changed code file.');
  }
  if (bytes > brainConfig.submission.maxBytes) {
    fail(
      `Submitted snapshot contains ${bytes} UTF-8 bytes; the configured limit is ${brainConfig.submission.maxBytes} bytes (submission.maxBytes).`,
    );
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
  // Preserve the complete overlay for replay and provenance. Only explicitly read excerpts
  // become model evidence; snapshot size is independent of the evidence budget.
  // Never write the overlay to the registered checkout or memory specifications.
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
  run.submission = submission;
  run.changedFiles = paths;
}
