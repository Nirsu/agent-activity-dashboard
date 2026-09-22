import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import { requireBrainAdmin } from '../brain/access.js';
import { brainConfig } from '../brain/config.js';
import { AccessStore, accessError } from './store.js';
import type { ProjectRegistry } from '../brain/project-registry.js';

const text = z.string().trim().min(1).max(160);
const accountSchema = z
  .object({
    name: text,
    email: z
      .email()
      .max(254)
      .transform((email) => email.toLowerCase()),
    teamIds: z.array(z.uuid()),
    enabled: z.boolean(),
  })
  .strict();
const teamSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const tokenSchema = z
  .object({
    accountId: z.uuid(),
    label: text,
    expiresInDays: z.number().int().min(1).max(brainConfig.access.maxTokenDays).nullish(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) accessError('Invalid details. Check the fields and try again.');
  return result.data;
}

export function registerAccessRoutes(
  app: FastifyInstance,
  access: AccessStore,
  registry: ProjectRegistry,
  onTeamsChanged?: () => void,
) {
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
    repositories: registry.repositories(),
    projects: (await registry.projects()).map(({ id, name }) => ({ id, name })),
  }));
  async function save(body: unknown, id?: string) {
    const input = parse(accountSchema, body);
    const account = await access.saveAccount(input, actor(), id);
    onTeamsChanged?.();
    return account;
  }
  app.post('/api/brain/access/accounts', async (request) => save(request.body));
  app.put<{ Params: { id: string } }>('/api/brain/access/accounts/:id', async (request) =>
    save(request.body, request.params.id),
  );
  async function saveTeam(body: unknown, id?: string) {
    const team = await access.saveTeam(parse(teamSchema, body), actor(), id);
    onTeamsChanged?.();
    return team;
  }
  app.post('/api/brain/access/teams', async (request) => saveTeam(request.body));
  app.put<{ Params: { id: string } }>('/api/brain/access/teams/:id', async (request) =>
    saveTeam(request.body, request.params.id),
  );
  app.delete<{ Params: { id: string } }>('/api/brain/access/teams/:id', async (request) => {
    await access.removeTeam(request.params.id, actor());
    onTeamsChanged?.();
    return { ok: true };
  });
  app.post('/api/brain/access/tokens', async (request) => {
    const input = parse(tokenSchema, request.body);
    return access.issue(input.accountId, input.label, input.expiresInDays, actor());
  });
  app.delete<{ Params: { id: string } }>('/api/brain/access/tokens/:id', async (request) => {
    await access.revoke(request.params.id, actor());
    return { ok: true };
  });
  const repositorySchema = z
    .object({
      name: text,
      remote: z.string().trim().min(1).max(1000),
      enabled: z.boolean(),
      brainProjectId: z.string().max(80).optional(),
      brainScope: z.string().trim().max(brainConfig.analysis.maxTextCharacters).optional(),
      brainCodePaths: z
        .array(z.string().trim().min(1).max(brainConfig.projects.maxGitPathCharacters))
        .min(1)
        .max(brainConfig.projects.maxCodePaths)
        .optional(),
    })
    .strict();
  async function saveRepository(body: unknown, id?: string) {
    const input = parse(repositorySchema, body);
    return registry.save(
      { ...input, brainProjectId: input.brainProjectId || undefined },
      actor(),
      id,
    );
  }
  app.post('/api/brain/access/repositories', async (request) => saveRepository(request.body));
  app.put<{ Params: { id: string } }>('/api/brain/access/repositories/:id', async (request) =>
    saveRepository(request.body, request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/api/brain/access/repositories/:id/check',
    async (request) => registry.check(request.params.id),
  );
  app.put('/api/brain/access/repository-policy', async (request) => {
    const input = parse(z.object({ enabled: z.boolean() }).strict(), request.body);
    await access.setRepositoryFiltering(input.enabled, actor());
    return { ok: true };
  });
}
