import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { BrainAgents, registerBrainAgents } from './brain-agents.js';
import { requireBrainAdmin, requireBrainAccess } from './brain/access.js';
import { CogneeClient } from './brain/cognee/client.js';
import { NotionConnection } from './brain/notion/service.js';
import { registerNotionRoutes } from './brain/notion/routes.js';
import { MemoryService } from './brain/memory/service.js';
import { registerMemoryRoutes } from './brain/memory/routes.js';
import { registerMemoryWebhooks } from './brain/memory/webhooks.js';
import { registerMemoryGraph } from './brain/graph.js';
import { registerBrainMcp } from './brain/mcp.js';
import type { BrainAgentsOptions } from './brain/analysis/types.js';
import type { ProjectRegistry } from './brain/project-registry.js';

export { makeSource, type Source } from './brain/sources.js';

export async function registerBrain(
  app: FastifyInstance,
  options: Pick<BrainAgentsOptions, 'onActivity'> & { registry?: ProjectRegistry } = {},
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const dbPath = process.env.BRAIN_DB_PATH ?? resolve(config.dataDir, 'brain.db');
  const projectsPath = process.env.BRAIN_PROJECTS_PATH ?? resolve(root, 'brain.projects.json');
  const loadProjects = options.registry ? () => options.registry!.projects() : undefined;
  const notion = new NotionConnection();
  const cognee = new CogneeClient();
  const memory = new MemoryService({
    dbPath,
    projectsPath,
    loadProjects,
    notion,
    cognee,
    schedule: process.env.BRAIN_SYNC_ENABLED !== '0',
    syncMode: process.env.BRAIN_SYNC_MODE === 'webhook' ? 'webhook' : 'poll',
  });
  const agents = new BrainAgents({
    dbPath,
    projectsPath,
    loadProjects,
    memory,
    onActivity: options.onActivity,
    projectStatus: options.registry
      ? (projectId) => options.registry!.projectStatus(projectId)
      : undefined,
  });
  options.registry?.setReferenceStatus((projectId) => memory.readiness(projectId));
  // Register cleanup before initialization can fail. Abort upstream work before awaiting workers.
  app.addHook('onClose', async () => {
    try {
      cognee.close();
      await notion.close();
    } finally {
      try {
        await agents.close();
      } finally {
        await memory.close();
      }
    }
  });
  await notion.init();
  await memory.init();
  app.addHook('onRequest', requireBrainAccess);
  await registerNotionRoutes(app, notion, requireBrainAdmin);
  registerMemoryRoutes(app, memory, requireBrainAdmin);
  await registerMemoryWebhooks(app, memory);
  await registerBrainAgents(app, agents, { registerCloseHook: false });
  registerBrainMcp(app, agents);
  registerMemoryGraph(app, memory, agents);
}
