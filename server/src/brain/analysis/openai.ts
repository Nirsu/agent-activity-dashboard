import { brainConfig } from '../config.js';
import { Agent } from 'undici';
import type { AgentRole, ModelResult } from './types.js';
import { fail, requireList, requireObject, requireText } from './validation.js';

type OpenAIOptions = {
  model: string;
  apiKey: string;
  requestTimeoutMs: number;
};

function tokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

export class OpenAIClient {
  // Disable transport response timers; the optional per-call signal owns the deadline.
  private readonly dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

  constructor(private readonly options: OpenAIOptions) {}

  async close() {
    await this.dispatcher.destroy();
  }

  private requestFailure(error: unknown): never {
    if (error instanceof Error && error.name === 'TimeoutError') {
      fail(
        `OpenAI request timed out after ${this.options.requestTimeoutMs / 1000} seconds. Adjust BRAIN_REQUEST_TIMEOUT_MS if needed. No demonstration fallback.`,
      );
    }
    fail(
      'OpenAI connection failed. Check network access and provider availability. No demonstration fallback.',
    );
  }

  private async rejectResponse(response: Response): Promise<never> {
    const detail = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; type?: unknown };
    } | null;
    const code = detail?.error?.code;

    // Use fixed messages: provider error text can contain account or credential details.
    if (response.status === 429) {
      if (code === 'credit_balance_exhausted') {
        fail(
          'OpenAI API credits are exhausted (HTTP 429). Add credits to the organization associated with this API key, then retry.',
        );
      }
      if (code === 'organization_spend_limit_exceeded' || code === 'project_spend_limit_exceeded') {
        fail(
          'OpenAI spending limit reached (HTTP 429). Review the organization and project spending limits before retrying.',
        );
      }
      if (code === 'insufficient_quota' || detail?.error?.type === 'insufficient_quota') {
        fail(
          'OpenAI API quota is insufficient (HTTP 429). Check API billing, available credits, and organization usage limits before retrying.',
        );
      }
      if (
        code === 'rate_limit_exceeded' ||
        code === 'slow_down' ||
        detail?.error?.type === 'rate_limit_error'
      ) {
        fail(
          'OpenAI rate limit reached (HTTP 429). Wait before retrying and check the project request and token limits.',
        );
      }
    }
    fail(`AI request rejected (HTTP ${response.status}). Check model access and quota.`);
  }

  async call(
    role: AgentRole,
    prompt: string,
    input: unknown,
    schema: Record<string, unknown>,
  ): Promise<ModelResult> {
    const signal = this.options.requestTimeoutMs
      ? AbortSignal.timeout(this.options.requestTimeoutMs)
      : undefined;

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        ...{ dispatcher: this.dispatcher },
        signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          store: false,
          instructions: prompt,
          input: JSON.stringify(input),
          max_output_tokens: brainConfig.analysis.maxOutputTokens,
          text: { format: { type: 'json_schema', name: role, strict: true, schema } },
        }),
      });
    } catch (error) {
      return this.requestFailure(signal?.aborted ? signal.reason : error);
    }

    if (!response.ok) {
      return this.rejectResponse(response);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        fail('OpenAI returned an invalid JSON response. No validated results.');
      }
      return this.requestFailure(signal?.aborted ? signal.reason : error);
    }

    const payload = requireObject(raw);
    const usage = requireObject(payload.usage);
    const tokens = {
      inputTokens: tokenCount(usage.input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      usageKnown:
        Number.isSafeInteger(usage.input_tokens) &&
        Number.isSafeInteger(usage.output_tokens) &&
        Number(usage.input_tokens) >= 0 &&
        Number(usage.output_tokens) >= 0,
      model: typeof payload.model === 'string' ? payload.model : this.options.model,
      responseId: typeof payload.id === 'string' ? payload.id : undefined,
      cachedInputTokens:
        usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
          ? tokenCount((usage.input_tokens_details as Record<string, unknown>).cached_tokens)
          : undefined,
      reasoningTokens:
        usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
          ? tokenCount((usage.output_tokens_details as Record<string, unknown>).reasoning_tokens)
          : undefined,
    };

    // Preserve reported consumption even when the answer cannot be used.
    if (payload.status !== 'completed') {
      return {
        ...tokens,
        value: null,
        error: 'OpenAI response is incomplete or refused. Retry with a smaller scope.',
      };
    }

    try {
      const messages = requireList(payload.output, brainConfig.analysis.maxResponseItems)
        .map(requireObject)
        .filter((message) => message.type === 'message');
      // Preliminary commentary can contain a separate JSON object. Only the final
      // answer is authoritative; concatenating both makes otherwise valid JSON invalid.
      const finalMessages = messages.filter((message) => message.phase === 'final_answer');
      const selected = finalMessages.length
        ? finalMessages
        : messages.filter((message) => message.phase == null);
      if (selected.length !== 1) {
        fail('OpenAI did not return one unambiguous final message.');
      }
      const content = requireList(selected[0].content, brainConfig.analysis.maxResponseItems);
      const output = content
        .map(requireObject)
        .filter((part) => part.type === 'output_text')
        .map((part) => requireText(part.text, brainConfig.analysis.maxResponseTextCharacters))
        .join('');

      return { ...tokens, value: JSON.parse(output) };
    } catch {
      return {
        ...tokens,
        value: null,
        error:
          'OpenAI response is refused or contains invalid structured output. No validated results.',
      };
    }
  }
}
