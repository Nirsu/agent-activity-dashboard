import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { brainConfig } from './config.js';
import '../access/identity.js';

export function isBrainCallback(request: { method: string; url: string }) {
  const path = request.url.split('?')[0];
  return (
    (request.method === 'GET' && path === '/api/brain/connections/notion/callback') ||
    (request.method === 'POST' &&
      ['/api/brain/webhooks/notion', '/api/brain/webhooks/github'].includes(path))
  );
}

export async function requireBrainAccess(request: FastifyRequest, reply: FastifyReply) {
  if (!request.url.startsWith('/api/brain') || isBrainCallback(request)) {
    return;
  }
  const isMcp = request.url.split('?')[0] === '/api/brain/mcp';
  if (isMcp && !request.accessPrincipal) {
    return reply.code(401).send({ error: 'An individual workstation token is required.' });
  }
  if (request.accessPrincipal) {
    if (!isMcp) {
      return reply
        .code(403)
        .send({ error: 'Workstation tokens only allow telemetry and Brain MCP.' });
    }
  } else if (config.viewerToken) {
    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : request.headers['x-aad-token'];
    const expected = Buffer.from(config.viewerToken);
    const actual = Buffer.from(typeof provided === 'string' ? provided : '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  } else {
    const localAddress = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(request.headers.host ?? '');
    if (!localAddress || !localHost) {
      return reply
        .code(403)
        .send({ error: 'Unauthenticated Brain access is restricted to the local machine.' });
    }
  }
  if (request.headers.origin) {
    const allowed = new Set([
      `http://${request.headers.host}`,
      `https://${request.headers.host}`,
      `http://localhost:${brainConfig.launcher.defaultUiPort}`,
      `http://127.0.0.1:${brainConfig.launcher.defaultUiPort}`,
    ]);
    if (!allowed.has(request.headers.origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
  }
}

export async function requireBrainAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.accessPrincipal) {
    return reply
      .code(403)
      .send({ error: 'Workstation tokens cannot perform human administration.' });
  }
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
