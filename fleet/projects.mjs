#!/usr/bin/env node
import { mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultConfigPath, readPolicy, repositoryAt, validatePolicy } from './project-policy.mjs';

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function existingOrResolvedPath(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function configureProjects({
  configPath = defaultConfigPath(),
  allow = [],
  remove = [],
  bindWorkspace,
  repository,
  unbindWorkspace = [],
} = {}) {
  if ((bindWorkspace === undefined) !== (repository === undefined)) {
    throw new Error('Use --bind-workspace and --repository together.');
  }
  const policy = readPolicy(configPath);
  const projects = new Set(policy.projects);
  for (const path of allow) {
    const repository = repositoryAt(resolve(path));
    if (!repository) throw new Error('Every allowed project must be an existing Git repository.');
    projects.add(repository.path);
  }
  for (const path of remove) {
    const resolved = repositoryAt(resolve(path))?.path ?? resolve(path);
    for (const existing of projects) {
      if (samePath(existing, resolved)) {
        projects.delete(existing);
      }
    }
  }
  let workspaceBindings = (policy.workspaceBindings ?? []).filter((binding) =>
    [...projects].some((path) => samePath(path, binding.repository)),
  );
  for (const path of unbindWorkspace) {
    const workspace = await existingOrResolvedPath(path);
    const retained = [];
    for (const binding of workspaceBindings) {
      if (!samePath(await existingOrResolvedPath(binding.workspace), workspace)) {
        retained.push(binding);
      }
    }
    workspaceBindings = retained;
  }
  if (bindWorkspace !== undefined) {
    let workspace;
    try {
      workspace = await realpath(resolve(bindWorkspace));
      if (!(await stat(workspace)).isDirectory()) {
        throw new Error('Not a directory');
      }
    } catch {
      throw new Error('The workspace must be an existing directory.');
    }
    if (repositoryAt(workspace)) {
      throw new Error('Only a workspace outside a Git repository can be bound.');
    }
    const target = repositoryAt(resolve(repository));
    const selected = target
      ? [...projects].find((path) => {
          const candidate = repositoryAt(path);
          return candidate && samePath(candidate.path, target.path);
        })
      : undefined;
    if (!selected) {
      throw new Error(
        'The workspace target must be a selected Git repository. Use --allow to select this exact checkout first.',
      );
    }
    const existingIndex = workspaceBindings.findIndex((binding) =>
      samePath(binding.workspace, workspace),
    );
    const binding = { workspace, repository: selected };
    if (existingIndex === -1) {
      workspaceBindings.push(binding);
    } else {
      workspaceBindings[existingIndex] = binding;
    }
  }
  const next = validatePolicy({
    ...policy,
    projects: [...projects],
    ...(workspaceBindings.length || policy.workspaceBindings !== undefined
      ? { workspaceBindings }
      : {}),
  });
  if (JSON.stringify(next) !== JSON.stringify(policy)) {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    const temporary = `${configPath}.tmp.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, configPath);
  }
  return { configPath, ...next };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        allow: { type: 'string', multiple: true },
        remove: { type: 'string', multiple: true },
        'bind-workspace': { type: 'string' },
        repository: { type: 'string' },
        'unbind-workspace': { type: 'string', multiple: true },
        list: { type: 'boolean' },
        config: { type: 'string' },
      },
    });
    console.log(
      JSON.stringify(
        await configureProjects({
          configPath: values.config,
          allow: values.allow,
          remove: values.remove,
          bindWorkspace: values['bind-workspace'],
          repository: values.repository,
          unbindWorkspace: values['unbind-workspace'],
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
