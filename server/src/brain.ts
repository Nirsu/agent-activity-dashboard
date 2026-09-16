import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { BrainAgents, registerBrainAgents } from './brain-agents.js';
import { brainConfig } from './brain/config.js';
import { requireBrainAdmin, isBrainCallback } from './brain/access.js';
import { CogneeClient } from './brain/cognee/client.js';
import { NotionConnection } from './brain/notion/service.js';
import { registerNotionRoutes } from './brain/notion/routes.js';
import { MemoryService } from './brain/memory/service.js';
import { registerMemoryRoutes } from './brain/memory/routes.js';
import { registerMemoryWebhooks } from './brain/memory/webhooks.js';
import { registerMemoryGraph } from './brain/graph.js';

export { makeSource, type Source } from './brain/sources.js';

export async function registerBrain(app: FastifyInstance) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const dbPath = process.env.BRAIN_DB_PATH ?? resolve(config.dataDir, 'brain.db');
  const projectsPath = process.env.BRAIN_PROJECTS_PATH ?? resolve(root, 'brain.projects.json');
  const notion = new NotionConnection();
  const cognee = new CogneeClient();
  const memory = new MemoryService({
    dbPath,
    projectsPath,
    notion,
    cognee,
    syncMode: process.env.BRAIN_SYNC_MODE === 'webhook' ? 'webhook' : 'poll',
  });
  await notion.init();
  await memory.init();
  app.addHook('onClose', () => memory.close());
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/brain') || isBrainCallback(request)) {
      return;
    }
    if (!config.viewerToken) {
      const localAddress = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
      const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(
        request.headers.host ?? '',
      );
      if (!localAddress || !localHost) {
        return reply
          .code(403)
          .send({ error: 'Unauthenticated Brain access is restricted to the local machine.' });
      }
    }
    if (request.headers.origin) {
      const allowed = new Set([
        `http://${request.headers.host}`,
        `https://${request.headers.host}`,
        `http://localhost:${brainConfig.launcher.defaultUiPort}`,
        `http://127.0.0.1:${brainConfig.launcher.defaultUiPort}`,
      ]);
      if (!allowed.has(request.headers.origin)) {
        return reply.code(403).send({ error: 'origin not allowed' });
      }
    }
  });
  await registerNotionRoutes(app, notion, requireBrainAdmin);
  registerMemoryRoutes(app, memory, requireBrainAdmin);
  await registerMemoryWebhooks(app, memory);
  const agents = new BrainAgents({ dbPath, projectsPath, memory });
  await registerBrainAgents(app, agents);
  registerMemoryGraph(app, memory, agents);
  // Fastify closes hooks in reverse order. Abort upstream work before waiting for analyses.
  app.addHook('onClose', async () => {
    cognee.close();
    await notion.close();
  });
}
