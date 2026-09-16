import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const brainConfig = createRequire(import.meta.url)('../server/src/brain/config.json');

// Portable client for a developer agent or CI. The server owns project/source mappings.
const [projectId, requestedCommit, baseCommit] = process.argv.slice(2);
try {
  if (!projectId) {
    throw new Error('Usage: node scripts/brain-check.mjs <projectId> [commit] [baseCommit]');
  }
  const url = new URL(process.env.BRAIN_URL ?? 'http://127.0.0.1:4318');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error(
      'BRAIN_URL must be an HTTPS origin, or HTTP on localhost, without credentials in the URL.',
    );
  }
  const commit =
    requestedCommit ??
    (
      await promisify(execFile)('git', ['rev-parse', '--verify', 'HEAD'], { windowsHide: true })
    ).stdout.trim();
  for (const sha of [commit, baseCommit]) {
    if (sha && !/^[a-f0-9]{40,64}$/i.test(sha)) {
      throw new Error('Use full Git commit SHAs.');
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.BRAIN_ACCESS_TOKEN ? { 'x-aad-token': process.env.BRAIN_ACCESS_TOKEN } : {}),
  };
  const request = async (path, body) => {
    const response = await fetch(`${url.origin}/api/brain${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(brainConfig.client.requestTimeoutMs),
    });
    const value = await response.json();
    if (!response.ok) {
      throw new Error(value.message ?? value.error ?? `HTTP ${response.status}`);
    }
    return value;
  };
  const run = await request('/analyses', {
    projectId,
    commit,
    ...(baseCommit ? { baseCommit } : {}),
  });
  console.log(`Analysis ${run.id} · ${projectId} · ${commit}`);
  const deadline =
    run.requestTimeoutMs === 0
      ? Infinity
      : Date.now() +
        3 * (run.requestTimeoutMs ?? brainConfig.analysis.defaultRequestTimeoutMs) +
        brainConfig.client.completionGraceMs;
  while (true) {
    const result = await request(`/analyses/${run.id}`);
    if (result.status !== 'running') {
      if (result.status !== 'succeeded') {
        throw new Error(result.error ?? 'Analysis interrupted.');
      }
      console.log(
        JSON.stringify(
          {
            id: result.id,
            projectId,
            commit: result.commit,
            status: result.status,
            results: result.findings.map((f) => ({ id: f.id, title: f.title, outcome: f.outcome })),
            note: 'Findings require review; human decisions are never automated.',
          },
          null,
          2,
        ),
      );
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Polling timed out. Analysis ${run.id} may still be running on the server.`);
    }
    await delay(brainConfig.client.pollIntervalMs);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
