/**
 * Unit tests for gateway protocol handlers (Responses API + Anthropic
 * Messages over Go/Zen base URLs) and Zen endpoint classification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResponsesRequest,
  handleResponsesEvent,
  responsesObjectToChunks,
  toResponsesInput,
} from '../src/adapters/gateway-responses.js';
import { GatewayMessagesAdapter } from '../src/adapters/gateway-messages.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { getZenEndpoint } from '../src/opencode-endpoints.js';
import { selectZenHandler } from '../src/adapters/zen.js';
import { selectGoHandler } from '../src/adapters/opencode-go.js';

// ─── Responses request building ─────────────────────────────────────────

test('R1: buildResponsesRequest maps model/input/tools/reasoning', () => {
  const body = buildResponsesRequest(
    'muse-spark-1.3-contributor',
    [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ],
    { run_command: { description: 'Run', parameters: { type: 'object' } } },
    { maxTokens: 500, providerOptions: { openai: { reasoningEffort: 'high' } } },
    'be helpful',
  ) as any;
  assert.equal(body.model, 'muse-spark-1.3-contributor');
  assert.equal(body.stream, true);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.instructions, 'be helpful');
  assert.equal(body.max_output_tokens, 500);
  assert.equal(body.temperature, undefined, 'temperature must be omitted for reasoning models');
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].name, 'run_command');
  const types = body.input.map((i: any) => i.type);
  assert.deepEqual(types, ['message', 'function_call', 'function_call_output']);
  assert.equal(body.input[2].call_id, 'c1');
});

test('R2: toResponsesInput folds history system messages into instructions', () => {
  const { input, instructions } = toResponsesInput(
    [
      { role: 'system', content: 'sys-a' },
      { role: 'user', content: 'hi' },
    ],
    'sys-b',
  );
  assert.equal(instructions, 'sys-b\nsys-a');
  assert.equal(input.length, 1);
  assert.equal(input[0].role, 'user');
});

// ─── Responses event handling ───────────────────────────────────────────

test('R3: handleResponsesEvent maps deltas and tool calls', () => {
  assert.deepEqual(
    handleResponsesEvent({ type: 'response.output_text.delta', delta: 'hello' }),
    [{ type: 'text', content: 'hello' }],
  );
  assert.deepEqual(
    handleResponsesEvent({ type: 'response.reasoning_summary_text.delta', delta: 'thinking…' }),
    [{ type: 'thought', content: 'thinking…' }],
  );
  assert.deepEqual(handleResponsesEvent({ type: 'response.created' }), []);
  assert.deepEqual(handleResponsesEvent(null), []);
  const tool = handleResponsesEvent({
    type: 'response.output_item.done',
    item: { type: 'function_call', name: 'run_command', arguments: '{"CommandLine":"ls"}' },
  });
  assert.equal(tool.length, 1);
  assert.equal(tool[0].type, 'tool-call');
  assert.equal(tool[0].name, 'run_command');
  assert.deepEqual(tool[0].args, { CommandLine: 'ls' });
});

test('R4: handleResponsesEvent throws on terminal errors', () => {
  assert.throws(
    () => handleResponsesEvent({ type: 'response.failed', response: { error: { message: 'boom' } } }),
    /boom/,
  );
  assert.throws(() => handleResponsesEvent({ type: 'error', message: 'bad' }), /bad/);
});

test('R5: responsesObjectToChunks walks non-streaming output', () => {
  const chunks = responsesObjectToChunks({
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      { type: 'function_call', name: 'x', arguments: '{}' },
      { type: 'reasoning', summary: [] },
    ],
  });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].type, 'text');
  assert.equal(chunks[1].type, 'tool-call');
});

// ─── Gateway messages adapter ───────────────────────────────────────────

test('M1: GatewayMessagesAdapter sends gateway headers (Bearer + session + UA)', () => {
  const adapter = new GatewayMessagesAdapter('https://opencode.ai/zen/go/v1', 'sek', 'opencode-go');
  const headers = (adapter as any).buildHeaders({ providerOptions: { sessionId: 's-1' } });
  assert.equal(headers['Authorization'], 'Bearer sek');
  assert.equal(headers['x-opencode-session'], 's-1');
  assert.match(String(headers['User-Agent']), /antigravity/i);
  assert.equal(headers['x-api-key'], undefined);
});

test('M2: GatewayMessagesAdapter enables requested thinking and strips temp', () => {
  const adapter = new GatewayMessagesAdapter('https://opencode.ai/zen/go/v1', 'sek', 'opencode-go');
  const body = (adapter as any).buildRequest(
    'minimax-m3',
    [{ role: 'user', content: 'hi' }],
    undefined,
    { maxTokens: 4096, temperature: 0.7, topP: 0.9, providerOptions: { openai: { reasoningEffort: 'high' } } },
  );
  assert.equal(body.thinking?.type, 'enabled');
  assert.ok(body.thinking.budget_tokens >= 1024 && body.thinking.budget_tokens < 4096);
  assert.equal(body.temperature, undefined, 'temp conflicts with thinking');
  assert.equal(body.top_p, undefined, 'top_p conflicts with thinking');
});

test('M3: AnthropicAdapter unchanged — no thinking without effort, temp kept', () => {
  const adapter = new AnthropicAdapter('https://api.anthropic.com/v1', 'k');
  const plain = (adapter as any).buildRequest('claude-x', [{ role: 'user', content: 'hi' }], undefined, { temperature: 0.5 });
  assert.equal(plain.thinking, undefined);
  assert.equal(plain.temperature, 0.5);
  const effort = (adapter as any).buildRequest('claude-x', [{ role: 'user', content: 'hi' }], undefined, { providerOptions: { openai: { reasoningEffort: 'high' } } });
  assert.equal(effort.thinking?.type, 'enabled');
  assert.equal(effort.temperature, undefined);
});

// ─── Zen endpoint classification ────────────────────────────────────────

test('Z1: getZenEndpoint classifies Zen models per docs', () => {
  for (const m of ['gpt-5.6-luna', 'grok-4.6', 'muse-spark-1.3']) assert.equal(getZenEndpoint(m), 'responses', m);
  for (const m of ['claude-sonnet-4-6', 'claude-opus-4-5', 'qwen3.7-max']) assert.equal(getZenEndpoint(m), 'messages', m);
  for (const m of ['gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3-flash']) assert.equal(getZenEndpoint(m), 'google-native', m);
  for (const m of ['mimo-v2.5-free', 'big-pickle', 'deepseek-v4-flash', 'some-future-model']) {
    assert.equal(getZenEndpoint(m), 'unknown', `${m} falls through to chat`);
  }
});

test('Z2: handler selection never switches the model, only the protocol', () => {
  assert.equal(selectZenHandler('mimo-v2.5-free'), 'chat');
  assert.equal(selectZenHandler('claude-haiku-4-5'), 'messages');
  assert.equal(selectZenHandler('gpt-5-nano'), 'responses');
  assert.equal(selectZenHandler('gemini-3.1-pro'), 'google-native');
  assert.equal(selectGoHandler('muse-spark-1.3-contributor'), 'responses');
  assert.equal(selectGoHandler('qwen3.6-plus'), 'messages');
  assert.equal(selectGoHandler('omen-alpha'), 'chat');
});
