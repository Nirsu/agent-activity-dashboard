import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test(
  'portable launcher serves Brain from another cwd and releases both ports on stop',
  { timeout: 25_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'brain launcher '));
    const apiPort = await freePort();
    const uiPort = await freePort();
    const child = fork(new URL('./start-brain-demo.mjs', import.meta.url), [], {
      cwd: directory,
      silent: true,
      env: {
        ...process.env,
        PORT: String(apiPort),
        BRAIN_UI_PORT: String(uiPort),
        DATA_DIR: directory,
        DB_PATH: join(directory, 'history.db'),
        BRAIN_DB_PATH: join(directory, 'brain.db'),
        VIEWER_TOKEN: '',
        INGEST_TOKEN: '',
        COST_LEDGER: '0',
      },
    });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    try {
      const base = `http://127.0.0.1:${uiPort}`;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) {
          assert.fail(output);
        }
        try {
          const response = await fetch(`${base}/api/brain`, { signal: AbortSignal.timeout(500) });
          if (response.ok && (await response.json()).mode === 'demo') {
            ready = true;
            break;
          }
        } catch {
          /* The servers are still starting. */
        }
        await delay(100);
      }
      assert.ok(ready, output);
      assert.match(await (await fetch(base)).text(), /Agent Activity Dashboard/);
      assert.equal((await fetch(`http://127.0.0.1:${apiPort}/healthz`)).status, 200);
      child.send('stop');
      assert.equal((await exited)[0], 0, output);
      for (const port of [apiPort, uiPort]) {
        await assert.rejects(
          fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }),
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
