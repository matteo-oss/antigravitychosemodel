import { getEffortForModel } from '../reasoning-effort.js';
/**
 * Zen (OpenCode) adapter
 *
 * Endpoint-aware routing for the OpenCode Zen gateway: the mapped MODEL is
 * never switched — instead the request goes to the endpoint that model
 * requires (see https://opencode.ai/docs/zen/#endpoints):
 * - /chat/completions — OpenAI-compatible (default)
 * - /responses       — Responses API (GPT, Grok, Muse Spark)
 * - /messages        — Anthropic Messages API (Claude, Qwen)
 * Zen Google-native model endpoints (/v1/models/<id>) are not supported and
 * fail fast with an actionable error.
 *
 * Always runs maximum reasoning effort on every path.
 */

import { OpenAICompatAdapter } from './openai.js';
import { randomUUID } from 'crypto';
import { getZenEndpoint, endpointError, type GatewayEndpoint } from '../opencode-endpoints.js';
import { GatewayMessagesAdapter } from './gateway-messages.js';
import { GatewayResponsesAdapter } from './gateway-responses.js';
import type { OpenAIMessage } from '../mapper.js';
import type { StreamChunk } from './types.js';

/** Which gateway protocol handles this Zen model. Pure — unit-tested. */
export function selectZenHandler(model: string): 'chat' | 'responses' | 'messages' | 'google-native' {
  const endpoint: GatewayEndpoint = getZenEndpoint(model);
  if (endpoint === 'responses') return 'responses';
  if (endpoint === 'messages') return 'messages';
  if (endpoint === 'google-native') return 'google-native';
  return 'chat';
}

export class ZenAdapter extends OpenAICompatAdapter {
  constructor(provider: string, baseUrl: string, apiKey: string) {
    super(provider, baseUrl, apiKey);
  }

  /**
   * Zen is an OpenCode gateway like Go: send a stable `x-opencode-session`
   * header per conversation (the gateway answers `MissingSessionID` without
   * it — including the "free tier can only be used in OpenCode" variant)
   * plus a distinct User-Agent. Session id flows via
   * `config.providerOptions.sessionId`; fall back to a generated UUID so the
   * header is never absent.
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
    const handler = selectZenHandler(model);
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
    if (handler === 'google-native') {
      throw endpointError('zen', model, `models/${model}`);
    }
    yield* super.stream(model, messages, tools, config, signal, system);
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
    // The Zen gateway forwards reasoning_effort to the underlying model.
    const effort = (config as any)?.providerOptions?.openai?.reasoningEffort || getEffortForModel(model);
    if (effort && effort !== 'default') body.reasoning_effort = effort;

    return body;
  }
}
