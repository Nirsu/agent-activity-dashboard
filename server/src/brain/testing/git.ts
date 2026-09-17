import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function fixtureGit(repository: string) {
  // Fixtures must not inherit personal identities, signing, hooks, templates or Git paths.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return async (...args: string[]) => {
    const result = await exec(
      'git',
      [
        '-c',
        'user.name=Brain tests',
        '-c',
        'user.email=brain-tests@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'init.templateDir=',
        '-C',
        repository,
        ...args,
      ],
      { env, encoding: 'utf8', windowsHide: true },
    );
    return result.stdout.trim();
  };
}
