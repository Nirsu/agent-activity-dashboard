import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { act, create } from 'react-test-renderer';

test('Projects adds a shared repository, enables filtering and disables an existing repository', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL('http://localhost/#projects'),
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
  const vite = await createServer({
    root: resolve('ui'),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  let renderer!: ReturnType<typeof create>;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    if (original) Object.defineProperty(globalThis, 'location', original);
    else Reflect.deleteProperty(globalThis, 'location');
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const state = {
    accounts: [],
    tokens: [],
    audit: [],
    projects: [{ id: 'dashboard', name: 'Dashboard project' }],
    requireDeviceTokens: false,
    filterRepositories: false,
    repositories: [] as any[],
  };
  const requests: { path: string; body: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json(state);
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body });
    if (path.endsWith('/repository-policy')) state.filterRepositories = body.enabled;
    if (path.endsWith('/repositories')) {
      state.repositories.push({ ...body, id: 'repository', remote: 'github.com/org/project' });
      return Response.json(state.repositories[0]);
    }
    if (path.endsWith('/repositories/repository'))
      state.repositories[0] = { ...body, id: 'repository' };
    return Response.json({ ok: true });
  });
  const { Projects } = await vite.ssrLoadModule('/src/components/Projects.tsx');
  await act(async () => {
    renderer = create(<Projects />);
  });
  const button = (name: string) =>
    renderer.root.findAllByType('button').find((node) => node.props.children === name)!;
  const text = () => JSON.stringify(renderer.toJSON());
  const field = (name: string) =>
    renderer.root
      .findAllByType('label')
      .find((node) => node.children[0] === name)!
      .findByType('input');
  await act(async () => {
    field('Project name').props.onChange({ target: { value: 'Shared project' } });
    field('Git remote URL').props.onChange({ target: { value: 'git@github.com:org/project.git' } });
  });
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.match(text(), /github.com\/org\/project/);
  assert.equal(requests[0].body.brainProjectId, undefined);
  assert.equal(field('Git remote URL').props.value, '');
  await act(async () => button('Enable repository filter').props.onClick());
  assert.match(text(), /Repository filter enabled/);
  await act(async () => button('Disable repository').props.onClick());
  assert.equal(requests.at(-1)?.body.enabled, false);
  assert.match(text(), /Disabled/);
  assert.match(text(), /Enable repository/);
  await act(async () => button('Edit repository').props.onClick());
  assert.equal(field('Project name').props.value, 'Shared project');
  await act(async () => {
    renderer.root.findByType('select').props.onChange({ target: { value: 'dashboard' } });
    field('Project name').props.onChange({ target: { value: 'Renamed project' } });
  });
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(requests.at(-1)?.path, '/api/brain/access/repositories/repository');
  assert.equal(requests.at(-1)?.body.brainProjectId, 'dashboard');
  assert.equal(requests.at(-1)?.body.enabled, false, 'editing must not re-enable a repository');
  assert.equal(state.repositories.length, 1, 'editing must not create a duplicate');
  assert.match(text(), /Brain: Dashboard project/);
  await act(async () => button('Edit repository').props.onClick());
  await act(async () =>
    renderer.root.findByType('select').props.onChange({ target: { value: '' } }),
  );
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(state.repositories[0].brainProjectId, undefined);
  await act(async () => button('Edit repository').props.onClick());
  const beforeCancel = requests.length;
  await act(async () => button('Cancel editing').props.onClick());
  assert.equal(requests.length, beforeCancel);
  assert.equal(field('Project name').props.value, '');
});

test('Accounts creates a developer, shows a secret only on issuance, revokes tokens and disables the account', async (t) => {
  const restore: (() => void)[] = [];
  for (const [name, value] of Object.entries({
    location: new URL('http://localhost/#accounts'),
    localStorage: { getItem: () => null },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() =>
      original
        ? Object.defineProperty(globalThis, name, original)
        : Reflect.deleteProperty(globalThis, name),
    );
  }
  const vite = await createServer({
    root: resolve('ui'),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'error',
  });
  let renderer!: ReturnType<typeof create>;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    restore.forEach((work) => work());
  });
  const state = {
    accounts: [] as any[],
    tokens: [] as any[],
    projects: [{ id: 'dashboard', name: 'Dashboard project' }],
    audit: [],
    requireDeviceTokens: false,
  };
  const requests: { path: string; method: string; body: any }[] = [];
  let accessRevoked = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (accessRevoked)
      return Response.json({ error: 'Administrator access revoked.' }, { status: 403 });
    if (method === 'GET') return Response.json(state);
    if (path.endsWith('/accounts')) {
      const account = { ...body, id: 'person', activityLabel: 'calm-otter-42' };
      state.accounts.push(account);
      return Response.json(account);
    }
    if (path.endsWith('/accounts/person')) {
      state.accounts[0] = { ...state.accounts[0], ...body };
      return Response.json(state.accounts[0]);
    }
    if (path.endsWith('/tokens')) {
      const token = {
        id: 'device',
        ...body,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      state.tokens.push(token);
      return Response.json({ token, secret: 'test-secret-only-once' });
    }
    if (method === 'DELETE') state.tokens[0].revokedAt = new Date().toISOString();
    return Response.json({ ok: true });
  });
  const { Accounts } = await vite.ssrLoadModule('/src/components/Accounts.tsx');
  await act(async () => {
    renderer = create(<Accounts />);
  });
  const button = (name: string) =>
    renderer.root.findAllByType('button').find((node) => node.props.children === name)!;
  const text = () => JSON.stringify(renderer.toJSON());
  const field = (name: string) =>
    renderer.root
      .findAllByType('label')
      .find((node) => node.children[0] === name)!
      .findByType('input');
  await act(async () => {
    field('Name').props.onChange({ target: { value: 'New developer' } });
    field('Email').props.onChange({ target: { value: 'dev@example.test' } });
    field('Team').props.onChange({ target: { value: 'mobile' } });
  });
  await act(async () =>
    renderer.root.findByProps({ className: 'access-form' }).props.onSubmit({ preventDefault() {} }),
  );
  assert.match(text(), /Workstations/);
  assert.match(text(), /New developer/);
  assert.equal(requests.find((request) => request.method === 'POST')!.body.projectIds, undefined);
  assert.equal(renderer.root.findAllByType('fieldset').length, 0);
  assert.match(text(), /All active accounts share access/);
  await act(async () => field('Workstation name').props.onChange({ target: { value: 'Laptop' } }));
  await act(async () =>
    renderer.root
      .findByProps({ className: 'access-token-form' })
      .props.onSubmit({ preventDefault() {} }),
  );
  assert.equal(renderer.root.findByType('textarea').props.value, 'test-secret-only-once');
  accessRevoked = true;
  await act(async () => button('Refresh').props.onClick());
  assert.doesNotMatch(text(), /test-secret-only-once/);
  assert.match(text(), /Unlock accounts/);
  accessRevoked = false;
  await act(async () => button('Refresh').props.onClick());
  assert.doesNotMatch(text(), /test-secret-only-once/);
  await act(async () => button('Revoke').props.onClick());
  assert.match(text(), /Revoked/);
  await act(async () => button('Disable & revoke all tokens').props.onClick());
  assert.match(text(), /Disabled/);
  assert.equal(button('Generate token').props.disabled, true);
  assert.equal(
    requests.find((request) => request.method === 'DELETE')?.path,
    '/api/brain/access/tokens/device',
  );
  assert.equal(requests.filter((request) => request.method === 'PUT').at(-1)?.body.enabled, false);
});
