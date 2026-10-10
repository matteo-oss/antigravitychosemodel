import { getEffortForModel } from '../reasoning-effort.js';
/**
 * OpenCode Go adapter
 *
 * Endpoint-aware routing for the OpenCode Go gateway: the mapped MODEL is
 * never switched — instead the request goes to the endpoint that model
 * requires (see https://opencode.ai/docs/go/#endpoints):
 * - /chat/completions — OpenAI-compatible (default)
 * - /responses       — Responses API (grok, gpt-luna, muse-spark contributors)
 * - /messages        — Anthropic Messages API (minimax, qwen families)
 *
 * Always runs maximum reasoning effort on every path, and captures +
 * re-sends session_id for context cache discounts.
 */

import { OpenAICompatAdapter } from './openai.js';
import { randomUUID } from 'crypto';
import { getGoEndpoint } from '../opencode-endpoints.js';
import { GatewayMessagesAdapter } from './gateway-messages.js';
import { GatewayResponsesAdapter } from './gateway-responses.js';
import type { OpenAIMessage } from '../mapper.js';
import type { StreamChunk } from './types.js';

const THINKING_ERROR_PATTERNS = [/\[1210\]/, /always engages in thinking/i, /cannot be disabled/i];

// Effort values accepted by thinking-mandated Go models (per gateway error text).
const VALID_THINKING_EFFORTS = new Set(['low', 'high', 'max']);

/** True when the gateway rejected the request because the model mandates thinking. */
export function isThinkingRequiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return THINKING_ERROR_PATTERNS.some((r) => r.test(msg));
}

/**
 * Run a Go request, transparently retrying ONCE with reasoning_effort=low
 * when the gateway reports the model mandates thinking ([1210]). Safety net
 * for non-max configurations; normally max effort is already sent.
 * Never retries after data was already yielded (avoids duplicating content).
 */
export async function* streamWithThinkingRetry(
  config: Record<string, unknown> | undefined,
  run: (cfg: Record<string, unknown> | undefined) => AsyncGenerator<StreamChunk>,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let yielded = false;
  try {
    for await (const chunk of run(config)) {
      yielded = true;
      yield chunk;
    }
    return;
  } catch (err) {
    if (signal?.aborted || yielded || !isThinkingRequiredError(err)) throw err;
    const current = (config as any)?.providerOptions?.openai?.reasoningEffort;
    if (VALID_THINKING_EFFORTS.has(String(current))) throw err;
    const retryConfig: Record<string, unknown> = {
      ...(config || {}),
      providerOptions: {
        ...((config as any)?.providerOptions || {}),
        openai: { ...((config as any)?.providerOptions?.openai || {}), reasoningEffort: 'low' },
      },
    };
    for await (const chunk of run(retryConfig)) {
      yield chunk;
    }
  }
}

/** Which gateway protocol handles this Go model. Pure — unit-tested. */
export function selectGoHandler(model: string): 'chat' | 'responses' | 'messages' {
  const endpoint = getGoEndpoint(model);
  if (endpoint === 'responses') return 'responses';
  if (endpoint === 'messages') return 'messages';
  return 'chat';
}

export class OpencodeGoAdapter extends OpenAICompatAdapter {
  constructor(provider: string, baseUrl: string, apiKey: string) {
    super(provider, baseUrl, apiKey);
  }

  /**
   * OpenCode Go requires a stable `x-opencode-session` header per
   * conversation for routing and prompt caching (see
   * https://opencode.ai/docs/go/#where-can-i-use-it). Requests without it
   * are rejected with `MissingSessionID`. The session id is threaded through
   * `config.providerOptions.sessionId` by index.ts (stable per convId);
   * if absent we generate a one-off UUID so the request is still routable.
   * A distinct User-Agent (not a generic SDK name) is also required.
   */
  protected buildHeaders(config?: Record<string, unknown>): Record<string, string> {
    const sessionId = (config as any)?.providerOptions?.sessionId || randomUUID();
    return {
      ...super.buildHeaders(config),
      'x-opencode-session': String(sessionId),
      'User-Agent': 'antigravity-add-model-gateway/1.0.0',
    };
  }

  async *stream(
    model: string,
    messages: OpenAIMessage[],
    tools?: Record<string, unknown>,
    config?: Record<string, unknown>,
    signal?: AbortSignal,
    system?: string,
  ): AsyncGenerator<StreamChunk> {
    // Same model, applicable endpoint: only the URL path switches.
    // Sub-adapters are built per call so hot-reloaded keys always apply.
    const handler = selectGoHandler(model);
    if (handler === 'responses') {
      const adapter = new GatewayResponsesAdapter(this.baseUrl, this.apiKey, this.provider);
      yield* adapter.stream(model, messages, tools, config, signal, system);
      return;
    }
    if (handler === 'messages') {
      const adapter = new GatewayMessagesAdapter(this.baseUrl, this.apiKey, this.provider);
      yield* adapter.stream(model, messages, tools, config, signal, system);
      return;
    }
    yield* streamWithThinkingRetry(
      config,
      (cfg) => super.stream(model, messages, tools, cfg, signal, system),
      signal,
    );
  }

  protected buildRequest(
    model: string,
    messages: OpenAIMessage[],
    tools?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: this.serializeMessages(messages),
      stream: true,
    };

    // Inject session_id for context cache discounts on follow-up requests
    const sessionId = (config as any)?.providerOptions?.sessionId;
    if (sessionId) {
      body.session_id = sessionId;
    }

    if (tools && Object.keys(tools).length > 0) {
      body.tools = Object.entries(tools).map(([name, tool]: [string, any]) => ({
        type: 'function',
        function: { name, description: tool.description || '', parameters: tool.parameters || {} },
      }));
    }
    if (config?.maxTokens) body.max_tokens = config.maxTokens;
    if (config?.temperature != null) body.temperature = config.temperature;
    if (config?.topP != null) body.top_p = config.topP;
    if ((config as any)?.stopSequences?.length) body.stop = (config as any).stopSequences;

    // Always maximum reasoning effort, regardless of per-model config.
    const effort = (config as any)?.providerOptions?.openai?.reasoningEffort || getEffortForModel(model);
    if (effort && effort !== 'default') body.reasoning_effort = effort;

    return body;
  }
}
