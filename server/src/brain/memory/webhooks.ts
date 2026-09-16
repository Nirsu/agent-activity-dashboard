import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { brainConfig } from '../config.js';
import { fail } from '../analysis/validation.js';
import type { MemoryService } from './service.js';

export type MemoryWebhookOptions = {
  githubSecret?: string;
  notionVerificationToken?: string;
  githubProjects?: Record<string, string[]>;
};

export function verifyWebhookSignature(rawBody: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(header)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(header.slice('sha256='.length), 'hex'));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Invalid webhook payload.');
  }
  return value as Record<string, unknown>;
}

function eventId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(value) ||
    value.length > brainConfig.memory.maxRecordIdCharacters
  ) {
    fail('Invalid webhook event ID.');
  }
  return value;
}

function repositoryProjects(value: unknown): Record<string, string[]> {
  const mapping = object(value);
  if (Object.keys(mapping).length > brainConfig.projects.maxProjects) {
    fail('Too many GitHub webhook repository mappings.');
  }
  return Object.fromEntries(
    Object.entries(mapping).map(([repository, projects]) => {
      if (
        !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
        !Array.isArray(projects) ||
        projects.length > brainConfig.projects.maxProjects ||
        projects.some(
          (project) =>
            typeof project !== 'string' ||
            !/^[a-z0-9][a-z0-9_-]*$/.test(project) ||
            project.length > brainConfig.projects.maxIdCharacters,
        )
      ) {
        fail('Invalid GitHub webhook repository-to-project mapping.');
      }
      return [repository.toLowerCase(), projects];
    }),
  );
}

export async function registerMemoryWebhooks(
  app: FastifyInstance,
  service: MemoryService,
  options: MemoryWebhookOptions = {},
): Promise<void> {
  const githubSecret = options.githubSecret ?? process.env.BRAIN_GITHUB_WEBHOOK_SECRET;
  const notionToken =
    options.notionVerificationToken ?? process.env.BRAIN_NOTION_WEBHOOK_VERIFICATION_TOKEN;
  let githubProjects: Record<string, string[]>;
  try {
    githubProjects = repositoryProjects(
      options.githubProjects ?? JSON.parse(process.env.BRAIN_GITHUB_WEBHOOK_PROJECTS ?? '{}'),
    );
  } catch {
    throw new Error(
      'Configure BRAIN_GITHUB_WEBHOOK_PROJECTS as a JSON map of repository names to registered project ID arrays.',
    );
  }

  await app.register(async (webhooks) => {
    // Only these endpoints receive raw bytes; signature verification precedes JSON parsing.
    webhooks.removeAllContentTypeParsers();
    webhooks.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: brainConfig.synchronization.webhookMaxBodyBytes },
      (_request, body, done) => done(null, body),
    );

    function parse(rawBody: Buffer, header: unknown, secret?: string) {
      if (!secret) {
        fail('This webhook has not been configured by an administrator.', 503);
      }
      if (!Buffer.isBuffer(rawBody)) {
        fail('A JSON webhook body is required.');
      }
      if (!verifyWebhookSignature(rawBody, header, secret)) {
        fail('Invalid webhook signature.', 401);
      }
      try {
        return object(JSON.parse(rawBody.toString('utf8')));
      } catch {
        fail('Invalid webhook JSON.');
      }
    }

    function enqueue(provider: 'notion' | 'github', id: string, sourceIds: string[]) {
      let queued = 0;
      const recorded = service.store.recordEvent(`${provider}:${id}`, () => {
        for (const sourceId of sourceIds) {
          if (service.queue(sourceId)) {
            queued += 1;
          }
        }
      });
      return { accepted: true, duplicate: !recorded, queued };
    }

    const routeOptions = { bodyLimit: brainConfig.synchronization.webhookMaxBodyBytes };
    webhooks.post<{ Body: Buffer }>(
      '/api/brain/webhooks/notion',
      routeOptions,
      (request, reply) => {
        const payload = parse(request.body, request.headers['x-notion-signature'], notionToken);
        if ('verification_token' in payload) {
          fail(
            'Webhook verification tokens must be configured by an administrator; this endpoint never enrolls credentials from a request.',
          );
        }
        const id = eventId(payload.id);
        const relevantEvents = [
          'page.content_updated',
          'page.properties_updated',
          'page.created',
          'page.deleted',
          'page.undeleted',
          'page.moved',
        ];
        if (typeof payload.type !== 'string' || !relevantEvents.includes(payload.type)) {
          return reply.code(202).send({ accepted: true, ignored: true });
        }
        const entity = object(payload.entity);
        if (
          entity.type !== 'page' ||
          typeof entity.id !== 'string' ||
          !/^[a-f0-9-]{32,36}$/i.test(entity.id)
        ) {
          fail('Invalid Notion page event.');
        }
        const pageId = entity.id.replaceAll('-', '').toLowerCase();
        const sourceIds = service.store
          .sources()
          .filter(
            (source) =>
              source.kind === 'notion' &&
              source.pageId === pageId &&
              source.approval !== 'withdrawn',
          )
          .map((source) => source.id);
        if (!sourceIds.length) {
          return reply.code(202).send({ accepted: true, ignored: true });
        }
        return reply.code(202).send(enqueue('notion', id, sourceIds));
      },
    );

    webhooks.post<{ Body: Buffer }>(
      '/api/brain/webhooks/github',
      routeOptions,
      (request, reply) => {
        const payload = parse(request.body, request.headers['x-hub-signature-256'], githubSecret);
        const id = eventId(request.headers['x-github-delivery']);
        if (request.headers['x-github-event'] !== 'push') {
          return reply.code(202).send({ accepted: true, ignored: true });
        }
        const repository = object(payload.repository);
        if (typeof repository.full_name !== 'string') {
          fail('Invalid GitHub repository event.');
        }
        const projectIds = githubProjects[repository.full_name.toLowerCase()] ?? [];
        const sourceIds = service.store
          .sources()
          .filter(
            (source) =>
              source.kind === 'git' &&
              source.git &&
              projectIds.includes(source.git.projectId) &&
              source.approval !== 'withdrawn',
          )
          .map((source) => source.id);
        if (!sourceIds.length) {
          return reply.code(202).send({ accepted: true, ignored: true });
        }
        return reply.code(202).send(enqueue('github', id, sourceIds));
      },
    );
  });
}
