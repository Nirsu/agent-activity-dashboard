// Shared by the server and installed relay. Never retain credentials from Git URLs.
function normalizeRepositoryRemote(value) {
  if (typeof value !== 'string') return undefined;
  const input = value.trim();
  if (!input || input.length > 1000 || /[\s\\%?#]/.test(input) || /(^|\/)\.{1,2}(\/|$)/.test(input))
    return undefined;
  let url;
  try {
    const scp = /^[^/@:]+:\d+\//.test(input) ? null : /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(input);
    url = new URL(
      input.includes('://') ? input : scp ? `ssh://${scp[1]}/${scp[2]}` : `https://${input}`,
    );
  } catch {
    return undefined;
  }
  if (
    !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) ||
    url.password ||
    (url.username && url.protocol !== 'ssh:')
  )
    return undefined;
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (
    !path ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !/^[a-zA-Z0-9_./~-]+$/.test(path)
  )
    return undefined;
  const port =
    (url.protocol === 'ssh:' && url.port === '22') ||
    (url.protocol === 'git:' && url.port === '9418')
      ? ''
      : url.port;
  return `${url.hostname.toLowerCase()}${port ? ':' + port : ''}/${url.hostname === 'github.com' ? path.toLowerCase() : path}`;
}
module.exports = { normalizeRepositoryRemote };
