import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessageTokens, estimateSystemTokens, estimateToolTokens } from '../src/token-estimator.js';
import type { OpenAIMessage } from '../src/mapper.js';

describe('TokenEstimator', () => {
  it('estimates tokens as length/4', () => {
    assert.equal(estimateTokens('hello'), 2); // 5 chars / 4 = 1.25 → ceil = 2
    assert.equal(estimateTokens('1234'), 1);  // 4 chars / 4 = 1
    assert.equal(estimateTokens('12345'), 2); // 5 chars / 4 = 1.25 → ceil = 2
  });

  it('returns 0 for empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('estimates system prompt tokens', () => {
    const system = 'You are a helpful assistant. '.repeat(100);
    const tokens = estimateSystemTokens(system);
    assert.equal(tokens, Math.ceil(system.length / 4));
  });

  it('estimates system tokens as 0 for empty string', () => {
    assert.equal(estimateSystemTokens(''), 0);
    assert.equal(estimateSystemTokens(undefined as any), 0);
  });

  it('estimates message tokens including role overhead', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const tokens = estimateMessageTokens(messages);
    // 2 messages × 4 role overhead + estimateTokens('hello') + estimateTokens('world')
    assert.equal(tokens, 8 + 2 + 2);
  });

  it('estimates reasoning_content in messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', content: 'response', reasoning_content: 'thinking process' },
    ];
    const tokens = estimateMessageTokens(messages);
    // 4 role + estimateTokens('response') + estimateTokens('thinking process')
    assert.equal(tokens, 4 + 2 + 4);
  });

  it('estimates tool_calls in messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
    ];
    const tokens = estimateMessageTokens(messages);
    // 4 role + estimateTokens(JSON.stringify(tool_calls))
    assert.ok(tokens > 4); // At least role overhead + tool call payload
  });

  it('handles null content in messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'assistant', content: null },
    ];
    const tokens = estimateMessageTokens(messages);
    assert.equal(tokens, 4); // Just role overhead
  });

  it('handles array content parts', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'http://example.com/img.png' } }] },
    ];
    const tokens = estimateMessageTokens(messages);
    // 4 role + estimateTokens(JSON.stringify(text part)) + estimateTokens(JSON.stringify(image part))
    assert.ok(tokens > 4);
  });

  it('estimates tool tokens', () => {
    const tools = {
      view_file: { description: 'View file contents', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    };
    const tokens = estimateToolTokens(tools);
    assert.equal(tokens, estimateTokens(JSON.stringify(tools)));
  });

  it('returns 0 for undefined tools', () => {
    assert.equal(estimateToolTokens(undefined), 0);
  });
});
