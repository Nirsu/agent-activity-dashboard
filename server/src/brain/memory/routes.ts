import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { brainConfig } from '../config.js';
import { fail } from '../analysis/validation.js';
import { normalizePageId } from '../notion/page.js';
import type { MemoryService } from './service.js';
import type { SourcePolicy } from './types.js';

type NewSource = SourcePolicy & { pageId: string; title?: string };

export function registerMemoryRoutes(
  app: FastifyInstance,
  service: MemoryService,
  requireAdmin: preHandlerHookHandler,
): void {
  const policyProperties = {
    projectIds: {
      type: 'array',
      maxItems: brainConfig.projects.maxProjects,
      uniqueItems: true,
      items: { type: 'string', maxLength: brainConfig.projects.maxIdCharacters },
    },
    shared: { type: 'boolean' },
    mandatory: { type: 'boolean' },
    approval: { type: 'string', enum: ['draft', 'approved', 'withdrawn'] },
    includeSubpages: { type: 'boolean' },
    autoApproveSubpages: { type: 'boolean' },
  };
  const requiredPolicy = ['projectIds', 'shared', 'mandatory', 'approval'];
  const idParams = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', maxLength: brainConfig.memory.maxRecordIdCharacters } },
  };

  app.get('/api/brain/memory', () => service.state());
  app.post<{ Body: NewSource }>(
    '/api/brain/memory/sources',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['pageId', ...requiredPolicy],
          properties: {
            ...policyProperties,
            pageId: { type: 'string', maxLength: brainConfig.projects.maxLocalPathCharacters },
            title: { type: 'string', maxLength: brainConfig.analysis.maxTitleCharacters },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await service.register({
        ...request.body,
        pageId: normalizePageId(request.body.pageId),
      });
      return reply.code(201).send(result);
    },
  );
  app.put<{ Params: { id: string }; Body: SourcePolicy }>(
    '/api/brain/memory/sources/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: requiredPolicy,
          properties: policyProperties,
        },
      },
    },
    (request) => service.update(request.params.id, request.body),
  );
  app.post<{ Params: { id: string } }>(
    '/api/brain/memory/sources/:id/approve-subpages',
    { preHandler: requireAdmin, schema: { params: idParams } },
    (request) => service.approveSubpages(request.params.id),
  );
  app.post<{ Body: { sourceId?: string } }>(
    '/api/brain/memory/sync',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sourceId: { type: 'string', maxLength: brainConfig.memory.maxRecordIdCharacters },
          },
        },
      },
    },
    (request, reply) => {
      const jobs = request.body?.sourceId
        ? [service.queue(request.body.sourceId)].filter(Boolean)
        : service.queueAll();
      return reply.code(202).send({ jobs });
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/brain/sources/:id',
    { schema: { params: idParams } },
    (request) => {
      const capture = service.store.capture(request.params.id);
      if (!capture) {
        fail('Captured source not found.', 404);
      }
      return capture;
    },
  );
  app.post('/api/brain/memory/connection-test', { preHandler: requireAdmin }, () =>
    service.checkConnection(),
  );
}
