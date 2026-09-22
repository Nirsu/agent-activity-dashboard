// Minimal env config. No dependency on dotenv — Node 20 reads .env via
// `node --env-file`, and tsx honours process.env; we also do a tiny manual
// .env parse so `npm run dev` works without extra flags.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(filename: string): void {
  const envPath = resolve(__dirname, '../..', filename);
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // no .env — defaults apply
  }
}
loadDotEnv('.env');
loadDotEnv('.env.postgres.local');

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v !== '0' && v.toLowerCase() !== 'false';
}

export const config = {
  port: num('PORT', 4318),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ?? resolve(__dirname, '../data'),
  ringSize: num('RING_SIZE', 500),
  idleMs: num('IDLE_MS', 45_000),
  sessionTtlMs: num('SESSION_TTL_MS', 30 * 60_000),
  codexMetadataDb: process.env.CODEX_METADATA_DB,
  retentionDays: num('RETENTION_DAYS', 60),
  // Pseudonymize identities (default on). Off only for a single-user local run.
  anonymize: bool('ANONYMIZE', true),
  anonymizeSalt: process.env.ANONYMIZE_SALT ?? 'aad-fleet',
  // Browser access uses an independent viewer key, or trusted local access.
  // Agent endpoints always authenticate an issued workstation token.
  viewerToken: process.env.VIEWER_TOKEN,
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY,
  jira: {
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_API_TOKEN,
  },
};

export type Config = typeof config;
