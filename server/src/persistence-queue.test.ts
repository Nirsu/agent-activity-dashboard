import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistenceQueue } from './persistence/queue.js';

test('persistence preserves order and stops acknowledging after a failed write', async () => {
  const saved: number[] = [];
  let failures = 0;
  const queue = new PersistenceQueue(() => { failures++; });
  queue.enqueue(async () => { saved.push(1); });
  queue.enqueue(async () => { saved.push(2); });
  await queue.flush();
  assert.deepEqual(saved, [1, 2]);
  queue.enqueue(async () => { throw new Error('database unavailable'); });
  queue.enqueue(async () => { saved.push(3); });
  await assert.rejects(queue.flush(), { statusCode: 503 });
  assert.equal(queue.healthy, false);
  assert.equal(failures, 1);
  assert.deepEqual(saved, [1, 2]);
});
