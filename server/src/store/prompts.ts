import type { AgentEvent, AgentProvider } from '../types.js';

// Claude hooks do not always supply the native prompt ID. Pair one hook with
// one native observation using event time, never export/arrival time.
export const PROMPT_PAIR_WINDOW_MS = 5_000;
export const PROMPT_WINDOW_MS = 3_600_000;

interface Prompt {
  provider: AgentProvider;
  ts: number;
  promptId?: string;
  hookId?: string;
  logId?: string;
}

export interface PromptMatch {
  isNew: boolean;
  prompt: Prompt;
}

export class PromptTracker {
  private sessions = new Map<string, Prompt[]>();

  record(event: AgentEvent): PromptMatch | undefined {
    const source =
      event.kind === 'user_prompt'
        ? 'logId'
        : event.kind === 'activity' && event.subtype === 'prompt_submit'
          ? 'hookId'
          : undefined;
    if (!source) {
      return undefined;
    }
    const key = JSON.stringify([event.provider, event.sessionId ?? event.id]);
    const prompts = this.sessions.get(key) ?? [];
    let match = prompts.find(
      (prompt) =>
        prompt[source] === event.id ||
        (event.promptId !== undefined && event.promptId === prompt.promptId),
    );
    if (!match && event.sessionId) {
      match = prompts
        .filter(
          (prompt) =>
            !prompt[source] &&
            (!prompt.promptId || !event.promptId) &&
            Math.abs(prompt.ts - event.ts) <= PROMPT_PAIR_WINDOW_MS,
        )
        .sort((left, right) => Math.abs(left.ts - event.ts) - Math.abs(right.ts - event.ts))[0];
    }
    if (match) {
      match[source] = event.id;
      match.promptId ??= event.promptId;
      match.ts = Math.min(match.ts, event.ts);
      return { isNew: false, prompt: match };
    }
    const prompt: Prompt = {
      provider: event.provider,
      ts: event.ts,
      promptId: event.promptId,
      [source]: event.id,
    };
    prompts.push(prompt);
    this.sessions.set(key, prompts);
    return { isNew: true, prompt };
  }

  prune(before: number): void {
    for (const [session, prompts] of this.sessions) {
      const retained = prompts.filter((prompt) => prompt.ts >= before);
      if (retained.length) {
        this.sessions.set(session, retained);
      } else {
        this.sessions.delete(session);
      }
    }
  }

  values(): Prompt[] {
    return [...this.sessions.values()].flat();
  }

  count(since: number, provider?: AgentProvider): number {
    return this.values().filter(
      (prompt) => prompt.ts >= since && (!provider || prompt.provider === provider),
    ).length;
  }
}
