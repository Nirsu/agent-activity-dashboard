import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
    const child = fork(new URL('./start-brain.mjs', import.meta.url), [], {
      cwd: directory,
      silent: true,
      env: {
        ...process.env,
        PORT: String(apiPort),
        BRAIN_UI_PORT: String(uiPort),
        DATA_DIR: directory,
        DB_PATH: join(directory, 'history.db'),
        BRAIN_DB_PATH: join(directory, 'brain.db'),
        BRAIN_PROJECTS_PATH: join(directory, 'no-projects.json'),
        BRAIN_ADMIN_TOKEN: '',
        BRAIN_MODEL: '',
        OPENAI_API_KEY: '',
        CREDENTIAL_ENCRYPTION_KEY: '',
        COGNEE_API_URL: '',
        COGNEE_API_TOKEN: '',
        COGNEE_PASSWORD: '',
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
          const response = await fetch(`${base}/api/brain/memory`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok && Array.isArray((await response.json()).sources)) {
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
      assert.equal((await fetch(`${base}/api/brain/import`)).status, 404);
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

test('portable developer client reports scoped findings, no conclusion and technical failures', async () => {
  const requests = [];
  const citation = {
    sourceId: 'captured-specification',
    line: 3,
    quote: 'Use sanitized summaries.',
  };
  let result = {
    id: 'analysis-1',
    status: 'succeeded',
    commit: 'a'.repeat(40),
    requirements: [{ id: 'R1' }],
    findings: [
      {
        id: 'finding-1',
        title: 'Check summary',
        outcome: 'difference',
        requirementId: 'R1',
        explanation: 'The captured payload contains raw tool arguments.',
        decision: citation,
        evidence: [citation],
        question: 'Does the summary contain arguments?',
        limitation: 'One feature only',
      },
    ],
    retrieval: {
      datasets: ['dataset-1'],
      sourceIds: [citation.sourceId],
      memoryVersion: 'generation-1',
    },
  };
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    requests.push({
      path: request.url,
      token: request.headers['x-aad-token'],
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.method === 'POST' ? { id: 'analysis-1', requestTimeoutMs: 0 } : result,
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const runClient = () =>
      promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('./brain-check.mjs', import.meta.url)),
          'dashboard',
          'a'.repeat(40),
          'b'.repeat(40),
          'Check hook summaries',
        ],
        {
          cwd: tmpdir(),
          windowsHide: true,
          timeout: 10_000,
          env: {
            ...process.env,
            BRAIN_URL: `http://127.0.0.1:${server.address().port}`,
            BRAIN_ACCESS_TOKEN: 'test-agent-token',
          },
        },
      );
    const { stdout } = await runClient();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], {
      path: '/api/brain/analyses',
      token: 'test-agent-token',
      body: {
        projectId: 'dashboard',
        commit: 'a'.repeat(40),
        baseCommit: 'b'.repeat(40),
        feature: 'Check hook summaries',
      },
    });
    const summary = JSON.parse(stdout.slice(stdout.indexOf('{')));
    assert.equal(summary.coverage, 'scoped_requirements_checked');
    assert.equal(summary.requirementCount, 1);
    assert.equal(summary.analysisMethod, 'static_code_review');
    assert.deepEqual(summary.requirements, result.requirements);
    assert.equal(summary.results[0].requirementId, 'R1');
    assert.equal(summary.results[0].explanation, result.findings[0].explanation);
    assert.equal(summary.humanReviewRequired, true);
    assert.deepEqual(summary.results[0].decision, citation);
    assert.equal(summary.retrieval.memoryVersion, 'generation-1');
    assert.ok(!stdout.includes('test-agent-token'));

    const explanation =
      'No applicable requirements extracted: The specification covers another feature. No conclusion about the code.';
    result = { ...result, requirements: [], findings: [], events: [{ message: explanation }] };
    const emptyOutput = (await runClient()).stdout;
    const emptySummary = JSON.parse(emptyOutput.slice(emptyOutput.indexOf('{')));
    assert.equal(emptySummary.status, 'succeeded', 'Technical completion still exits successfully');
    assert.equal(emptySummary.coverage, 'no_conclusion');
    assert.equal(emptySummary.requirementCount, 0);
    assert.equal(emptySummary.explanation, explanation);
    assert.equal(emptySummary.humanReviewRequired, true);
    assert.deepEqual(emptySummary.results, []);

    result = { ...result, status: 'failed', error: 'Provider unavailable.' };
    await assert.rejects(runClient(), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Provider unavailable/);
      return true;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
