import { logger } from '../logger.js';
import type { OpenAIMessage } from '../mapper.js';
import type { StreamChunk, ModelAdapter } from './types.js';
import { poolFetch } from '../http-pool.js';
import { parseToolArgs } from '../utils/parse-tool-args.js';

export class AnthropicAdapter implements ModelAdapter {
  provider = 'anthropic';
  protected baseUrl: string;
  protected apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  /** Endpoint path — '/messages' for Anthropic and compatible gateways. */
  protected endpointPath(): string {
    return '/messages';
  }

  /** Request headers. Overridden by gateway adapters (Bearer + session). */
  protected buildHeaders(_config?: Record<string, unknown>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  /**
   * Thinking budget for `thinking: { type: 'enabled', budget_tokens }`.
   * Returns null when thinking should be off. Overridden by gateway adapters
   * that always run maximum thinking.
   */
  protected thinkingBudget(maxTokens: number, config?: Record<string, unknown>): number | null {
    const providerOptions = (config as any)?.providerOptions;
    const reasoningEffort: string | undefined = providerOptions?.openai?.reasoningEffort;
    if (!reasoningEffort) return null;
    if (maxTokens <= 1024) throw new Error('Thinking requires maxOutputTokens greater than 1024');
    // Approximate budget_tokens by effort level. Anthropic requires
    // budget_tokens >= 1024, and <= max_tokens.
    const budgetByLevel: Record<string, number> = {
      low: Math.min(2048, maxTokens - 1),
      medium: Math.min(8192, maxTokens - 1),
      high: Math.min(16384, maxTokens - 1),
    };
    const budget = budgetByLevel[reasoningEffort] ?? Math.min(8192, maxTokens - 1);
    // Ensure we respect Anthropic's minimum (1024) and stay below max_tokens.
    return Math.max(1024, budget);
  }

  async *stream(
    model: string,
    messages: OpenAIMessage[],
    tools?: Record<string, unknown>,
    config?: Record<string, unknown>,
    signal?: AbortSignal,
    system?: string,
  ): AsyncGenerator<StreamChunk> {
    // If system instruction provided and no system message exists, prepend it
    const finalMessages = system && !messages.some(m => m.role === 'system')
      ? [{ role: 'system' as const, content: system }, ...messages]
      : messages;
    const body = this.buildRequest(model, finalMessages, tools, config);
    const response = await this.fetchResponse(body, signal, config);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isThinking = false;
    // B10: track per-block state in a Map keyed by event.index so that
    // multiple parallel tool_use blocks in the same response don't overwrite
    // each other. Anthropic's SSE protocol assigns a unique `index` to each
    // content_block_start/delta/stop triplet.
    const toolBlocks = new Map<number, { name: string; args: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) continue;
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') { yield { type: 'done' }; return; }
          let event: any;
          try { event = JSON.parse(data); } catch { continue; }

          if (event.type === 'content_block_start') {
            if (event.content_block?.type === 'thinking') {
              isThinking = true;
              if (event.content_block.thinking) {
                yield { type: 'thought', content: event.content_block.thinking };
              }
            }
            if (event.content_block?.type === 'tool_use' && typeof event.index === 'number') {
              toolBlocks.set(event.index, {
                name: event.content_block.name || '',
                args: '',
              });
            }
          }
          if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'thinking' && event.delta.thinking) {
              yield { type: 'thought', content: event.delta.thinking };
            }
            if (event.delta?.text) {
              yield { type: 'text', content: event.delta.text };
            }
            if (event.delta?.partial_json && typeof event.index === 'number') {
              const block = toolBlocks.get(event.index);
              if (block) block.args += event.delta.partial_json;
            }
          }
          if (event.type === 'content_block_stop') {
            if (isThinking) {
              isThinking = false;
            }
            if (typeof event.index === 'number') {
              const block = toolBlocks.get(event.index);
              if (block) {
                yield { type: 'tool-call', name: block.name, args: this.parseToolArgs(block.args) };
                toolBlocks.delete(event.index);
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  protected buildRequest(
    model: string,
    messages: OpenAIMessage[],
    tools?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Record<string, unknown> {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const maxTokens = (config?.maxTokens as number) || 4096;
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: this.convertMessages(nonSystemMessages),
    };
    if (systemMessages.length > 0) {
      body.system = systemMessages.map(m => m.content).join('\n');
    }
    if (tools && Object.keys(tools).length > 0) {
      (body as any).tools = Object.entries(tools).map(([name, tool]: [string, any]) => ({
        name,
        description: tool.description || '',
        input_schema: tool.parameters || { type: 'object', properties: {} },
      }));
    }

    // A3: translate OpenAI-style `reasoningEffort` to Anthropic's `thinking`.
    // Antigravity sets providerOptions.openai.reasoningEffort = 'low'|'medium'|'high'
    // when the user wants visible chain-of-thought. Anthropic uses a different
    // shape: `thinking: { type: 'enabled', budget_tokens: N }`.
    const budget = this.thinkingBudget(maxTokens, config);
    if (budget != null) {
      (body as any).thinking = { type: 'enabled', budget_tokens: budget };
    } else {
      // Anthropic rejects temperature/top_p alongside thinking — only send
      // them for non-reasoning requests.
      if (config?.temperature != null) body.temperature = config.temperature;
      if (config?.topP != null) body.top_p = config.topP;
    }
    if ((config as any)?.stopSequences?.length) body.stop_sequences = (config as any).stopSequences;

    return body;
  }

  protected convertMessages(messages: OpenAIMessage[]): any[] {
    const result: any[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        result.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: typeof m.content === 'string' ? m.content : '' }],
        });
      } else if (m.tool_calls && m.tool_calls.length > 0) {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: typeof m.content === 'string' ? m.content : '' });
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: this.parseToolArgs(tc.function.arguments),
          });
        }
        result.push({ role: 'assistant', content });
      } else {
        if (Array.isArray(m.content)) {
          const blocks: any[] = [];
          for (const p of m.content) {
            if (p.type === 'image_url' && p.image_url?.url) {
              const url = p.image_url.url;
              const m2 = url.match(/^data:([^;]+);base64,(.+)$/);
              if (m2) {
                blocks.push({ type: 'image', source: { type: 'base64', media_type: m2[1], data: m2[2] } });
              } else if (/^(https?:|file:)/i.test(url)) {
                blocks.push({ type: 'image', source: { type: 'url', url } });
              }
            } else if (p.type === 'text' && p.text) {
              blocks.push({ type: 'text', text: p.text });
            } else if (typeof p === 'string') {
              blocks.push({ type: 'text', text: p });
            }
          }
          if (blocks.length > 0) { result.push({ role: m.role as string, content: blocks }); continue; }
        }
        result.push({ role: m.role as string, content: typeof m.content === 'string' ? m.content : '' });
      }
    }
    return result;
  }

  protected async fetchResponse(body: Record<string, unknown>, signal?: AbortSignal, config?: Record<string, unknown>): Promise<Response> {
    const response = await poolFetch(`${this.baseUrl}${this.endpointPath()}`, {
      method: 'POST',
      headers: this.buildHeaders(config),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      logger.debug(`[${this.provider}] rejected body`, {
        body: JSON.stringify(body).substring(0, 4000),
      });
      throw new Error(`[${this.provider}] API error ${response.status}: ${err}`);
    }
    return response;
  }

  private parseToolArgs(raw: string): Record<string, unknown> {
    return parseToolArgs(raw);
  }
}
