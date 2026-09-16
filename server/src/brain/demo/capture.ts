import { brainConfig } from '../config.js';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { makeSource, type Source } from '../sources.js';
import type { Options } from './types.js';

const exec = promisify(execFile);
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};

export async function captureDemoSources(options: Required<Options>) {
  const git = async (args: string[]) => {
    const { stdout } = await exec(options.gitBinary, ['-C', options.repoPath, ...args], {
      encoding: 'utf8',
      timeout: brainConfig.git.timeoutMs,
      maxBuffer: brainConfig.git.demoMaxBufferBytes,
      windowsHide: true,
    });
    return stdout;
  };
  const commit = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    fail('Invalid Git revision.');
  }
  const sources: Source[] = [];
  const excluded: string[] = [];
  const walk = async (directory: string, depth = 0): Promise<void> => {
    if (depth > brainConfig.demo.maxDirectoryDepth) {
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (sources.length >= brainConfig.demo.maxDocuments) {
          fail(`The pilot supports up to ${brainConfig.demo.maxDocuments} documents.`);
        }
        const content = await readFile(path, 'utf8');
        if (Buffer.byteLength(content) > brainConfig.demo.maxDocumentBytes) {
          fail(`A document exceeds the ${brainConfig.demo.maxDocumentBytes / 1000} KB limit.`);
        }
        sources.push(
          makeSource('notion', relative(options.notionPath, path).replace(/\\/g, '/'), content),
        );
      }
    }
  };
  await walk(options.notionPath);
  if (!sources.length) {
    fail('No Markdown exports found in the configured Notion folder.');
  }
  const files = (await git(['ls-tree', '-r', '--name-only', commit])).trim().split('\n');
  const selected = [
    'README.md',
    'package.json',
    'server/package.json',
    'ui/package.json',
    'server/src/index.ts',
    'server/src/db.ts',
    'server/src/config.ts',
    'compose.yaml',
    'Dockerfile',
  ];
  for (const path of selected) {
    if (!files.includes(path)) {
      excluded.push(`${path}: missing from the commit`);
      continue;
    }
    const content = await git(['show', `${commit}:${path}`]);
    sources.push(makeSource('code', path, content, commit));
  }

  return { commit, sources, excluded };
}
