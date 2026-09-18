import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = new URL('../.env.postgres.local', import.meta.url);
const action = process.argv[2] ?? 'start';
if (!['start', 'stop', 'status'].includes(action)) {
  throw new Error('Use start, stop, or status. This command never removes database volumes.');
}

try {
  await access(envPath);
} catch {
  if (action !== 'start') {
    throw new Error('Run npm run db:start to configure the local PostgreSQL service first.');
  }
  const password = randomBytes(24).toString('hex');
  const port = Number(process.env.POSTGRES_PORT ?? 55432);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('POSTGRES_PORT must be an integer between 1024 and 65535.');
  }
  await writeFile(envPath, [
    '# Generated local database settings. Do not commit or share this file.',
    'POSTGRES_USER=harmonie',
    `POSTGRES_PASSWORD=${password}`,
    'POSTGRES_DB=harmonie',
    `POSTGRES_PORT=${port}`,
    `DATABASE_URL=postgresql://harmonie:${password}@127.0.0.1:${port}/harmonie`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
}

const args = ['compose', '--project-name', 'harmonie-dashboard-db', '--env-file', '.env.postgres.local', '-f', 'compose.postgres.yaml'];
args.push(...(action === 'start' ? ['up', '-d', '--wait'] : action === 'stop' ? ['stop'] : ['ps']));
const child = spawn('docker', args, { cwd: root, stdio: 'inherit', shell: false });
child.on('error', () => {
  console.error('Docker could not be started. Check Docker Desktop and run this command again.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
  if (code === 0 && action === 'start') {
    console.log('Local PostgreSQL is ready. The server reads .env.postgres.local; existing environment settings take precedence.');
    console.log('Existing SQLite data is unchanged. See POSTGRES.md before importing it.');
  }
});
