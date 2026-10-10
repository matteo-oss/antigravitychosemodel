import { getEffortForModel } from '../reasoning-effort.js';
/**
 * OpenAI Responses API over an OpenCode gateway base URL (Go /responses,
 * Zen /responses). Used for models the gateways do NOT serve over
 * chat/completions (e.g. grok-4.6, gpt-5.6-luna, muse-spark contributors).
 * Always runs maximum reasoning effort (`reasoning.effort: 'high'` — the
 * highest Responses-API value with broad support).
 */

import { randomUUID } from 'crypto';
import type { OpenAIMessage } from '../mapper.js';
import type { StreamChunk, ModelAdapter } from './types.js';
import { poolFetch } from '../http-pool.js';
import { logger } from '../logger.js';
import { parseToolArgs } from '../utils/parse-tool-args.js';

/** Convert OpenAI-style messages to Responses `input` items. */
export function toResponsesInput(messages: OpenAIMessage[], system?: string): { input: any[]; instructions?: string } {
  const systemTexts: string[] = [];
  if (system) systemTexts.push(system);
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) systemTexts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      if (m.content) {
        input.push({ type: 'message', role: 'assistant', content: contentToString(m.content) });
      }
      for (const tc of m.tool_calls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      continue;
    }
    input.push({ type: 'message', role: m.role, content: toInputContent(m.content) });
  }
  return { input, instructions: systemTexts.length > 0 ? systemTexts.join('\n') : undefined };
}

function contentToString(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : p.text || '')).join('');
  }
  return '';
}

function toInputContent(content: OpenAIMessage['content']): any {
  if (typeof content === 'string' || content == null) return content ?? '';
  if (!Array.isArray(content)) return '';
  const blocks: any[] = [];
  for (const p of content as any[]) {
    if (typeof p === 'string') {
      blocks.push({ type: 'input_text', text: p });
    } else if (p.type === 'text' && p.text) {
      blocks.push({ type: 'input_text', text: p.text });
    } else if (p.type === 'image_url' && p.image_url?.url) {
      blocks.push({ type: 'input_image', image_url: p.image_url.url });
    }
  }
  return blocks.length > 0 ? blocks : '';
}

export function buildResponsesRequest(
  model: string,
  messages: OpenAIMessage[],
  tools?: Record<string, unknown>,
  config?: Record<string, unknown>,
  system?: string,
): Record<string, unknown> {
  const { input, instructions } = toResponsesInput(messages, system);
  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    // Maximum reasoning effort. 'high' is the highest Responses-API value
    // with broad model support. Temperature/top_p are deliberately omitted:
    // reasoning models restrict them.

  };
  const effort = (config as any)?.providerOptions?.openai?.reasoningEffort || getEffortForModel(model);
  if (effort && effort !== 'default') body.reasoning = { effort: effort === 'max' ? 'high' : effort };
  if (instructions) body.instructions = instructions;
  if (tools && Object.keys(tools).length > 0) {
    body.tools = Object.entries(tools).map(([name, tool]: [string, any]) => ({
      type: 'function',
      name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    }));
  }
  if (config?.maxTokens) body.max_output_tokens = config.maxTokens;
  return body;
}

/**
 * Handle one parsed Responses SSE event. Returns the chunks it produces
 * (possibly empty). Throws on terminal error events.
 */
export function handleResponsesEvent(event: any): StreamChunk[] {
  if (!event || typeof event.type !== 'string') return [];
  switch (event.type) {
    case 'response.output_text.delta':
      return event.delta ? [{ type: 'text', content: event.delta }] : [];
    case 'response.reasoning_summary_text.delta':
      return event.delta ? [{ type: 'thought', content: event.delta }] : [];
    case 'response.output_item.done': {
      const item = event.item;
      if (item?.type === 'function_call') {
        let args: Record<string, unknown> = {};
        try {
          args = parseToolArgs(item.arguments || '{}');
        } catch { /* keep empty */ }
        return [{ type: 'tool-call', name: item.name || 'unknown', args }];
      }
      return [];
    }
    case 'response.failed': {
      const msg = event.response?.error?.message || 'response failed';
      throw new Error(msg);
    }
    case 'error':
      throw new Error(event.message || event.error || 'responses error');
    default:
      return [];
  }
}

/** Extract chunks from a complete (non-streaming) Responses object. */
export function responsesObjectToChunks(data: any): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const item of data?.output || []) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if ((part.type === 'output_text') && part.text) chunks.push({ type: 'text', content: part.text });
      }
    } else if (item?.type === 'function_call') {
      let args: Record<string, unknown> = {};
      try {
        args = parseToolArgs(item.arguments || '{}');
      } catch { /* keep empty */ }
      chunks.push({ type: 'tool-call', name: item.name || 'unknown', args });
    }
  }
  return chunks;
}

export class GatewayResponsesAdapter implements ModelAdapter {
  provider: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string, gatewayProvider: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.provider = gatewayProvider;
  }

  private buildHeaders(config?: Record<string, unknown>): Record<string, string> {
    const sessionId = (config as any)?.providerOptions?.sessionId || randomUUID();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
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
    const body = buildResponsesRequest(model, messages, tools, config, system);
    const response = await poolFetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: this.buildHeaders(config),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      logger.debug(`[${this.provider}] rejected body for ${model}`, {
        body: JSON.stringify(body).substring(0, 4000),
      });
      throw new Error(`[${this.provider}] API error ${response.status}: ${err}`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/event-stream')) {
      const data = await response.json() as any;
      for (const chunk of responsesObjectToChunks(data)) yield chunk;
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') return;
          let event: any;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.type === 'response.completed' || event.type === 'response.incomplete') return;
          for (const chunk of handleResponsesEvent(event)) yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
