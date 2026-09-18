import type { SessionRole } from './types.js';

// Only explicit source metadata establishes internal work or a parent link.
// Never infer relationships from a shared account, timestamps or token counts.
export function sourceMetadata(source: unknown): {
  sessionRole?: SessionRole;
  parentSessionId?: string;
  agentType?: string;
} {
  if (typeof source === 'string') {
    if (source.startsWith('{')) {
      try {
        return sourceMetadata(JSON.parse(source));
      } catch {
        return {};
      }
    }
    const name = source.toLowerCase();
    if (
      [
        'guardian',
        'internal',
        'internal_guardian',
        'memory_consolidation',
        'internal_memory_consolidation',
        'subagent_compact',
        'subagent_review',
      ].includes(name)
    ) {
      return {
        sessionRole: 'internal',
        agentType: name.includes('guardian') ? 'Approval check' : 'Internal task',
      };
    }
    if (name === 'subagent' || name.startsWith('subagent_')) return { sessionRole: 'subagent' };
    if (
      ['cli', 'tui', 'exec', 'vscode', 'desktop', 'app', 'app-server', 'appserver', 'mcp'].includes(
        name,
      )
    )
      return { sessionRole: 'main' };
    return {};
  }
  if (!source || typeof source !== 'object') return {};
  const value = source as Record<string, any>;
  if (value.internal)
    return {
      sessionRole: 'internal',
      agentType: value.internal === 'guardian' ? 'Approval check' : 'Internal task',
    };
  if (value.subagent) {
    const spawn = value.subagent.thread_spawn;
    const internal =
      ['compact', 'memory_consolidation'].includes(value.subagent) ||
      value.subagent.other === 'guardian';
    return {
      sessionRole: internal ? 'internal' : 'subagent',
      parentSessionId: safeId(spawn?.parent_thread_id),
      agentType:
        value.subagent.other === 'guardian' ? 'Approval check' : safeLabel(spawn?.agent_role),
    };
  }
  return {};
}

export function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) ? value : undefined;
}

export function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.replace(/[^a-zA-Z0-9 _.:/-]/g, '').slice(0, 80) || undefined
    : undefined;
}
