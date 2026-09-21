import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { AccessStore } from './access/store.js';
import { closePostgresPool, getPostgresPool } from './persistence/postgres.js';

test(
  'PostgreSQL persists account policy and revocations, and rolls back failed account updates',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const originalUrl = process.env.DATABASE_URL;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `access_test_${randomUUID().replaceAll('-', '')}`;
    let store: AccessStore | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      process.env.DATABASE_URL = url.toString();
      store = new AccessStore('unused-access.db');
      await store.init();
      const input = {
        name: 'Dev',
        email: 'dev@example.test',
        team: 'one',
        projectIds: ['allowed'],
        enabled: true,
      };
      const account = await store.saveAccount(input, 'test');
      const { token, secret } = await store.issue(account.id, 'Laptop', 1, 'test');
      await store.setRequired(true, 'test');
      await store.saveRepository(
        { name: 'Project', remote: 'git@github.com:org/project.git', enabled: true },
        'test',
      );
      await store.setRepositoryFiltering(true, 'test');
      const persisted = await getPostgresPool()!.query(
        'SELECT data FROM access_tokens WHERE id=$1',
        [token.id],
      );
      assert.equal(JSON.stringify(persisted.rows).includes(secret), false);
      assert.ok(persisted.rows[0].data.digest);
      await store.close();
      store = new AccessStore('unused-access.db');
      await store.init();
      assert.equal(store.requireDeviceTokens, true);
      assert.deepEqual(store.repositoryPolicy(), {
        enabled: true,
        repositories: ['github.com/org/project'],
      });
      assert.ok(await store.authenticate(secret));
      await getPostgresPool()!.query(
        "ALTER TABLE access_audit ADD CONSTRAINT reject_disable CHECK (data->>'action' <> 'account.updated')",
      );
      await assert.rejects(store.saveAccount({ ...input, enabled: false }, 'test', account.id));
      assert.ok(
        await store.authenticate(secret),
        'failed transaction must not publish disabling or revocations',
      );
      await getPostgresPool()!.query('ALTER TABLE access_audit DROP CONSTRAINT reject_disable');
      await store.saveAccount({ ...input, enabled: false }, 'test', account.id);
      assert.equal(await store.authenticate(secret), null);
      await store.close();
      store = new AccessStore('unused-access.db');
      await store.init();
      assert.equal(await store.authenticate(secret), null);
      assert.ok(store.snapshot().tokens[0].revokedAt);
    } finally {
      await store?.close();
      await closePostgresPool();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
