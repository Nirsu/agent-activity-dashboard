import { brainConfig } from './brain/config.js';
import type { FastifyInstance } from 'fastify';
import { BrainAgents } from './brain/analysis/service.js';
import { reviewDecisions } from './brain/analysis/validation.js';
import { requireBrainAdmin } from './brain/access.js';
import type { BrainCorrelation } from './brain/analysis/types.js';

export { BrainAgents };

type StartAnalysisBody = BrainCorrelation & {
  projectId: string;
  commit?: string;
  baseCommit?: string;
  feature?: string;
};

type ReviewAnalysisBody = {
  findingId: string;
  decision: string;
  note: string;
  expectedReviewId?: string;
};

export async function registerBrainAgents(
  app: FastifyInstance,
  service = new BrainAgents(),
  options: { registerCloseHook?: boolean } = {},
) {
  if (options.registerCloseHook !== false) {
    app.addHook('onClose', () => service.close());
  }
  await service.init();

  app.get('/api/brain/agents', () => service.state());
  app.get('/api/brain/activity', () => service.overview());
  app.get<{ Params: { id: string } }>('/api/brain/analyses/:id', (request) =>
    service.detail(request.params.id),
  );

  app.post<{ Body: StartAnalysisBody }>(
    '/api/brain/analyses',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['projectId'],
          properties: {
            workItemId: {
              type: 'string',
              minLength: 1,
              maxLength: brainConfig.analysis.maxCorrelationCharacters,
            },
            ticket: {
              type: 'string',
              minLength: 1,
              maxLength: brainConfig.analysis.maxCorrelationCharacters,
            },
            originSessionId: {
              type: 'string',
              minLength: 1,
              maxLength: brainConfig.analysis.maxCorrelationCharacters,
            },
            parentRunId: {
              type: 'string',
              minLength: 1,
              maxLength: brainConfig.analysis.maxCorrelationCharacters,
            },
            projectId: { type: 'string', maxLength: brainConfig.projects.maxIdCharacters },
            commit: { type: 'string', pattern: '^[a-fA-F0-9]{40,64}$' },
            baseCommit: { type: 'string', pattern: '^[a-fA-F0-9]{40,64}$' },
            feature: {
              type: 'string',
              minLength: 1,
              maxLength: brainConfig.analysis.maxTextCharacters,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId, commit, baseCommit, feature } = request.body;
      const { workItemId, ticket, originSessionId, parentRunId } = request.body;
      const run = await service.start(projectId, commit, baseCommit, feature, undefined, {
        workItemId,
        ticket,
        originSessionId,
        parentRunId,
      });
      return reply.code(202).send(run);
    },
  );

  app.post<{ Params: { id: string }; Body: ReviewAnalysisBody }>(
    '/api/brain/analyses/:id/reviews',
    {
      preHandler: requireBrainAdmin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['findingId', 'decision', 'note'],
          properties: {
            findingId: { type: 'string', maxLength: brainConfig.memory.maxRecordIdCharacters },
            decision: { type: 'string', enum: reviewDecisions },
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
    (request) => {
      const { findingId, decision, note, expectedReviewId } = request.body;
      return service.review(request.params.id, findingId, decision, note, expectedReviewId);
    },
  );
}
