import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { act, create } from 'react-test-renderer';

test('Projects registers Brain automatically, checks readiness and preserves scope and identity when editing', async (t) => {
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
      state.repositories.push({
        ...body,
        id: state.repositories.length ? 'dashboard-repository' : 'repository',
        brainProjectId: body.brainProjectId ?? 'shared-project',
        brainScope: body.brainScope || 'Shared project',
        brainStatus: { state: 'unverified', message: 'Check code access and approved references.' },
        remote: body.brainProjectId ? 'github.com/org/dashboard' : 'github.com/org/project',
      });
      return Response.json(state.repositories.at(-1));
    }
    if (path.endsWith('/repositories/repository/check')) {
      state.repositories[0].brainStatus = {
        state: 'needs_references',
        message: 'Approve project references in Memory.',
      };
      return Response.json(state.repositories[0]);
    }
    if (path.endsWith('/repositories/repository'))
      state.repositories[0] = { ...state.repositories[0], ...body, id: 'repository' };
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
  assert.equal(renderer.root.findAllByType('form').length, 0);
  await act(async () => button('Add project').props.onClick());
  await act(async () => {
    field('Project name').props.onChange({ target: { value: 'Shared project' } });
    field('GitHub repository URL').props.onChange({
      target: { value: 'git@github.com:org/project.git' },
    });
  });
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.match(text(), /github.com\/org\/project/);
  assert.equal(requests[0].body.brainProjectId, undefined);
  assert.deepEqual(requests[0].body.brainCodePaths, ['**']);
  assert.match(text(), /Brain check needed/);
  assert.doesNotMatch(text(), /Activity only/);
  assert.equal(renderer.root.findAllByType('form').length, 0, 'successful save closes the editor');
  await act(async () => button('Check Brain access').props.onClick());
  assert.equal(requests.at(-1)?.path, '/api/brain/access/repositories/repository/check');
  assert.match(text(), /References needed/);
  assert.equal(renderer.root.findAllByProps({ href: '#brain/memory' }).length, 2);
  await act(async () =>
    renderer.root
      .findByProps({ 'aria-label': 'Search projects' })
      .props.onChange({ target: { value: 'references needed' } }),
  );
  assert.equal(renderer.root.findAllByType('article').length, 1, 'search includes Brain readiness');
  await act(async () =>
    renderer.root
      .findByProps({ 'aria-label': 'Search projects' })
      .props.onChange({ target: { value: '' } }),
  );
  await act(async () => button('Enable repository filter').props.onClick());
  assert.match(text(), /Repository filter enabled/);
  await act(async () => button('Disable repository').props.onClick());
  assert.equal(requests.at(-1)?.body.enabled, false);
  assert.equal(requests.at(-1)?.body.brainScope, 'Shared project');
  assert.deepEqual(requests.at(-1)?.body.brainCodePaths, ['**']);
  assert.equal(
    requests.at(-1)?.body.brainStatus,
    undefined,
    'readiness is not submitted as repository input',
  );
  assert.match(text(), /Disabled/);
  assert.equal(button('Check Brain access').props.disabled, true);
  assert.match(text(), /Enable repository/);
  await act(async () =>
    renderer.root
      .findByProps({ 'aria-label': 'Search projects' })
      .props.onChange({ target: { value: 'missing' } }),
  );
  assert.match(text(), /No matching projects/);
  assert.equal(renderer.root.findAllByType('article').length, 0);
  await act(async () => button('Clear filters').props.onClick());
  assert.equal(renderer.root.findAllByType('article').length, 1);
  await act(async () => button('Edit repository').props.onClick());
  assert.equal(field('Project name').props.value, 'Shared project');
  assert.equal(
    renderer.root.findAllByType('select').length,
    0,
    'registered Brain identities cannot be replaced',
  );
  await act(async () => {
    field('Project name').props.onChange({ target: { value: 'Renamed project' } });
    renderer.root
      .findAllByType('textarea')[0]
      .props.onChange({ target: { value: 'Customer portal' } });
    renderer.root
      .findAllByType('textarea')[1]
      .props.onChange({ target: { value: 'src/\npackage.json' } });
  });
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(requests.at(-1)?.path, '/api/brain/access/repositories/repository');
  assert.equal(requests.at(-1)?.body.brainProjectId, 'shared-project');
  assert.equal(requests.at(-1)?.body.brainScope, 'Customer portal');
  assert.deepEqual(requests.at(-1)?.body.brainCodePaths, ['src/', 'package.json']);
  assert.equal(requests.at(-1)?.body.enabled, false, 'editing must not re-enable a repository');
  assert.equal(state.repositories.length, 1, 'editing must not create a duplicate');
  assert.match(text(), /shared-project/);
  await act(async () =>
    renderer.root
      .findByProps({ 'aria-label': 'Search projects' })
      .props.onChange({ target: { value: 'shared-project' } }),
  );
  assert.equal(
    renderer.root.findAllByType('article').length,
    1,
    'search includes Brain project identities',
  );
  await act(async () => button('Edit repository').props.onClick());
  const beforeCancel = requests.length;
  await act(async () => button('Cancel editing').props.onClick());
  assert.equal(requests.length, beforeCancel);
  assert.equal(renderer.root.findAllByType('form').length, 0);
  await act(async () => button('Add project').props.onClick());
  assert.equal(field('Project name').props.value, '');
  assert.equal(field('GitHub repository URL').props.value, '');
  assert.equal(renderer.root.findByType('select').props.value, '');
  await act(async () => {
    field('Project name').props.onChange({ target: { value: 'Dashboard repository' } });
    field('GitHub repository URL').props.onChange({
      target: { value: 'git@github.com:org/dashboard.git' },
    });
    renderer.root.findAllByType('textarea')[1].props.onChange({ target: { value: '' } });
  });
  const beforeInvalid = requests.length;
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(requests.length, beforeInvalid, 'an empty code scope is not submitted');
  assert.match(text(), /Enter between 1 and 30 code paths/);
  await act(async () =>
    renderer.root.findByType('select').props.onChange({ target: { value: 'dashboard' } }),
  );
  assert.equal(
    renderer.root.findAllByType('textarea').length,
    0,
    'adopting an existing project retains its scope',
  );
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(requests.at(-1)?.body.brainProjectId, 'dashboard');
  assert.equal(requests.at(-1)?.body.brainCodePaths, undefined);
  assert.equal(requests.at(-1)?.body.brainScope, undefined);
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
    teams: [{ id: 'mobile-team', name: 'Mobile', createdAt: '2026-01-01T00:00:00Z' }],
    tokens: [] as any[],
    projects: [{ id: 'dashboard', name: 'Dashboard project' }],
    audit: [],
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
      if (!body.enabled)
        state.tokens.forEach((token) => {
          token.revokedAt = new Date().toISOString();
        });
      return Response.json(state.accounts[0]);
    }
    if (path.endsWith('/tokens')) {
      const token = {
        id: state.tokens.length ? 'temporary-device' : 'device',
        ...body,
        expiresAt:
          body.expiresInDays === undefined
            ? null
            : new Date(Date.now() + body.expiresInDays * 86400000).toISOString(),
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
  assert.match(text(), /Individual workstation tokens/);
  assert.match(text(), /Required/);
  assert.doesNotMatch(text(), /Transition|Shared keys|Allow shared keys|Require individual tokens/);
  const field = (name: string) =>
    renderer.root
      .findAllByType('label')
      .find((node) => node.children[0] === name)!
      .findByType('input');
  assert.equal(renderer.root.findAllByType('form').length, 0);
  await act(async () => button('New account').props.onClick());
  await act(async () => {
    field('Name').props.onChange({ target: { value: 'New developer' } });
    field('Email').props.onChange({ target: { value: 'dev@example.test' } });
    renderer.root
      .findByProps({ value: 'mobile-team' })
      .props.onChange({ target: { checked: true } });
  });
  await act(async () =>
    renderer.root.findByProps({ className: 'access-form' }).props.onSubmit({ preventDefault() {} }),
  );
  assert.match(text(), /Workstations/);
  assert.match(text(), /New developer/);
  assert.equal(requests.find((request) => request.method === 'POST')!.body.projectIds, undefined);
  assert.deepEqual(state.accounts[0].teamIds, ['mobile-team']);
  assert.equal(renderer.root.findAllByType('fieldset').length, 1);
  assert.match(text(), /All active accounts share access/);
  assert.equal(renderer.root.findByType('select').props.value, 'none');
  assert.equal(
    renderer.root.findAllByProps({ type: 'number' }).length,
    0,
    'expiration duration is optional',
  );
  await act(async () => field('Workstation name').props.onChange({ target: { value: 'Laptop' } }));
  await act(async () =>
    renderer.root
      .findByProps({ className: 'access-token-form' })
      .props.onSubmit({ preventDefault() {} }),
  );
  assert.equal(renderer.root.findByType('textarea').props.value, 'test-secret-only-once');
  const firstIssue = requests.find(
    (request) => request.path.endsWith('/tokens') && request.method === 'POST',
  );
  assert.deepEqual(firstIssue?.body, { accountId: 'person', label: 'Laptop' });
  assert.equal(state.tokens[0].expiresAt, null);
  assert.ok(
    renderer.root.findAllByType('small').some((node) => node.children[0] === 'No expiration'),
  );
  await act(async () => button('Copy token').props.onClick());
  assert.match(text(), /Could not copy automatically/);
  await act(async () => button('I have saved it — close').props.onClick());
  await act(async () =>
    renderer.root.findByType('select').props.onChange({ target: { value: 'duration' } }),
  );
  assert.equal(field('Expires in days').props.value, '90');
  assert.equal(field('Expires in days').props.min, 1);
  assert.equal(field('Expires in days').props.max, 365);
  await act(async () => field('Expires in days').props.onChange({ target: { value: '366' } }));
  const beforeInvalidDuration = requests.filter(
    (request) => request.path.endsWith('/tokens') && request.method === 'POST',
  ).length;
  await act(async () =>
    renderer.root
      .findByProps({ className: 'access-token-form' })
      .props.onSubmit({ preventDefault() {} }),
  );
  assert.equal(
    requests.filter((request) => request.path.endsWith('/tokens') && request.method === 'POST')
      .length,
    beforeInvalidDuration,
  );
  assert.match(text(), /Enter a duration from 1 to 365 days/);
  await act(async () => {
    field('Expires in days').props.onChange({ target: { value: '14' } });
    field('Workstation name').props.onChange({ target: { value: 'Temporary laptop' } });
  });
  await act(async () =>
    renderer.root
      .findByProps({ className: 'access-token-form' })
      .props.onSubmit({ preventDefault() {} }),
  );
  assert.deepEqual(
    requests
      .filter((request) => request.path.endsWith('/tokens') && request.method === 'POST')
      .at(-1)?.body,
    {
      accountId: 'person',
      label: 'Temporary laptop',
      expiresInDays: 14,
    },
  );
  assert.equal(typeof state.tokens[1].expiresAt, 'string');
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
  const statusFilter = renderer.root.findByProps({ 'aria-label': 'Filter accounts by status' });
  await act(async () =>
    statusFilter
      .findAllByType('button')
      .find((node) => node.children[0] === 'Active')!
      .props.onClick(),
  );
  assert.match(text(), /No matching developers/);
  await act(async () => button('Clear filters').props.onClick());
  await act(async () =>
    renderer.root
      .findByProps({ 'aria-label': 'Search accounts' })
      .props.onChange({ target: { value: 'MOBILE' } }),
  );
  assert.equal(
    renderer.root.findByProps({ className: 'access-list' }).findAllByType('button').length,
    1,
    'search includes team names without case sensitivity',
  );
  assert.equal(
    requests.find((request) => request.method === 'DELETE')?.path,
    '/api/brain/access/tokens/device',
  );
  assert.equal(requests.filter((request) => request.method === 'PUT').at(-1)?.body.enabled, false);
  await act(async () => button('Lock page').props.onClick());
  assert.match(text(), /Unlock accounts/);
  assert.doesNotMatch(text(), /Account details/);
});

test('Accounts manages reusable teams and preserves multi-team drafts across errors and team changes', async (t) => {
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
    teams: [] as { id: string; name: string; createdAt: string }[],
    tokens: [],
    projects: [],
    audit: [],
    repositories: [],
    filterRepositories: false,
  };
  const requests: { path: string; method: string; body: any }[] = [];
  let failAccountSave = false;
  let releaseSave: (() => void) | undefined;
  let deferSave = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'GET') return Response.json(state);
    requests.push({ path, method, body });
    if (path.endsWith('/teams')) {
      if (state.teams.some((team) => team.name.toLowerCase() === body.name.toLowerCase())) {
        return Response.json({ error: 'A team with this name already exists.' }, { status: 409 });
      }
      const team = {
        ...body,
        id: `team-${state.teams.length + 1}`,
        createdAt: new Date().toISOString(),
      };
      state.teams.push(team);
      return Response.json(team);
    }
    if (path.includes('/teams/')) {
      const id = path.split('/').at(-1);
      if (method === 'DELETE') {
        state.teams = state.teams.filter((team) => team.id !== id);
        return Response.json({ ok: true });
      }
      const team = state.teams.find((team) => team.id === id)!;
      team.name = body.name;
      return Response.json(team);
    }
    if (deferSave) {
      await new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
    }
    if (failAccountSave) {
      return Response.json({ error: 'Could not save account. Try again.' }, { status: 503 });
    }
    if (path.endsWith('/accounts')) {
      const account = { ...body, id: 'person', activityLabel: 'calm-otter-42' };
      state.accounts.push(account);
      return Response.json(account);
    }
    state.accounts[0] = { ...state.accounts[0], ...body };
    return Response.json(state.accounts[0]);
  });
  const { Accounts } = await vite.ssrLoadModule('/src/components/Accounts.tsx');
  await act(async () => {
    renderer = create(<Accounts />);
  });
  const text = () => JSON.stringify(renderer.toJSON());
  const button = (name: string) =>
    renderer.root.findAllByType('button').find((node) => node.props.children === name)!;
  const field = (name: string) =>
    renderer.root
      .findAllByType('label')
      .find((node) => node.children[0] === name)!
      .findByType('input');
  const checkbox = (id: string) => renderer.root.findByProps({ type: 'checkbox', value: id });
  const submitTeam = async () => {
    await act(async () =>
      renderer.root
        .findByProps({ className: 'access-team-form' })
        .props.onSubmit({ preventDefault() {} }),
    );
  };
  const submitAccount = async () => {
    await act(async () =>
      renderer.root
        .findByProps({ className: 'access-form' })
        .props.onSubmit({ preventDefault() {} }),
    );
  };
  assert.match(text(), /No teams yet/);
  await act(async () => button('New account').props.onClick());
  assert.match(text(), /Create a team in the Teams section above/);
  assert.equal(renderer.root.findAllByProps({ placeholder: 'e.g. platform-team' }).length, 0);
  await act(async () => {
    field('Name').props.onChange({ target: { value: 'Alex' } });
    field('Email').props.onChange({ target: { value: 'alex@example.test' } });
    button('New team').props.onClick();
  });
  await act(async () => field('Team name').props.onChange({ target: { value: 'Platform' } }));
  await submitTeam();
  assert.equal(field('Name').props.value, 'Alex', 'creating teams preserves the account draft');
  await act(async () => checkbox('team-1').props.onChange({ target: { checked: true } }));
  await act(async () => button('New team').props.onClick());
  await act(async () => field('Team name').props.onChange({ target: { value: 'platform' } }));
  await submitTeam();
  assert.match(text(), /A team with this name already exists/);
  assert.equal(field('Team name').props.value, 'platform');
  assert.equal(checkbox('team-1').props.checked, true);
  await act(async () => field('Team name').props.onChange({ target: { value: 'Design Systems' } }));
  await submitTeam();
  await act(async () => checkbox('team-2').props.onChange({ target: { checked: true } }));
  failAccountSave = true;
  deferSave = true;
  await submitAccount();
  assert.equal(button('Create account').props.disabled, true);
  assert.equal(button('New team').props.disabled, true);
  assert.equal(
    renderer.root.findByProps({ className: 'access-team-selection' }).props.disabled,
    true,
  );
  await act(async () => releaseSave!());
  assert.match(text(), /Could not save account/);
  assert.equal(field('Name').props.value, 'Alex');
  assert.equal(checkbox('team-1').props.checked, true);
  assert.equal(checkbox('team-2').props.checked, true);
  failAccountSave = false;
  deferSave = false;
  await submitAccount();
  assert.deepEqual(state.accounts[0].teamIds, ['team-1', 'team-2']);
  assert.equal(
    requests.find((request) => request.path.endsWith('/accounts'))?.body.team,
    undefined,
  );
  assert.match(text(), /Platform, Design Systems/);
  assert.equal(renderer.root.findByProps({ 'aria-label': 'Delete Platform' }).props.disabled, true);
  await act(async () =>
    renderer.root.findByProps({ 'aria-label': 'Rename Platform' }).props.onClick(),
  );
  await act(async () => field('Team name').props.onChange({ target: { value: 'Infrastructure' } }));
  await submitTeam();
  assert.deepEqual(
    state.accounts[0].teamIds,
    ['team-1', 'team-2'],
    'renaming preserves membership IDs',
  );
  assert.match(text(), /Infrastructure, Design Systems/);
  for (const query of ['infrastructure', 'DESIGN SYSTEMS']) {
    await act(async () =>
      renderer.root
        .findByProps({ 'aria-label': 'Search accounts' })
        .props.onChange({ target: { value: query } }),
    );
    assert.equal(
      renderer.root.findByProps({ className: 'access-list' }).findAllByType('button').length,
      1,
    );
  }
  await act(async () => checkbox('team-1').props.onChange({ target: { checked: false } }));
  await submitAccount();
  assert.deepEqual(state.accounts[0].teamIds, ['team-2']);
  assert.equal(checkbox('team-1').props.checked, false);
  assert.equal(checkbox('team-2').props.checked, true);
  await act(async () =>
    renderer.root.findByProps({ 'aria-label': 'Delete Infrastructure' }).props.onClick(),
  );
  assert.equal(state.teams.length, 1);
  assert.equal(renderer.root.findAllByProps({ type: 'checkbox', value: 'team-1' }).length, 0);
  assert.equal(requests.at(-1)?.method, 'DELETE');
  assert.equal(requests.at(-1)?.path, '/api/brain/access/teams/team-1');
  await act(async () => checkbox('team-2').props.onChange({ target: { checked: false } }));
  await submitAccount();
  assert.deepEqual(state.accounts[0].teamIds, [], 'all memberships can be removed');
});

test('Workstations distinguishes perpetual, expired, revoked and invalid credentials', async (t) => {
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
  });
  const { Workstations, tokenStatus } = await vite.ssrLoadModule(
    '/src/components/access/Workstations.tsx',
  );
  const tokens = [
    { id: 'perpetual', expiresAt: null },
    { id: 'temporary', expiresAt: new Date(Date.now() + 86400000).toISOString() },
    { id: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' },
    { id: 'revoked', expiresAt: null, revokedAt: '2020-01-01T00:00:00.000Z' },
    { id: 'malformed', expiresAt: 'not-a-timestamp' },
    { id: 'missing' },
  ].map((token) => ({ accountId: 'person', label: token.id, ...token }));
  assert.deepEqual(tokens.map(tokenStatus), [
    'Active',
    'Active',
    'Expired',
    'Revoked',
    'Invalid',
    'Invalid',
  ]);
  await act(async () => {
    renderer = create(
      <Workstations
        account={{ id: 'person', enabled: true }}
        access={{ state: { tokens }, busy: false, issued: null }}
      />,
    );
  });
  const expirationLabels = renderer.root
    .findAllByType('small')
    .map((node) => node.children.join(''));
  assert.equal(expirationLabels.filter((value) => value === 'No expiration').length, 2);
  assert.equal(expirationLabels.filter((value) => value === 'Expiration unknown').length, 2);
  assert.ok(!expirationLabels.some((value) => value.includes('Invalid Date')));
  assert.equal(
    renderer.root.findAllByType('button').filter((node) => node.children[0] === 'Revoke').length,
    2,
  );
});
