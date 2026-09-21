import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const brainConfig = createRequire(import.meta.url)('../server/src/brain/config.json');

// Portable client for a developer agent or CI. The server owns project/source mappings.
const [projectId, requestedCommit, baseCommit, feature] = process.argv.slice(2);
try {
  if (!projectId) {
    throw new Error(
      'Usage: node scripts/brain-check.mjs <projectId> [commit] [baseCommit] [feature]',
    );
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
      await promisify(execFile)('git', ['rev-parse', '--verify', 'HEAD'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: brainConfig.git.timeoutMs,
        maxBuffer: brainConfig.git.maxBufferBytes,
      })
    ).stdout.trim();
  for (const sha of [commit, baseCommit]) {
    if (sha && !/^[a-f0-9]{40,64}$/i.test(sha)) {
      throw new Error('Use full Git commit SHAs.');
    }
  }
  if (
    feature !== undefined &&
    (!feature.trim() || feature.length > brainConfig.analysis.maxTextCharacters)
  ) {
    throw new Error('Provide a nonempty feature description within the configured text limit.');
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
    ...(feature ? { feature } : {}),
  });
  console.log(`Analysis ${run.id} · ${projectId} · ${commit}`);
  const deadline =
    run.requestTimeoutMs === 0 || brainConfig.cognee.indexTimeoutMs === 0
      ? Infinity
      : Date.now() +
        (3 + brainConfig.codeRetrieval.maxRounds) *
          (run.requestTimeoutMs ?? brainConfig.analysis.defaultRequestTimeoutMs) +
        brainConfig.cognee.indexTimeoutMs +
        brainConfig.client.completionGraceMs;
  while (true) {
    const result = await request(`/analyses/${run.id}`);
    if (result.status !== 'running') {
      if (result.status !== 'succeeded') {
        throw new Error(result.error ?? 'Analysis interrupted.');
      }
      const requirementCount = result.requirements.length;
      const explanation = requirementCount
        ? 'Only the extracted requirements and captured code were checked; this is not project approval.'
        : (result.events?.find((event) =>
            event.message.startsWith('No applicable requirements extracted:'),
          )?.message ?? 'No applicable requirements were extracted. No conclusion about the code.');
      console.log(
        JSON.stringify(
          {
            id: result.id,
            projectId,
            commit: result.commit,
            status: result.status,
            analysisMethod: 'static_code_review',
            coverage: requirementCount ? 'scoped_requirements_checked' : 'no_conclusion',
            requirementCount,
            requirements: result.requirements,
            explanation,
            results: result.findings.map((finding) => ({
              id: finding.id,
              title: finding.title,
              outcome: finding.outcome,
              requirementId: finding.requirementId,
              explanation: finding.explanation,
              question: finding.question,
              limitation: finding.limitation,
              decision: finding.decision,
              evidence: finding.evidence,
            })),
            retrieval: result.retrieval,
            humanReviewRequired:
              requirementCount === 0 ||
              result.findings.some((finding) => finding.outcome !== 'aligned'),
            note: 'Technical completion never authorizes a merge or deployment.',
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
