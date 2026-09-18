#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../server/dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!target) {
  console.error('Set TEST_DATABASE_URL or start the local PostgreSQL service first.');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ['scripts/test-server.mjs'], {
    cwd: root,
    env: { ...process.env, TEST_DATABASE_URL: target, DATABASE_URL: '' },
    stdio: 'inherit',
    shell: false,
  });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
