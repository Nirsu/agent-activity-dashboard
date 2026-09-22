import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const executeFile = promisify(execFile);
const brainConfig = createRequire(import.meta.url)('../server/src/brain/config.json');
const { normalizeRepositoryRemote } = createRequire(import.meta.url)('../fleet/repository-url.cjs');
const { isSensitivePath } = createRequire(import.meta.url)('../fleet/brain-paths.cjs');
const knownSecret =
  /\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\bhb_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|-----BEGIN [^-]*PRIVATE KEY-----/;

function validPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= brainConfig.projects.maxGitPathCharacters &&
    !path.startsWith('/') &&
    !/[\\:\u0000-\u001f]/.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..') &&
    !isSensitivePath(path)
  );
}

function validateProject(project) {
  if (
    !project ||
    typeof project.id !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(project.id) ||
    project.id.length > brainConfig.projects.maxIdCharacters ||
    !Array.isArray(project.codePaths) ||
    !project.codePaths.length ||
    !project.codePaths.every((path) => path === '**' || validPath(path)) ||
    !Array.isArray(project.specificationPaths) ||
    !project.specificationPaths.every(validPath)
  ) {
    throw new Error(
      'Use the selected project object from a fresh brain_list_projects result, including id, codePaths and specificationPaths.',
    );
  }
  return project;
}

function exclusionReason(project, path) {
  if (!validPath(path)) return 'sensitive, generated or unsupported path';
  if (project.specificationPaths.includes(path)) return 'reference specification';
  if (
    !project.codePaths.some(
      (prefix) =>
        prefix === '**' || (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix),
    )
  ) {
    return 'outside the registered code scope';
  }
  return undefined;
}

function gitAt(root) {
  return async (...args) => {
    try {
      const { stdout } = await executeFile(
        process.env.BRAIN_GIT_BINARY ?? 'git',
        ['-C', root, '-c', 'core.fsmonitor=false', ...args],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: brainConfig.git.timeoutMs,
          maxBuffer: brainConfig.git.maxBufferBytes,
        },
      );
      return stdout;
    } catch (error) {
      // Git errors can contain remote credentials or repository data: never echo them.
      const failure = new Error(
        `Git ${args[0]} failed. Check the repository and baseline locally.`,
      );
      failure.code = error.code;
      throw failure;
    }
  };
}

async function changedPaths(git, baseline) {
  const tracked = await git(
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--name-only',
    '-z',
    baseline,
    '--',
  );
  const untracked = await git('ls-files', '--others', '--exclude-standard', '-z');
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')])].filter(Boolean).sort();
}

async function readWorkingFile(root, path) {
  let location = root;
  let info;
  for (const part of path.split('/')) {
    location = join(location, part);
    try {
      info = await lstat(location, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Cannot inspect changed file ${JSON.stringify(path)}.`);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Symbolic links cannot be submitted: ${JSON.stringify(path)}.`);
    }
    if (location !== join(root, ...path.split('/')) && !info.isDirectory()) {
      throw new Error(`A changed file's parent is not a directory: ${JSON.stringify(path)}.`);
    }
  }
  if (!info.isFile()) {
    throw new Error(`Only regular files can be submitted: ${JSON.stringify(path)}.`);
  }
  if (info.size > BigInt(brainConfig.submission.maxFileBytes)) {
    throw new Error(
      `Changed file ${JSON.stringify(path)} contains ${info.size} UTF-8 bytes; the per-file limit is ${brainConfig.submission.maxFileBytes} bytes. Increase the configured submission capacity to review the complete change.`,
    );
  }
  const buffer = await readFile(location);
  const after = await lstat(location, { bigint: true });
  if (
    !after.isFile() ||
    info.ino !== after.ino ||
    info.size !== after.size ||
    info.mtimeNs !== after.mtimeNs
  ) {
    throw new Error('The working copy changed during capture. Stop edits and retry.');
  }
  if (buffer.includes(0)) {
    throw new Error(`Binary files cannot be submitted: ${JSON.stringify(path)}.`);
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error(`Changed file is not UTF-8 text: ${JSON.stringify(path)}.`);
  }
  if (knownSecret.test(content)) {
    throw new Error(
      `A known credential pattern was found in ${JSON.stringify(path)}. Remove it before submission.`,
    );
  }
  return content;
}

/** Capture final file contents against a published baseline, including local commits. */
export async function captureChange({
  repo = process.cwd(),
  project,
  baselineCommit,
  feature,
  allowOutOfScope = false,
  warn = (message) => process.stderr.write(`${message}\n`),
}) {
  validateProject(project);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baselineCommit ?? '')) {
    throw new Error(
      'Supply an explicit full baseline SHA published to GitHub or available in Brain.',
    );
  }
  if (
    typeof feature !== 'string' ||
    !feature.trim() ||
    feature.length > brainConfig.analysis.maxTextCharacters ||
    knownSecret.test(feature)
  ) {
    throw new Error('Supply a nonempty feature within the text limit, without credentials.');
  }
  const requestedRoot = await realpath(resolve(repo));
  const root = await realpath((await gitAt(requestedRoot)('rev-parse', '--show-toplevel')).trim());
  const git = gitAt(root);
  if (project.repositoryRemote) {
    const origin = normalizeRepositoryRemote((await git('remote', 'get-url', 'origin')).trim());
    const expected = normalizeRepositoryRemote(project.repositoryRemote);
    if (!origin || !expected || origin !== expected) {
      throw new Error('The local origin does not match the selected Brain project.');
    }
  }
  const baseline = (await git('rev-parse', '--verify', `${baselineCommit}^{commit}`)).trim();
  try {
    await git('merge-base', '--is-ancestor', baseline, 'HEAD');
  } catch {
    throw new Error(
      'The baseline must be an ancestor of local HEAD. Choose a published base for this branch.',
    );
  }
  if ((await git('ls-files', '--unmerged', '-z')).length) {
    throw new Error('Resolve Git merge conflicts before capturing a submission.');
  }
  const indexEntries = (await git('ls-files', '-v', '-z')).split('\0').filter(Boolean);
  if (indexEntries.some((entry) => /^[a-zS]/.test(entry))) {
    throw new Error(
      'Sparse, skip-worktree or assume-unchanged files prevent complete capture. Use a complete working copy.',
    );
  }
  const paths = await changedPaths(git, baseline);
  const excluded = paths
    .map((path) => ({ path, reason: exclusionReason(project, path) }))
    .filter((entry) => entry.reason);
  for (const entry of excluded) {
    warn(`Excluded ${JSON.stringify(entry.path)}: ${entry.reason}.`);
  }
  if (excluded.length && !allowOutOfScope) {
    throw new Error(
      'Changed files were excluded. Review the diagnostics; use --allow-out-of-scope only to acknowledge those exclusions.',
    );
  }
  const selected = paths.filter((path) => !exclusionReason(project, path));
  if (!selected.length) throw new Error('No changed code files remain in the registered scope.');
  if (selected.length > brainConfig.submission.maxFiles) {
    throw new Error(
      `The complete change contains ${selected.length} files; the submission limit is ${brainConfig.submission.maxFiles} files. Increase the configured submission capacity to review the complete change.`,
    );
  }
  const files = [];
  let bytes = 0;
  for (const path of selected) {
    const content = await readWorkingFile(root, path);
    bytes += Buffer.byteLength(content ?? '');
    if (bytes > brainConfig.submission.maxBytes) {
      throw new Error(
        `Changed code contains at least ${bytes} UTF-8 bytes; the submission limit is ${brainConfig.submission.maxBytes} bytes. Increase the configured submission capacity to review the complete change.`,
      );
    }
    files.push({ path, content });
  }
  if (JSON.stringify(paths) !== JSON.stringify(await changedPaths(git, baseline))) {
    throw new Error('The working copy changed during capture. Stop edits and retry.');
  }
  for (const file of files) {
    if (file.content !== (await readWorkingFile(root, file.path))) {
      throw new Error('The working copy changed during capture. Stop edits and retry.');
    }
  }
  const payload = {
    projectId: project.id,
    baselineCommit: baseline,
    feature: feature.trim(),
    files,
  };
  const envelope = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'brain_submit_change', arguments: payload },
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(envelope));
  if (requestBytes > brainConfig.mcp.maxRequestBytes) {
    throw new Error(
      `The JSON MCP request contains ${requestBytes} bytes; the request limit is ${brainConfig.mcp.maxRequestBytes} bytes. Increase the configured MCP and deployment proxy capacity to review the complete change.`,
    );
  }
  return payload;
}

export async function runCli(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      'project-config': { type: 'string' },
      baseline: { type: 'string' },
      feature: { type: 'string' },
      repo: { type: 'string' },
      output: { type: 'string' },
      'allow-out-of-scope': { type: 'boolean' },
    },
  });
  if (!values['project-config'] || !values.baseline || !values.feature) {
    throw new Error(
      'Usage: brain-submit.mjs --project-config <project.json> --baseline <full-sha> --feature <description> [--repo <directory>] [--output <outside-repo.json>] [--allow-out-of-scope]',
    );
  }
  const project = JSON.parse(await readFile(resolve(values['project-config']), 'utf8'));
  const payload = await captureChange({
    repo: values.repo,
    project,
    baselineCommit: values.baseline,
    feature: values.feature,
    allowOutOfScope: values['allow-out-of-scope'],
  });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (values.output) {
    const root = await realpath(
      (await gitAt(resolve(values.repo ?? process.cwd()))('rev-parse', '--show-toplevel')).trim(),
    );
    const target = resolve(
      await realpath(dirname(resolve(values.output))),
      values.output.split(/[\\/]/).at(-1),
    );
    const within = relative(root, target);
    if (!within || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within))) {
      throw new Error(
        'Write the payload outside the repository so it cannot become submitted source.',
      );
    }
    await writeFile(target, serialized, { flag: 'wx', mode: 0o600 });
    process.stderr.write(
      'Brain submission payload written. Send its JSON through brain_submit_change.\n',
    );
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
