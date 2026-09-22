import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readPolicy, defaultConfigPath } from './project-policy.mjs';
import { relayCredentialId, requireAgentToken } from './relay-outbox.mjs';

const limits = createRequire(import.meta.url)('./relay-config.json');

export async function ensureRelay({ configPath = defaultConfigPath(), launch = spawn } = {}) {
  const policy = readPolicy(configPath);
  if (!policy.projects.length) return false;
  const token = requireAgentToken(process.env.HARMONIE_TOKEN);
  const url = `http://127.0.0.1:${policy.relayPort}/healthz`;
  const configurationId = createHash('sha256').update(resolve(configPath)).digest('hex');
  const credentialId = relayCredentialId(token);
  async function health() {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(limits.healthTimeoutMs) });
      const value = await response.json();
      if (
        value.service !== 'harmonie-project-relay' ||
        value.version !== 6 ||
        value.configurationId !== configurationId ||
        value.credentialId !== credentialId
      ) {
        throw new Error(
          'The relay port belongs to another service, an older installation or a different credential. Restart the installed relay.',
        );
      }
      return true;
    } catch (error) {
      if (error.message.startsWith('The relay port belongs')) throw error;
      return false;
    }
  }
  if (await health()) return true;
  const child = launch(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'relay.mjs')],
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, AAD_TELEMETRY_CONFIG: resolve(configPath) },
    },
  );
  let launchError;
  child.on('error', (error) => {
    launchError = error;
  });
  child.unref();
  const deadline = Date.now() + limits.startupTimeoutMs;
  while (Date.now() < deadline && !launchError) {
    await delay(limits.startupPollMs);
    if (await health()) return true;
  }
  throw new Error('The telemetry relay could not start. Run agents:relay to inspect its status.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      (await ensureRelay()) ? 'Telemetry relay is running.' : 'No repositories selected.',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
