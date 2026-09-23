import type { FastifyInstance } from 'fastify';
import { requireBrainAdmin } from '../access.js';
import { brainConfig } from '../config.js';
import type { PricingService } from './service.js';

export function registerPricingRoutes(app: FastifyInstance, pricing: PricingService) {
  const model = { type: 'string', minLength: 1, maxLength: brainConfig.pricing.maxModelCharacters };
  app.get('/api/brain/pricing', () => pricing.state());
  app.post(
    '/api/brain/pricing/models',
    { preHandler: requireBrainAdmin, bodyLimit: brainConfig.pricing.maxSourceCharacters },
    (request) => pricing.save(request.body),
  );
  app.post(
    '/api/brain/pricing/ignore',
    {
      preHandler: requireBrainAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['model', 'revision', 'ignored'],
          additionalProperties: false,
          properties: {
            model,
            revision: { type: 'integer', minimum: 1 },
            ignored: { type: 'boolean' },
          },
        },
      },
    },
    (request) => pricing.setIgnored(request.body),
  );
  app.post<{ Body: { models: string[] } }>(
    '/api/brain/pricing/lookup',
    {
      preHandler: requireBrainAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['models'],
          additionalProperties: false,
          properties: {
            models: {
              type: 'array',
              minItems: 1,
              maxItems: brainConfig.pricing.maxModels,
              uniqueItems: true,
              items: model,
            },
          },
        },
      },
    },
    async (request, reply) => reply.code(202).send(await pricing.start(request.body.models)),
  );
  app.post<{ Body: { jobId: string; model: string } }>(
    '/api/brain/pricing/apply',
    {
      preHandler: requireBrainAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['jobId', 'model'],
          additionalProperties: false,
          properties: { jobId: { type: 'string', maxLength: 100 }, model },
        },
      },
    },
    (request) => pricing.apply(request.body.jobId, request.body.model),
  );
}
