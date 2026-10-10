/**
 * OpenCode Go endpoint requirements.
 *
 * Go serves different models over different protocols — they are NOT all
 * OpenAI-compatible chat/completions (see https://opencode.ai/docs/go/#endpoints):
 * - `/chat/completions` — OpenAI-compatible (what this proxy speaks)
 * - `/responses`       — OpenAI Responses API (different request/response shape)
 * - `/messages`        — Anthropic Messages API (different request/response shape)
 *
 * Sending a responses/messages model to /chat/completions fails at the
 * gateway, so mappings for such models must be caught with an actionable
 * error instead of burning retries on an obscure 4xx. Unknown model ids are
 * allowed through (docs lag behind the live model list).
 */

export type GoEndpoint = 'chat/completions' | 'responses' | 'messages' | 'unknown';

export type GatewayEndpoint = 'chat' | 'responses' | 'messages' | 'google-native' | 'unknown';

const RESPONSES_MODELS = new Set([
  'grok-4.6',
  'gpt-5.6-luna',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
]);

const MESSAGES_MODELS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
]);

export function getGoEndpoint(modelId: string): GoEndpoint {
  const id = modelId.replace(/^models\//, '').toLowerCase();
  if (RESPONSES_MODELS.has(id)) return 'responses';
  if (MESSAGES_MODELS.has(id)) return 'messages';
  return 'unknown';
}

/** True when the model can be served via POST /chat/completions. */
export function isGoChatCompatible(modelId: string): boolean {
  return getGoEndpoint(modelId) !== 'responses' && getGoEndpoint(modelId) !== 'messages';
}

// ─── Zen (https://opencode.ai/docs/zen/#endpoints) ───────────────────────
// Same three protocols as Go, plus Google-native model endpoints
// (/v1/models/<id>) which this proxy cannot speak.

const ZEN_RESPONSES_MODELS = new Set([
  'gpt-6-astra',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.5-pro',
  'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
  'gpt-5.3-codex', 'gpt-5.3-codex-spark',
  'gpt-5.2', 'gpt-5.2-codex',
  'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
  'gpt-5', 'gpt-5-codex', 'gpt-5-nano',
  'grok-4.6', 'grok-4.5', 'grok-build-0.1',
  'muse-spark-1.3', 'muse-spark-1.2',
]);

const ZEN_MESSAGES_MODELS = new Set([
  'claude-fable-5-1', 'claude-fable-5',
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus',
]);

const ZEN_GOOGLE_NATIVE_MODELS = new Set([
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash',
  'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-pro', 'gemini-3-flash',
]);

export function getZenEndpoint(modelId: string): GatewayEndpoint {
  const id = modelId.replace(/^models\//, '').toLowerCase();
  if (ZEN_RESPONSES_MODELS.has(id)) return 'responses';
  if (ZEN_MESSAGES_MODELS.has(id)) return 'messages';
  if (ZEN_GOOGLE_NATIVE_MODELS.has(id)) return 'google-native';
  return 'unknown';
}

/**
 * Actionable error for a model whose gateway endpoint this proxy cannot
 * speak (currently only Zen Google-native models). Matches the router's
 * deterministic-failure pattern so it fails over without retrying.
 */
export function endpointError(gateway: 'opencode-go' | 'zen', model: string, endpoint: string): Error {
  return new Error(
    `[${gateway}] Model ${model} requires the ${gateway === 'zen' ? 'Zen' : 'Go'} /${endpoint} endpoint, ` +
    `which this proxy does not support. ` +
    `Remap it in models.json to a supported model.`,
  );
}

/**
 * Scan a provider map (`_provider_models`-shaped, values may be strings or
 * fallback arrays) for mappings this proxy cannot serve. chat/responses/
 * messages are all handled — only Zen Google-native models are flagged.
 * Returns human-readable warnings.
 */
export function findEndpointMismatches(
  providerMap: Record<string, Record<string, string | string[]>>,
): string[] {
  const warnings: string[] = [];
  const check = (alias: string, model: unknown, gateway: 'opencode-go' | 'zen') => {
    const models = Array.isArray(model) ? model : [model];
    for (const m of models) {
      if (typeof m !== 'string') continue;
      const endpoint = gateway === 'zen' ? getZenEndpoint(m) : getGoEndpoint(m);
      if (endpoint === 'google-native') {
        warnings.push(
          `${alias} → ${gateway}:${m} requires a Google-native endpoint, ` +
          `which this proxy does not support. Remap to a chat/responses/messages model.`,
        );
      }
    }
  };
  for (const [alias, perProvider] of Object.entries(providerMap)) {
    if (alias === 'default') continue;
    check(alias, perProvider['opencode-go'], 'opencode-go');
    check(alias, perProvider['zen'], 'zen');
  }
  const defaults = providerMap['default'] || {};
  check('default', defaults['opencode-go'], 'opencode-go');
  check('default', defaults['zen'], 'zen');
  return warnings;
}

/** @deprecated Use findEndpointMismatches — responses/messages are now served. */
export function findGoEndpointMismatches(
  providerMap: Record<string, Record<string, string | string[]>>,
): string[] {
  return findEndpointMismatches(providerMap);
}
