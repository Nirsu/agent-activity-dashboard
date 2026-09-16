import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { brainConfig } from '../config.js';
import { NotionConnection, NotionError } from './service.js';

export async function registerNotionRoutes(
  app: FastifyInstance,
  connection: NotionConnection,
  requireAdmin: preHandlerHookHandler,
): Promise<void> {
  await connection.init();
  const administration = { preHandler: requireAdmin };
  app.get('/api/brain/connections/notion', administration, () => connection.state());
  app.post('/api/brain/connections/notion/connect', administration, () => connection.connect());
  app.delete('/api/brain/connections/notion', administration, () => connection.disconnect());
  app.post<{ Body: { pageId?: string } }>(
    '/api/brain/connections/notion/test',
    {
      ...administration,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: { type: 'string', maxLength: brainConfig.projects.maxLocalPathCharacters },
          },
        },
      },
    },
    (request) => connection.test(request.body?.pageId),
  );
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/brain/connections/notion/callback',
    {
      logLevel: 'silent',
      schema: {
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string', maxLength: brainConfig.analysis.maxTextCharacters },
            state: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            error: { type: 'string', maxLength: brainConfig.analysis.maxTextCharacters },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.type('text/plain; charset=utf-8');
      try {
        await connection.callback(
          request.query.error ? '' : (request.query.code ?? ''),
          request.query.state ?? '',
        );
        return 'Notion is connected. Return to Harmony Brain Settings to select and synchronize sources.';
      } catch (error) {
        const message =
          error instanceof NotionError
            ? error.message
            : 'Notion authorization failed. Return to Harmony Brain Settings and connect again.';
        return reply.code(error instanceof NotionError ? error.statusCode : 502).send(message);
      }
    },
  );
}
