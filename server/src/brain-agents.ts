import { brainConfig } from './brain/config.js';
import type { FastifyInstance } from 'fastify';
import { BrainAgents } from './brain/analysis/service.js';
import { reviewDecisions } from './brain/analysis/validation.js';

export { BrainAgents };

type StartAnalysisBody = {
  projectId: string;
  commit?: string;
  baseCommit?: string;
};

type ReviewAnalysisBody = {
  findingId: string;
  decision: string;
  note: string;
  expectedReviewId?: string;
};

export async function registerBrainAgents(app: FastifyInstance, service = new BrainAgents()) {
  await service.init();
  app.addHook('onClose', () => service.close());

  app.get('/api/brain/agents', () => service.state());
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
            projectId: { type: 'string', maxLength: brainConfig.projects.maxIdCharacters },
            commit: { type: 'string', pattern: '^[a-fA-F0-9]{40,64}$' },
            baseCommit: { type: 'string', pattern: '^[a-fA-F0-9]{40,64}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const { projectId, commit, baseCommit } = request.body;
      const run = await service.start(projectId, commit, baseCommit);
      return reply.code(202).send(run);
    },
  );

  app.post<{ Params: { id: string }; Body: ReviewAnalysisBody }>(
    '/api/brain/analyses/:id/reviews',
    {
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
