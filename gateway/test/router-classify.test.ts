/**
 * Unit tests for router error classification and Go thinking auto-retry.
 *
 * Root causes (from proxy session logs):
 * - Deterministic gateway errors (400 [1210], 401 CreditsError/ModelError,
 *   404, 410 Gone) were retried 4x with backoff before failover — burning
 *   latency, quota, and money on attempts that could never succeed.
 * - Thinking-mandated Go models ([1210]) needed per-model config to work.
 * - Terminal errors could surface as "All providers failed: unknown" because
 *   failover break-paths never recorded lastError.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, isAccountFailure } from '../src/router.js';
import { isThinkingRequiredError, streamWithThinkingRetry } from '../src/adapters/opencode-go.js';
import type { StreamChunk } from '../src/adapters/types.js';

// ─── classifyProviderError ─────────────────────────────────────────────

test('C1: deterministic failures fail over without retry', () => {
  const cases = [
    '[opencode-go] API error 400: {"error":{"type":"server_error","message":"Upstream request failed: [1210] cannot be disabled"}}',
    '[zen] API error 401: {"type":"error","error":{"type":"ModelError","message":"Model X is not supported"}}',
    '[opencode-go] API error 401: {"type":"error","error":{"type":"CreditsError","message":"Insufficient balance"}}',
    '[opencode-go] API error 400: {"type":"error","error":{"type":"MissingSessionID","message":"..."}}',
    '[nvidia] API error 404: 404 page not found',
    "[nvidia] API error 410: {\"title\":\"Gone\",\"detail\":\"model reached end of life\"}",
    '[groq] API error 403: forbidden',
    '[opencode-go] API error 403: {"type":"error","error":{"type":"RegionError","message":"only available hosted in China, requires opt in"}}',
    '[opencode-go] Model muse-spark-1.3-contributor requires the Go /responses endpoint, which this proxy does not support (chat/completions only). Remap it in models.json.',
    '[opencode-go] Model minimax-m3 requires the Go /messages endpoint, which this proxy does not support.',
  ];
  for (const msg of cases) {
    assert.equal(classifyProviderError(msg), 'failover', `expected failover for: ${msg.slice(0, 60)}`);
  }
});

test('C1b: free-tier quota errors without a status code fail over; 429s stay retryable', () => {
  assert.equal(classifyProviderError('FreeUsageLimitError: quota exhausted'), 'failover');
  assert.equal(
    classifyProviderError('[zen] API error 429: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded"}}'),
    'retry',
    '429 status keeps retry-with-backoff semantics',
  );
});

test('C2: transient failures stay retryable', () => {
  const cases = [
    '[zen] API error 500: {"type":"error","message":"Internal server error"}',
    '[nvidia] API error 429: {"status":429,"title":"Too Many Requests"}',
    '[zen] API error 429: {"type":"error","message":"Rate limit exceeded"}',
    'upstream timed out for POST /v1/chat/completions',
    '[proxy] upstream error: fetch failed',
    '[nvidia] API error 502: Bad Gateway',
    '[nvidia] API error 503: Service Unavailable',
  ];
  for (const msg of cases) {
    assert.equal(classifyProviderError(msg), 'retry', `expected retry for: ${msg.slice(0, 60)}`);
  }
});

test('C3: unknown errors default to retry (safe)', () => {
  assert.equal(classifyProviderError('something weird happened'), 'retry');
  assert.equal(classifyProviderError(''), 'retry');
});

test('C4: isAccountFailure flags billing errors only', () => {
  assert.ok(isAccountFailure('[opencode-go] API error 401: {"type":"error","error":{"type":"CreditsError","message":"Insufficient balance"}}'));
  assert.ok(isAccountFailure('[opencode-go] API error 403: {"type":"error","error":{"type":"RegionError","message":"requires explicit opt in"}}'));
  assert.ok(isAccountFailure('[opencode-go] API error 403: {"type":"error","error":{"type":"DataPolicyError","message":"requires explicit opt in"}}'));
  assert.ok(!isAccountFailure('[zen] API error 500: Internal server error'));
  assert.ok(!isAccountFailure('[nvidia] API error 429: Too Many Requests'));
});

// ─── isThinkingRequiredError ───────────────────────────────────────────

test('C5: thinking-required errors detected', () => {
  assert.ok(isThinkingRequiredError(new Error('[1210] This model always engages in thinking and cannot be disabled; please use low, high, or max')));
  assert.ok(isThinkingRequiredError('[opencode-go] API error 400: cannot be disabled'));
  assert.ok(!isThinkingRequiredError(new Error('Internal server error')));
  assert.ok(!isThinkingRequiredError(new Error('CreditsError: Insufficient balance')));
});

// ─── streamWithThinkingRetry ───────────────────────────────────────────

function textRun(text: string): (cfg: Record<string, unknown> | undefined) => AsyncGenerator<StreamChunk> {
  return async function* () {
    yield { type: 'text' as const, content: text };
  };
}

function failingRun(message: string): (cfg: Record<string, unknown> | undefined) => AsyncGenerator<StreamChunk> {
  return async function* () {
    throw new Error(message);
  };
}

const THINKING_MSG = '[opencode-go] API error 400: [1210] cannot be disabled; please use low, high, or max';

test('C6: retries once with reasoning_effort=low on [1210]', async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const run = async function* (cfg: Record<string, unknown> | undefined) {
    calls.push(cfg);
    if (calls.length === 1) throw new Error(THINKING_MSG);
    yield { type: 'text' as const, content: 'recovered' };
  };
  const out: string[] = [];
  for await (const chunk of streamWithThinkingRetry(undefined, run)) {
    if (chunk.type === 'text') out.push(chunk.content || '');
  }
  assert.deepEqual(out, ['recovered']);
  assert.equal(calls.length, 2);
  assert.equal((calls[1] as any)?.providerOptions?.openai?.reasoningEffort, 'low');
});

test('C7: non-thinking errors rethrow without retry', async () => {
  let runs = 0;
  const run = async function* (_cfg: Record<string, unknown> | undefined) {
    runs++;
    throw new Error('CreditsError: Insufficient balance');
  };
  await assert.rejects(
    async () => { for await (const _ of streamWithThinkingRetry(undefined, run)) { /* drain */ } },
    /CreditsError/,
  );
  assert.equal(runs, 1);
});

test('C8: no retry when a valid effort was already sent', async () => {
  let runs = 0;
  const run = async function* (_cfg: Record<string, unknown> | undefined) {
    runs++;
    throw new Error(THINKING_MSG);
  };
  const cfg = { providerOptions: { openai: { reasoningEffort: 'max' } } };
  await assert.rejects(
    async () => { for await (const _ of streamWithThinkingRetry(cfg, run)) { /* drain */ } },
    /1210/,
  );
  assert.equal(runs, 1);
});

test('C9: no retry after data was already yielded (avoids duplicates)', async () => {
  let runs = 0;
  const run = async function* (_cfg: Record<string, unknown> | undefined) {
    runs++;
    yield { type: 'text' as const, content: 'partial' };
    throw new Error(THINKING_MSG);
  };
  const seen: string[] = [];
  await assert.rejects(
    async () => {
      for await (const chunk of streamWithThinkingRetry(undefined, run)) {
        if (chunk.type === 'text') seen.push(chunk.content || '');
      }
    },
    /1210/,
  );
  assert.deepEqual(seen, ['partial']);
  assert.equal(runs, 1);
});

test('C10: first-try success runs once', async () => {
  let runs = 0;
  const run = async function* (_cfg: Record<string, unknown> | undefined) {
    runs++;
    yield* textRun('ok')(_cfg);
  };
  const out: string[] = [];
  for await (const chunk of streamWithThinkingRetry({ a: 1 }, run)) {
    if (chunk.type === 'text') out.push(chunk.content || '');
  }
  assert.deepEqual(out, ['ok']);
  assert.equal(runs, 1);
});
