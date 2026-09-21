import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBrainAdmin } from '../brain/access.js';
import { readProjects } from '../brain/analysis/projects.js';
import { brainConfig } from '../brain/config.js';
import { AccessStore, accessError } from './store.js';

const text = z.string().trim().min(1).max(160);
const accountSchema = z
  .object({
    name: text,
    email: z
      .email()
      .max(254)
      .transform((email) => email.toLowerCase()),
    team: z
      .string()
      .trim()
      .max(80)
      .regex(/^[a-zA-Z0-9_.-]*$/),
    enabled: z.boolean(),
  })
  .strict();
const tokenSchema = z
  .object({
    accountId: z.uuid(),
    label: text,
    expiresInDays: z.number().int().min(1).max(brainConfig.access.maxTokenDays),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    accessError('Invalid account or token details. Check the fields and try again.');
  return result.data;
}

export function registerAccessRoutes(app: FastifyInstance, access: AccessStore) {
  const projects = () =>
    readProjects(
      process.env.BRAIN_PROJECTS_PATH ??
        resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'brain.projects.json'),
    );
  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0];
    if (path === '/api/brain/access' || path.startsWith('/api/brain/access/')) {
      reply.header('Cache-Control', 'no-store');
      return requireBrainAdmin(request, reply);
    }
  });
  const actor = () => (process.env.BRAIN_ADMIN_TOKEN ? 'administrator-key' : 'local-administrator');
  app.get('/api/brain/access', async () => ({
    ...access.snapshot(),
    projects: (await projects()).map(({ id, name }) => ({ id, name })),
  }));
  async function save(body: unknown, id?: string) {
    const input = parse(accountSchema, body);
    return access.saveAccount(input, actor(), id);
  }
  app.post('/api/brain/access/accounts', async (request) => save(request.body));
  app.put<{ Params: { id: string } }>('/api/brain/access/accounts/:id', async (request) =>
    save(request.body, request.params.id),
  );
  app.post('/api/brain/access/tokens', async (request) => {
    const input = parse(tokenSchema, request.body);
    return access.issue(input.accountId, input.label, input.expiresInDays, actor());
  });
  app.delete<{ Params: { id: string } }>('/api/brain/access/tokens/:id', async (request) => {
    await access.revoke(request.params.id, actor());
    return { ok: true };
  });
  app.put('/api/brain/access/policy', async (request) => {
    const input = parse(z.object({ required: z.boolean() }).strict(), request.body);
    await access.setRequired(input.required, actor());
    return { ok: true };
  });
  const repositorySchema = z
    .object({
      name: text,
      remote: z.string().trim().min(1).max(1000),
      enabled: z.boolean(),
      brainProjectId: z.string().max(80).optional(),
    })
    .strict();
  async function saveRepository(body: unknown, id?: string) {
    const input = parse(repositorySchema, body);
    if (
      input.enabled &&
      input.brainProjectId &&
      !(await projects()).some((project) => project.id === input.brainProjectId)
    )
      accessError('Select a registered Brain project.');
    return access.saveRepository(
      { ...input, brainProjectId: input.brainProjectId || undefined },
      actor(),
      id,
    );
  }
  app.post('/api/brain/access/repositories', async (request) => saveRepository(request.body));
  app.put<{ Params: { id: string } }>('/api/brain/access/repositories/:id', async (request) =>
    saveRepository(request.body, request.params.id),
  );
  app.put('/api/brain/access/repository-policy', async (request) => {
    const input = parse(z.object({ enabled: z.boolean() }).strict(), request.body);
    await access.setRepositoryFiltering(input.enabled, actor());
    return { ok: true };
  });
}
