#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultConfigPath, readPolicy, repositoryAt, validatePolicy } from './project-policy.mjs';

export async function configureProjects({
  configPath = defaultConfigPath(),
  allow = [],
  remove = [],
} = {}) {
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
      const equal =
        process.platform === 'win32'
          ? existing.toLowerCase() === resolved.toLowerCase()
          : existing === resolved;
      if (equal) projects.delete(existing);
    }
  }
  const next = validatePolicy({ ...policy, projects: [...projects] });
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
