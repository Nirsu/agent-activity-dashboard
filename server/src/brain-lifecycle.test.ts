import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerBrain } from './brain.js';
import { registerBrainAgents } from './brain-agents.js';
import { BrainAgents } from './brain/analysis/service.js';
import { MemoryService } from './brain/memory/service.js';
import { NotionConnection } from './brain/notion/service.js';
import { CogneeClient } from './brain/cognee/client.js';

for (const failureAt of ['notion', 'memory', 'agents', 'cleanup'] as const) {
  test(`Brain releases every resource after ${failureAt} failure`, async (t) => {
    const closed: string[] = [];
    const previous = process.env.BRAIN_SYNC_ENABLED;
    process.env.BRAIN_SYNC_ENABLED = '0';
    t.after(() => {
      if (previous === undefined) {
        delete process.env.BRAIN_SYNC_ENABLED;
      } else {
        process.env.BRAIN_SYNC_ENABLED = previous;
      }
    });
    t.mock.method(NotionConnection.prototype, 'init', async () => {
      if (failureAt === 'notion') {
        throw new Error('Initialization fixture');
      }
    });
    t.mock.method(MemoryService.prototype, 'init', async function (this: MemoryService) {
      assert.equal(this.options.schedule, false);
      if (failureAt === 'memory') {
        throw new Error('Initialization fixture');
      }
    });
    t.mock.method(BrainAgents.prototype, 'init', async () => {
      if (failureAt === 'agents') {
        throw new Error('Initialization fixture');
      }
    });
    const notionClose = NotionConnection.prototype.close;
    const memoryClose = MemoryService.prototype.close;
    const agentsClose = BrainAgents.prototype.close;
    const cogneeClose = CogneeClient.prototype.close;
    t.mock.method(CogneeClient.prototype, 'close', function (this: CogneeClient) {
      closed.push('cognee');
      cogneeClose.call(this);
    });
    t.mock.method(NotionConnection.prototype, 'close', async function (this: NotionConnection) {
      closed.push('notion');
      await notionClose.call(this);
      if (failureAt === 'cleanup') {
        throw new Error('Cleanup fixture');
      }
    });
    t.mock.method(BrainAgents.prototype, 'close', async function (this: BrainAgents) {
      closed.push('agents');
      await agentsClose.call(this);
    });
    t.mock.method(MemoryService.prototype, 'close', async function (this: MemoryService) {
      closed.push('memory');
      await memoryClose.call(this);
    });
    const app = Fastify();
    if (failureAt === 'cleanup') {
      await registerBrain(app, { onActivity: async () => {} });
      await assert.rejects(app.close(), /Cleanup fixture/);
    } else {
      await assert.rejects(
        registerBrain(app, { onActivity: async () => {} }),
        /Initialization fixture/,
      );
      await app.close();
    }
    assert.deepEqual(closed, ['cognee', 'notion', 'agents', 'memory']);
  });
}

test('standalone Brain analysis registration installs cleanup before initialization', async (t) => {
  const app = Fastify();
  const service = new BrainAgents({ onActivity: async () => {} });
  t.mock.method(service, 'init', async () => {
    throw new Error('Initialization fixture');
  });
  const close = t.mock.method(service, 'close');
  await assert.rejects(registerBrainAgents(app, service), /Initialization fixture/);
  await app.close();
  assert.equal(close.mock.callCount(), 1);
  await service.close();
});
