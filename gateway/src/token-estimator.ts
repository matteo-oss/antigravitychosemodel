import type { OpenAIMessage } from './mapper.js';

const CHARS_PER_TOKEN = 4;
const ROLE_OVERHEAD_TOKENS = 4; // Approximate tokens for role/formatting per message

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateSystemTokens(system: string): number {
  if (!system) return 0;
  return estimateTokens(system);
}

export function estimateMessageTokens(messages: OpenAIMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += ROLE_OVERHEAD_TOKENS;
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'string') {
          total += estimateTokens(part);
        } else if (part && typeof part === 'object') {
          total += estimateTokens(JSON.stringify(part));
        }
      }
    }
    // Estimate reasoning_content if present (used by o1/o3 models)
    if (msg.reasoning_content) {
      total += estimateTokens(msg.reasoning_content);
    }
    // Estimate tool_calls if present (assistant messages with tool calls)
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(JSON.stringify(tc));
      }
    }
  }
  return total;
}

export function estimateToolTokens(tools?: Record<string, unknown>): number {
  if (!tools) return 0;
  return estimateTokens(JSON.stringify(tools));
}
