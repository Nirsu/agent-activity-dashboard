import { brainConfig } from './brain/config.js';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { BrainAgents, registerBrainAgents } from './brain-agents.js';
import { BrainService } from './brain/demo/service.js';
import { decisions } from './brain/demo/types.js';

export { BrainService };
export { makeSource, type Source } from './brain/sources.js';
export type { Finding } from './brain/demo/types.js';

const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode });
};

export async function registerBrain(app: FastifyInstance, service = new BrainService()) {
  await service.init();
  app.addHook('onClose', async () => {
    await service.close();
  });
  // Brain contains source text and mutations: accept only same-origin or the explicit local dev UI.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/brain')) {
      return;
    }
    if (!config.viewerToken) {
      const localAddress = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
      const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '');
      if (!localAddress || !localHost) {
        return reply
          .code(403)
          .send({ error: 'Unauthenticated Brain access is restricted to the local machine.' });
      }
    }
    if (req.headers.origin) {
      const allowed = new Set([
        `http://${req.headers.host}`,
        `https://${req.headers.host}`,
        `http://localhost:${brainConfig.launcher.defaultUiPort}`,
        `http://127.0.0.1:${brainConfig.launcher.defaultUiPort}`,
      ]);
      if (!allowed.has(req.headers.origin)) {
        return reply.code(403).send({ error: 'origin not allowed' });
      }
    }
  });
  app.get('/api/brain', async () => service.state());
  await registerBrainAgents(app, new BrainAgents({ dbPath: service.options.dbPath }));
  app.get<{ Params: { id: string } }>('/api/brain/sources/:id', async (req) =>
    service.source(req.params.id),
  );
  app.get<{ Querystring: { q?: string } }>('/api/brain/search', async (req) => {
    if (
      typeof req.query.q !== 'string' ||
      req.query.q.length > brainConfig.search.maxQueryCharacters
    ) {
      return fail(`Invalid search (maximum ${brainConfig.search.maxQueryCharacters} characters).`);
    }
    return { results: service.search(req.query.q) };
  });
  app.post<{ Body: { kind: 'import' | 'compare' } }>(
    '/api/brain/runs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: { kind: { type: 'string', enum: ['import', 'compare'] } },
        },
      },
    },
    async (req, reply) => reply.code(202).send(service.start(req.body.kind)),
  );
  app.put<{ Params: { id: string }; Body: { active: boolean; note: string } }>(
    '/api/brain/rules/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['active', 'note'],
          additionalProperties: false,
          properties: {
            active: { type: 'boolean' },
            note: { type: 'string', maxLength: brainConfig.review.maxActivationNoteCharacters },
          },
        },
      },
    },
    async (req) => service.activate(req.params.id, req.body.active, req.body.note),
  );
  app.post<{
    Params: { id: string };
    Body: { decision: string; note: string; expectedReviewId?: string };
  }>(
    '/api/brain/findings/:id/reviews',
    {
      schema: {
        body: {
          type: 'object',
          required: ['decision', 'note'],
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: [...decisions] },
            note: {
              type: 'string',
              minLength: brainConfig.review.minNoteCharacters,
              maxLength: brainConfig.review.maxNoteCharacters,
            },
            expectedReviewId: {
              type: 'string',
              maxLength: brainConfig.memory.maxRecordIdCharacters,
            },
          },
        },
      },
    },
    async (req) =>
      service.review(req.params.id, req.body.decision, req.body.note, req.body.expectedReviewId),
  );
}
