import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

const brainConfig = createRequire(import.meta.url)('../server/src/brain/config.json');

const root = fileURLToPath(new URL('../', import.meta.url));
let app;
let ui;
let stopping = false;

async function stop(code = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), brainConfig.launcher.shutdownTimeoutMs);
  timeout.unref();
  const closed = await Promise.allSettled([ui?.close(), app?.close()]);
  clearTimeout(timeout);
  if (process.connected) {
    process.disconnect();
  }
  process.exitCode = closed.some((result) => result.status === 'rejected') ? 1 : code;
}

try {
  await Promise.all(
    ['server/dist/index.js', 'ui/dist/index.html'].map((path) =>
      access(new URL(`../${path}`, import.meta.url)),
    ),
  );
  // A local preview stays on loopback, regardless of the deployment HOST in .env.
  process.env.HOST = '127.0.0.1';
  process.env.LOG_LEVEL ??= 'warn';
  const { buildApp } = await import('../server/dist/index.js');
  const { config } = await import('../server/dist/config.js');
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: config.port });
  ui = await preview({
    root: fileURLToPath(new URL('../ui', import.meta.url)),
    configFile: false,
    preview: {
      host: '127.0.0.1',
      port: Number(process.env.BRAIN_UI_PORT ?? brainConfig.launcher.defaultUiPort),
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${config.port}`,
        '/live': { target: `ws://127.0.0.1:${config.port}`, ws: true },
      },
    },
  });
  console.log(`Harmony Brain: ${ui.resolvedUrls.local[0]}#brain`);
  console.log(
    'Local pilot. AI analyses are available after configuring a model. Press Ctrl+C to stop.',
  );
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  // Also lets the portable smoke check request graceful shutdown on Windows.
  process.on('message', (message) => {
    if (message === 'stop') {
      void stop();
    }
  });
} catch (error) {
  console.error(
    error.code === 'ENOENT' ? `From ${root}, run npm ci followed by npm run build.` : error.message,
  );
  await stop(1);
}
