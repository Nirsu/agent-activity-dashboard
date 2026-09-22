import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const brainConfig = createRequire(import.meta.url)('../server/src/brain/config.json');

// Portable client for a developer agent or CI. The server owns project/source mappings.
const [projectId, requestedCommit, baseCommit, feature] = process.argv.slice(2);
let client;
try {
  if (!projectId) {
    throw new Error(
      'Usage: node scripts/brain-check.mjs <projectId> [commit] [baseCommit] [feature]',
    );
  }
  const token = process.env.HARMONIE_TOKEN;
  if (!token?.trim()) {
    throw new Error('Set HARMONIE_TOKEN to a workstation token issued in Accounts.');
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
  client = new Client({ name: 'harmonie-brain-check', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/brain/mcp', url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    },
  });
  const options = { timeout: brainConfig.client.requestTimeoutMs };
  await client.connect(transport, options);
  const request = async (name, arguments_) => {
    const response = await client.callTool({ name, arguments: arguments_ }, undefined, options);
    const text = response.content?.find((item) => item.type === 'text')?.text;
    if (response.isError) {
      throw new Error(text ?? `Brain tool ${name} failed.`);
    }
    const value = response.structuredContent ?? (text ? JSON.parse(text) : undefined);
    if (!value || typeof value !== 'object') {
      throw new Error(`Brain tool ${name} returned an invalid response.`);
    }
    return value;
  };
  let reviewFeature = feature;
  if (reviewFeature === undefined) {
    const state = await request('brain_list_projects', {});
    const project = state.projects?.find((item) => item.id === projectId);
    if (!project) {
      throw new Error('The project is not available to this workstation token.');
    }
    reviewFeature = project.scope;
  }
  if (
    typeof reviewFeature !== 'string' ||
    !reviewFeature.trim() ||
    reviewFeature.length > brainConfig.analysis.maxTextCharacters
  ) {
    throw new Error('Provide a nonempty feature description within the configured text limit.');
  }
  const run = await request('brain_start_analysis', {
    projectId,
    commit,
    ...(baseCommit ? { baseCommit } : {}),
    feature: reviewFeature,
  });
  console.log(`Analysis ${run.id} · ${projectId} · ${commit}`);
  const deadline =
    !Number.isFinite(run.requestTimeoutMs) ||
    run.requestTimeoutMs === 0 ||
    brainConfig.cognee.indexTimeoutMs === 0
      ? Infinity
      : Date.now() +
        (3 + brainConfig.codeRetrieval.maxRounds) * run.requestTimeoutMs +
        brainConfig.cognee.indexTimeoutMs +
        brainConfig.client.completionGraceMs;
  while (true) {
    const result = await request('brain_get_analysis', { analysisId: run.id });
    if (result.status !== 'running') {
      if (result.status !== 'succeeded') {
        throw new Error(result.error ?? 'Analysis interrupted.');
      }
      const requirementCount = result.requirements.length;
      const explanation = requirementCount
        ? 'Only the extracted requirements and captured code were checked; this is not project approval.'
        : (result.noConclusionReason ??
          'No applicable requirements were extracted. No conclusion about the code.');
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
            codeRetrieval: result.codeRetrieval,
            sources: result.sources,
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
} finally {
  await client?.close();
}
