import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

export function isBrainCallback(request: { method: string; url: string }) {
  const path = request.url.split('?')[0];
  return (
    (request.method === 'GET' && path === '/api/brain/connections/notion/callback') ||
    (request.method === 'POST' &&
      ['/api/brain/webhooks/notion', '/api/brain/webhooks/github'].includes(path))
  );
}

export async function requireBrainAdmin(request: FastifyRequest, reply: FastifyReply) {
  const required = process.env.BRAIN_ADMIN_TOKEN;
  if (required) {
    const provided = request.headers['x-brain-admin-token'];
    const expected = Buffer.from(required);
    const actual = Buffer.from(typeof provided === 'string' ? provided : '');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return;
    }
    return reply.code(403).send({ error: 'Administrator token required for this Brain action.' });
  }
  const localAddress = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(request.headers.host ?? '');
  if (!config.viewerToken && localAddress && localHost) {
    return;
  }
  return reply
    .code(403)
    .send({ error: 'Set BRAIN_ADMIN_TOKEN before managing a shared Brain deployment.' });
}
