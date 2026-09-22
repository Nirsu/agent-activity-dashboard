import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const placeholder = '__BRAIN_MCP_MAX_REQUEST_BYTES__';

export function renderNginxConfig(template, maxRequestBytes) {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new Error('mcp.maxRequestBytes must be a positive safe integer.');
  }
  if (template.split(placeholder).length !== 2) {
    throw new Error('The Nginx template must contain exactly one MCP request limit placeholder.');
  }
  return template.replace(placeholder, String(maxRequestBytes));
}

async function run() {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) {
    throw new Error('Usage: node docker/render-nginx.mjs <output-path>');
  }
  const { mcp } = createRequire(import.meta.url)('../server/src/brain/config.json');
  const template = await readFile(new URL('./nginx.conf', import.meta.url), 'utf8');
  await writeFile(resolve(output), renderNginxConfig(template, mcp.maxRequestBytes));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
