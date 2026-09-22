import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderNginxConfig } from './render-nginx.mjs';

const executeFile = promisify(execFile);
const { mcp } = createRequire(import.meta.url)('../server/src/brain/config.json');

test('the MCP proxy uses the shared request limit and other endpoints retain their body limit', async () => {
  const template = await readFile(new URL('./nginx.conf', import.meta.url), 'utf8');
  const rendered = renderNginxConfig(template, mcp.maxRequestBytes);
  assert.doesNotMatch(rendered, /__BRAIN_MCP_MAX_REQUEST_BYTES__/);
  const overrides = [...rendered.matchAll(/client_max_body_size (\w+);/g)].map((match) => match[1]);
  assert.deepEqual(overrides, ['16m', String(mcp.maxRequestBytes)]);
  const mcpLocation = rendered.match(/location = \/api\/brain\/mcp \{([^}]+)\}/)?.[1];
  assert.ok(mcpLocation);
  assert.match(mcpLocation, new RegExp(`client_max_body_size ${mcp.maxRequestBytes};`));
  assert.match(mcpLocation, /proxy_pass http:\/\/server:4318;/);
  assert.match(mcpLocation, /proxy_set_header Host \$http_host;/);
});

test('the Nginx renderer rejects missing, repeated or invalid request-limit settings', () => {
  const template = 'client_max_body_size __BRAIN_MCP_MAX_REQUEST_BYTES__;';
  for (const invalid of [
    undefined,
    null,
    '64000000',
    0,
    -1,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => renderNginxConfig(template, invalid), /positive safe integer/);
  }
  assert.throws(() => renderNginxConfig('client_max_body_size 16m;', 64_000_000), /exactly one/);
  assert.throws(() => renderNginxConfig(`${template}\n${template}`, 64_000_000), /exactly one/);
});

test('the deployment renderer writes the complete proxy configuration using the shared JSON', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'brain-nginx-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'generated.conf');
  const result = await executeFile(process.execPath, [
    fileURLToPath(new URL('./render-nginx.mjs', import.meta.url)),
    target,
  ]);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const template = await readFile(new URL('./nginx.conf', import.meta.url), 'utf8');
  assert.equal(await readFile(target, 'utf8'), renderNginxConfig(template, mcp.maxRequestBytes));
});
