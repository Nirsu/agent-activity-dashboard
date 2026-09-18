import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, DATABASE_URL: '', CODEX_METADATA_DB: '' };

async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Server verification failed (${code}).`)));
  });
}

await run(['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json']);
const testFiles = [];
for (const directory of ['server/dist', 'server/dist/otlp', 'server/dist/store']) {
  for (const file of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (file.endsWith('.test.js')) {
      testFiles.push(`${directory}/${file}`);
    }
  }
}
await run(['--test', ...testFiles]);
