#!/usr/bin/env node
// Install the local agent bridge without replacing unrelated client settings.
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { defaultRelayPort, repositoryAt, validatePolicy } from './project-policy.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const relayLimits = createRequire(import.meta.url)('./relay-config.json');
const begin = '# >>> harmonie-agent-telemetry';
const end = '# <<< harmonie-agent-telemetry';
const events = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
];

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object. No settings were changed.`);
  }
  return value;
}

function parseSettings(text, path) {
  if (!text) return {};
  try {
    return object(JSON.parse(text.replace(/^\uFEFF/, '')), path);
  } catch {
    throw new Error(`Invalid JSON in ${path}. No settings were changed.`);
  }
}

function serializeSettings(original, settings, path) {
  // Clients may reformat their own JSON. Do not replace an equivalent file.
  if (original && isDeepStrictEqual(parseSettings(original, path), settings)) return original;
  return JSON.stringify(settings, null, 2) + '\n';
}

export function validateUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error('Use an HTTPS origin, or HTTP on localhost, without credentials or a path.');
  }
  return url.origin;
}

export function mergeHooks(settings, command, wrapper, client) {
  const hooks = object(settings.hooks ?? {}, 'hooks');
  for (const event of client === 'codex' ? [...events, 'Interrupt'] : events) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array.`);
    // Only replace our own stable wrapper. Preserve every other handler, including
    // handlers sharing the same matcher group.
    hooks[event] = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks)) throw new Error(`Invalid hooks.${event} group.`);
      const handlers = group.hooks.filter(
        (handler) =>
          !handler.command?.replaceAll('\\', '/').includes(wrapper.replaceAll('\\', '/')),
      );
      return handlers.length ? [{ ...group, hooks: handlers }] : [];
    });
    hooks[event].push({
      hooks: [{ type: 'command', command, timeout: relayLimits.hookTimeoutSeconds }],
    });
  }
  return { ...settings, hooks };
}

export function codexTelemetry(text, url) {
  let existing = text;
  const from = text.indexOf(begin);
  let afterBlock = 0;
  if (from >= 0) {
    const to = text.indexOf(end, from);
    if (to < 0 || text.indexOf(begin, from + begin.length) >= 0) {
      throw new Error('Invalid managed telemetry block. No settings were changed.');
    }
    afterBlock = to + end.length;
    if (text.slice(afterBlock).startsWith('\r\n')) afterBlock += 2;
    else if (text[afterBlock] === '\n') afterBlock += 1;
    existing = text.slice(0, from) + text.slice(afterBlock);
  }
  if (
    /^\s*\[\s*["']?otel(?:["']?\s*\]|["']?\.)/m.test(existing) ||
    /^\s*otel\s*[.=]/m.test(existing)
  ) {
    throw new Error(
      'Codex already has unmanaged OTel settings. Merge them explicitly before running setup.',
    );
  }
  const block =
    `${begin}\n[otel]\nenvironment = "harmonie"\nlog_user_prompt = false\ntrace_exporter = "none"\n\n` +
    `[otel.exporter.otlp-http]\nendpoint = ${JSON.stringify(`${url}/v1/logs`)}\nprotocol = "json"\n\n` +
    `[otel.metrics_exporter.otlp-http]\nendpoint = ${JSON.stringify(`${url}/v1/metrics`)}\nprotocol = "json"\n${end}\n`;
  if (from >= 0) return text.slice(0, from) + block + text.slice(afterBlock);
  return existing + (existing ? (existing.endsWith('\n') ? '\n' : '\n\n') : '') + block;
}

function hookCommand(nodePath, wrapper, platform, client) {
  if (platform === 'win32') {
    // Codex runs hooks in PowerShell, which needs the call operator before a
    // quoted executable. Claude uses Bash and must keep the plain command.
    const paths = [nodePath, wrapper].map((path) => path.replaceAll('\\', '/'));
    if (paths.some((path) => /["\r\n%$`]/.test(path)))
      throw new Error('Unsupported character in hook path.');
    const command = paths.map((path) => `"${path}"`).join(' ');
    return client === 'codex' ? `& ${command}` : command;
  }
  return [nodePath, wrapper].map((path) => "'" + path.replaceAll("'", "'\\''") + "'").join(' ');
}

function wrapperSource(provider, client, url, team) {
  return (
    `// Installed by Harmonie agent setup. Structural metadata only.\n` +
    `import { fileURLToPath } from 'node:url';\n` +
    `process.env.AAD_PROVIDER = ${JSON.stringify(provider)};\n` +
    `process.env.AAD_CLIENT ??= ${JSON.stringify(client)};\n` +
    `process.env.AAD_URL = ${JSON.stringify(url)};\n` +
    (team
      ? `process.env.OTEL_RESOURCE_ATTRIBUTES ??= ${JSON.stringify(`team.id=${team}`)};\n`
      : '') +
    `if (process.env.AAD_DRY_RUN !== '1') {\n` +
    `  try {\n` +
    `    const { ensureRelay } = await import('./ensure-relay.mjs');\n` +
    `    await ensureRelay({ configPath: fileURLToPath(new URL('./telemetry.json', import.meta.url)) });\n` +
    `  } catch { console.error('Harmonie telemetry relay unavailable. Run agents:relay to inspect it.'); process.exit(0); }\n` +
    `}\n` +
    `await import('./hook.mjs');\n`
  );
}

export async function setup({
  home = homedir(),
  codexHome = process.env.CODEX_HOME || join(home, '.codex'),
  claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
  url,
  projects = [],
  relayPort,
  clients = ['codex', 'claude'],
  codexClient = 'desktop',
  team = '',
  apply = false,
  nodePath = process.execPath,
  platform = process.platform,
} = {}) {
  const installDir = join(home, '.config', 'harmonie-agents');
  const policyPath = join(installDir, 'telemetry.json');
  const originalPolicy = await readOptional(policyPath);
  const previousPolicy = originalPolicy
    ? validatePolicy(parseSettings(originalPolicy, policyPath))
    : undefined;
  url = validateUrl(url ?? previousPolicy?.dashboardUrl ?? 'http://127.0.0.1:4318');
  const selected = new Set(previousPolicy?.projects ?? []);
  for (const path of projects) {
    const project = repositoryAt(resolve(path));
    if (!project) throw new Error('Every selected project must be an existing Git repository.');
    selected.add(project.path);
  }
  const policy = validatePolicy({
    ...previousPolicy,
    version: 1,
    dashboardUrl: url,
    relayPort: relayPort ?? previousPolicy?.relayPort ?? defaultRelayPort,
    projects: [...selected],
  });
  const relayUrl = `http://127.0.0.1:${policy.relayPort}`;
  if (!clients.length || clients.some((client) => !['codex', 'claude'].includes(client))) {
    throw new Error('Clients must be codex, claude, or codex,claude.');
  }
  if (!['desktop', 'cli', 'vscode'].includes(codexClient)) throw new Error('Invalid Codex client.');
  if (team && !/^[a-zA-Z0-9_.-]{1,80}$/.test(team)) throw new Error('Use a short team identifier.');
  const planned = new Map();
  planned.set(policyPath, serializeSettings(originalPolicy, policy, policyPath));
  for (const name of [
    'project-policy.mjs',
    'repository-url.cjs',
    'projects.mjs',
    'relay.mjs',
    'ensure-relay.mjs',
    'relay-config.json',
    'relay-outbox.mjs',
    'safe-telemetry.mjs',
  ]) {
    planned.set(join(installDir, name), await readFile(join(repository, 'fleet', name), 'utf8'));
  }
  planned.set(
    join(installDir, 'hook.mjs'),
    await readFile(join(repository, 'hooks', 'hook.js'), 'utf8'),
  );
  const warnings = [];

  for (const client of new Set(clients)) {
    const wrapper = join(installDir, `${client}-hook.mjs`);
    planned.set(
      wrapper,
      wrapperSource(client, client === 'codex' ? codexClient : 'cli', relayUrl, team),
    );
    const command = hookCommand(nodePath, wrapper, platform, client);
    const settingsPath =
      client === 'codex' ? join(codexHome, 'hooks.json') : join(claudeHome, 'settings.json');
    const originalSettings = await readOptional(settingsPath);
    const current = parseSettings(originalSettings, settingsPath);
    const settings = mergeHooks(current, command, wrapper, client);
    if (client === 'claude') {
      settings.env = {
        ...object(settings.env ?? {}, 'env'),
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: relayUrl,
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${relayUrl}/v1/logs`,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${relayUrl}/v1/metrics`,
        OTEL_LOGS_EXPORT_INTERVAL: '1000',
        OTEL_METRIC_EXPORT_INTERVAL: '2000',
        OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
        OTEL_LOG_USER_PROMPTS: '0',
        OTEL_LOG_TOOL_DETAILS: '0',
        OTEL_LOG_TOOL_CONTENT: '0',
        OTEL_LOG_RAW_API_BODIES: '0',
      };
      if (settings.disableAllHooks)
        warnings.push('Claude hooks are disabled by existing settings; review that setting.');
    }
    planned.set(settingsPath, serializeSettings(originalSettings, settings, settingsPath));

    if (client === 'codex') {
      const path = join(codexHome, 'config.toml');
      const original = await readOptional(path);
      let config = codexTelemetry(original, relayUrl);
      const section =
        /^\s*\[mcp_servers\.["']?harmony-brain["']?\s*\][^\S\r\n]*\r?\n[\s\S]*?(?=^\s*\[|$(?![\s\S]))/m;
      const tokenLine = 'bearer_token_env_var = "HARMONIE_TOKEN"\n';
      if (!/^\s*\[mcp_servers\.["']?harmony-brain["']?\s*\]/m.test(original)) {
        config += `\n[mcp_servers.harmony-brain]\nurl = ${JSON.stringify(`${url}/api/brain/mcp`)}\n${tokenLine}\n`;
      } else {
        if (
          /^\s*\[mcp_servers\.["']?harmony-brain["']?\./m.test(original) ||
          /(?:http_headers|env_http_headers)\s*=/.test(original.match(section)?.[0] ?? '')
        ) {
          throw new Error(
            'Existing Brain MCP custom headers require manual migration to HARMONIE_TOKEN. No settings were changed.',
          );
        }
        config = config.replace(section, (block) => {
          const other = block.replace(/^[\t ]*(?:url|bearer_token_env_var)\s*=.*(?:\r?\n|$)/gm, '');
          return (
            other.trimEnd() + `\nurl = ${JSON.stringify(`${url}/api/brain/mcp`)}\n${tokenLine}\n`
          );
        });
      }
      planned.set(path, config);
    } else {
      // Claude's user MCP configuration lives beside the default settings
      // directory, or inside CLAUDE_CONFIG_DIR when that override is used.
      const path =
        resolve(claudeHome) === resolve(join(home, '.claude'))
          ? join(home, '.claude.json')
          : join(claudeHome, '.claude.json');
      const original = await readOptional(path);
      const config = parseSettings(original, path);
      config.mcpServers = object(config.mcpServers ?? {}, 'mcpServers');
      config.mcpServers['harmony-brain'] = {
        type: 'http',
        url: `${url}/api/brain/mcp`,
        headers: { Authorization: 'Bearer ${HARMONIE_TOKEN}' },
      };
      planned.set(path, serializeSettings(original, config, path));
    }
  }

  // Validate every input and construct the full plan before the first write.
  const changes = [];
  for (const [path, content] of planned) {
    const previous = await readOptional(path);
    if (previous !== content) changes.push({ path, content, previous });
  }
  const backups = [];
  if (apply) {
    for (const change of changes) {
      // Refuse to replace settings edited while the installation was prepared.
      if ((await readOptional(change.path)) !== change.previous) {
        throw new Error(`Settings changed during installation: ${change.path}. Rerun setup.`);
      }
      await mkdir(dirname(change.path), { recursive: true, mode: 0o700 });
      if (change.previous) {
        const backup = `${change.path}.bak.${Date.now()}.${randomUUID()}`;
        await copyFile(change.path, backup);
        backups.push(backup);
      }
      const temporary = `${change.path}.tmp.${randomUUID()}`;
      await writeFile(temporary, change.content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, change.path);
    }
  }
  return {
    applied: apply,
    url,
    clients,
    relayUrl,
    policyPath,
    projects: policy.projects,
    changedFiles: changes.map(({ path }) => path),
    backups,
    warnings,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        url: { type: 'string' },
        clients: { type: 'string' },
        team: { type: 'string' },
        'codex-client': { type: 'string' },
        project: { type: 'string', multiple: true },
        'relay-port': { type: 'string' },
        apply: { type: 'boolean', default: false },
      },
    });
    const result = await setup({
      url: values.url,
      clients: values.clients?.split(','),
      team: values.team,
      codexClient: values['codex-client'],
      projects: values.project,
      relayPort: values['relay-port'] === undefined ? undefined : Number(values['relay-port']),
      apply: values.apply,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log(
      result.applied
        ? 'Restart clients and review the installed Codex hooks with /hooks. Hooks start the relay automatically. Only selected repositories are forwarded; an empty list sends nothing.'
        : 'Preview only. Add --apply to install.',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
