import { setTimeout as wait } from 'node:timers/promises';
import { checkBlocked } from './blocklist.js';
import { checkRateLimit, recordRequest } from './rate-limiter.js';
import { logger } from './logger.js';
import { config } from './config.js';
import type { ProviderConfig, ProviderId } from './adapter.js';
import { createAdapter } from './adapter.js';
import type { ModelAdapter, StreamChunk } from './adapters/types.js';
import type { OpenAIMessage } from './mapper.js';
import type { ModelResolver } from './models.js';
import { poolFetch } from './http-pool.js';

function fireFailoverWebhook(provider: string, model: string, error: string, status: string): void {
  const url = config.failoverWebhookUrl;
  if (!url) return;
  const body = JSON.stringify({ event: 'failover', provider, model, error, status, timestamp: new Date().toISOString() });
  poolFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) } as any).catch(() => {});
}

export interface RouterOptions {
  retries: number;
  backoffMs: number;
}

const DEFAULT_OPTIONS: RouterOptions = { retries: 10, backoffMs: 1000 };

export type ProviderErrorClass = 'retry' | 'failover';

// Matched first: these are always worth backing off and retrying.
const RETRYABLE_PATTERNS = [/429/, /rate_limit/i, /413/, /Request too large/i, /API error 5\d\d/, /timeout/i, /timed out/i, /fetch failed/i, /ECONN/i, /socket hang up/i, /Too Many Requests/];

// Only reached when nothing retryable matched: the same request can never
// succeed, so fail over immediately instead of burning latency/quota/money.
const DETERMINISTIC_PATTERNS = [/API error 400/, /API error 401/, /API error 403/, /API error 404/, /API error 410/, /which this proxy does not support/, /FreeUsageLimitError/];

/**
 * Classify a provider failure as retryable (429/5xx/network — back off and
 * retry) or deterministic (400/401/403/404/410 … — fail over without retrying).
 */
export function classifyProviderError(message: string): ProviderErrorClass {
  const msg = message || '';
  if (RETRYABLE_PATTERNS.some((r) => r.test(msg))) return 'retry';
  if (DETERMINISTIC_PATTERNS.some((r) => r.test(msg))) return 'failover';
  return 'retry';
}

/** Account/billing failures need human action in the provider console. */
export function isAccountFailure(message: string): boolean {
  return /CreditsError|Insufficient balance|billing|RegionError|DataPolicyError|opt in/i.test(message || '');
}

export class Router {
  private adapters = new Map<string, ModelAdapter>();
  private options: RouterOptions;
  private modelResolver: ModelResolver;

  constructor(providers: ProviderConfig[], modelResolver: ModelResolver, options?: Partial<RouterOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.modelResolver = modelResolver;
    this.addProviders(providers);
  }

  private addProviders(providers: ProviderConfig[]): void {
    for (const cfg of providers) {
      if (cfg.enabled) {
        this.adapters.set(cfg.id, createAdapter(cfg));
      }
    }
  }

  updateProviders(providers: ProviderConfig[], options?: Partial<RouterOptions>): void {
    this.adapters.clear();
    this.addProviders(providers);
    if (options) this.options = { ...this.options, ...options };
  }

  async *execute(
    providerIds: ProviderId[],
    model: string,
    messages: OpenAIMessage[],
    tools?: Record<string, unknown>,
    config?: Record<string, unknown>,
    signal?: AbortSignal,
    system?: string,
  ): AsyncGenerator<StreamChunk & { provider?: string; resolvedModel?: string }> {
    // Create server-side timeout signal
    const timeoutMs = (config?.requestTimeoutMs as number) || 300000; // 5 minutes default
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

    // Combine with client abort signal
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
    // Determine candidate providers based on routing mode
    let candidates: ProviderId[];
    const routingMode = this.modelResolver.routingMode;

    if (routingMode === 'per-model-per-provider') {
      const modelProviders = this.modelResolver.getProvidersForModel(model);
      if (modelProviders && modelProviders.length > 0) {
        candidates = [modelProviders[0] as ProviderId];
      } else {
        // No per-model config — use default provider if available,
        // otherwise fall through to the full priority chain
        if (this.modelResolver.defaultProvider) {
          candidates = [this.modelResolver.defaultProvider];
        } else {
          candidates = providerIds;
        }
      }
    } else {
      candidates = providerIds;
    }

    if (candidates.length === 0) {
      logger.warn(`[router] No providers available for model: ${model}`);
      yield { type: 'error', content: `No providers available for model: ${model}`, provider: '', resolvedModel: model };
      return;
    }

    logger.info(`[router] Mode: ${routingMode} | Candidates: ${candidates.join(' → ')} → ${model}`);

    // First pass: try the explicit/configured provider list.
    // When multiple providers are candidates, cap per-provider retries low (2) so we
    // don't burn 11 attempts × 50s backoff on a single broken provider when a
    // working one is next in line.
    const perProviderRetries = candidates.length > 1
      ? Math.min(2, this.options.retries)
      : this.options.retries;
    const tried = new Set<string>();
    let lastError: string | null = null;
    for (const providerId of candidates) {
      tried.add(providerId);
      const adapter = this.adapters.get(providerId);
      if (!adapter) {
        logger.debug(`[router] Skipping disabled provider: ${providerId}`);
        continue;
      }

      // Model fallback: try fallback models for this provider before moving to next
      const fallbackModels = this.modelResolver.getFallbackModels(model, providerId);
      let providerFullyFailed = false;

      for (let modelIdx = 0; modelIdx < fallbackModels.length; modelIdx++) {
        const candidateModel = fallbackModels[modelIdx];
        let resolvedModel = candidateModel;

        // Only run the complex resolution when using the primary (first) model.
        // Fallback models are already provider-specific strings from the config.
        if (modelIdx === 0) {
          const primaryResolved = this.modelResolver.resolve(model, providerId);
          if (primaryResolved && primaryResolved !== model) {
            resolvedModel = primaryResolved;
          } else {
            const providerMap = this.modelResolver.getProviderMap();
            const short = model.replace(/^models\//, '');
            const explicitMapping = providerMap[model]?.[providerId]
              || providerMap[short]?.[providerId];
            if (explicitMapping) {
              resolvedModel = Array.isArray(explicitMapping) ? explicitMapping[0] : explicitMapping;
            } else {
              let parentKey: string | null = null;
              for (const key of Object.keys(providerMap)) {
                if (key === 'default' || key === short) continue;
                if (short.startsWith(key + '-') || key.startsWith(short + '-')) {
                  parentKey = key;
                  break;
                }
              }
              const parentMapping = parentKey ? providerMap[parentKey]?.[providerId] : undefined;
              if (parentMapping) {
                resolvedModel = Array.isArray(parentMapping) ? parentMapping[0] : parentMapping;
              } else {
                const providerDefault = this.modelResolver.getDefaultModel(providerId);
                if (providerDefault) {
                  resolvedModel = providerDefault;
                } else if (this.modelResolver.defaultModel) {
                  resolvedModel = this.modelResolver.defaultModel;
                }
              }
            }
          }
        }

        const isFallbackModel = modelIdx > 0;
        if (isFallbackModel) {
          logger.info(`[router] ${providerId} trying fallback model ${modelIdx + 1}/${fallbackModels.length}: ${resolvedModel}`);
        } else {
          logger.info(`[router] Trying ${providerId} → ${resolvedModel} (from ${model})`);
        }

        let hasStreamedData = false;

        for (let attempt = 0; attempt <= perProviderRetries; attempt++) {
          yield { type: 'attempt', provider: providerId, resolvedModel, attempt: attempt + 1, status: attempt === 0 ? 'trying' : 'retrying', ...(isFallbackModel ? { modelFallback: true } : {}) };
          try {
            const blocked = checkBlocked(providerId, resolvedModel, JSON.stringify(messages));
              if (blocked.blocked) throw Object.assign(new Error(blocked.reason), { status: 403 });
              const limit = checkRateLimit(providerId);
              if (!limit.allowed) throw Object.assign(new Error('Gateway rate limit exceeded'), { status: 429 });
              recordRequest(providerId);
              const gen = adapter.stream(resolvedModel, messages, tools, config, combinedSignal, system);
            for await (const chunk of gen) {
              if (chunk.type === 'error') throw new Error(chunk.content || 'provider error');
              if (((chunk.type === 'text' || chunk.type === 'thought') && chunk.content) || chunk.type === 'tool-call') hasStreamedData = true;
              yield { ...chunk, provider: providerId, resolvedModel };
            }
            if (!hasStreamedData) throw new Error('Provider returned an empty completion');
            logger.info(`[router] ${providerId} succeeded with ${resolvedModel}`);
            return;
          } catch (err: any) {
            if (combinedSignal.aborted || err.status === 403 || err.status === 429) throw err;

            // Mid-stream failure prevents retrying the same model (would duplicate content)
            if (hasStreamedData) { throw err; }

            // Deterministic failures (400/401/403/404/410 …) can never succeed
            // on retry. Account-wide failures skip the provider's remaining
            // models too; model-specific ones advance to the next fallback model.
            if (classifyProviderError(err.message) === 'failover') {
              if (isAccountFailure(err.message)) {
                logger.error(`[router] ${providerId} account/billing failure (check console billing or usage limits) — failing over without retry: ${err.message}`);
                providerFullyFailed = true;
              } else {
                logger.warn(`[router] ${providerId} model ${resolvedModel} deterministic failure — failing over without retry: ${err.message}`);
              }
              fireFailoverWebhook(providerId, resolvedModel, err.message, 'failover');
              yield { type: 'attempt', provider: providerId, resolvedModel, attempt: attempt + 1, status: 'failover', ...(isFallbackModel ? { modelFallback: true } : {}) };
              lastError = err.message;
              break;
            }

            const isLastAttempt = attempt >= perProviderRetries;
            const isLastFallbackModel = modelIdx === fallbackModels.length - 1;
            const isLastProvider = candidates.indexOf(providerId) === candidates.length - 1;

            if (isLastAttempt && isLastFallbackModel && isLastProvider) {
              lastError = err.message;
              providerFullyFailed = true;
              break;
            }

            if (!isLastAttempt) {
              const isRateLimit = err.message.includes('429') || err.message.includes('rate_limit') || err.message.includes('413') || err.message.includes('Request too large');
              const waitMs = isRateLimit
                ? Math.min(10000 * Math.pow(2, attempt), 60000)
                : this.options.backoffMs * Math.pow(2, attempt);
              logger.warn(`[router] ${providerId} ${resolvedModel} attempt ${attempt + 1}/${perProviderRetries + 1} failed, retry in ${waitMs}ms: ${err.message}`);
              await wait(waitMs, undefined, { signal: combinedSignal });
            } else {
              logger.warn(`[router] ${providerId} model ${resolvedModel} exhausted: ${err.message}`);
              fireFailoverWebhook(providerId, resolvedModel, err.message, 'failover');
              yield { type: 'attempt', provider: providerId, resolvedModel, attempt: attempt + 1, status: 'failover', ...(isFallbackModel ? { modelFallback: true } : {}) };
              lastError = err.message;
            }
          }
        }

        if (providerFullyFailed) break;
      }
    }

    // Second pass (A6): the first-pass candidate failed.
    // Fall back to remaining providers in the priority chain (excluding ones we already tried).
    //
    // In per-model-per-provider mode with no per-model config, `tried` contains
    // just the default provider, so `fallback` becomes the rest of the priority chain.
    // If you want to disable the global fallback (strict whitelist), set
    // DISABLE_GLOBAL_FALLBACK=1 in the environment.
    const fallback = providerIds.filter(id => !tried.has(id) && this.adapters.has(id));
    if (fallback.length > 0) {
      logger.warn(`[router] All explicit providers failed for ${model} — falling back to: ${fallback.join(' → ')} (last error: ${lastError})`);
      const fallbackRetries = Math.min(2, this.options.retries);
      for (const providerId of fallback) {
        tried.add(providerId);
        const adapter = this.adapters.get(providerId);
        if (!adapter) continue;

        // Model fallback in the global fallback pass too
        const fallbackModels = this.modelResolver.getFallbackModels(model, providerId);
        let providerFullyFailed = false;

        for (let modelIdx = 0; modelIdx < fallbackModels.length; modelIdx++) {
          const candidateModel = fallbackModels[modelIdx];
          let resolvedModel = candidateModel;

          if (modelIdx === 0) {
            const primaryResolved = this.modelResolver.resolve(model, providerId);
            if (primaryResolved && primaryResolved !== model) {
              resolvedModel = primaryResolved;
            } else {
              const providerMap = this.modelResolver.getProviderMap();
              const short = model.replace(/^models\//, '');
              const explicitMapping = providerMap[model]?.[providerId]
                || providerMap[short]?.[providerId];
              if (explicitMapping) {
                resolvedModel = Array.isArray(explicitMapping) ? explicitMapping[0] : explicitMapping;
              } else {
                let parentKey: string | null = null;
                for (const key of Object.keys(providerMap)) {
                  if (key === 'default' || key === short) continue;
                  if (short.startsWith(key + '-') || short.startsWith(key)) {
                    parentKey = key;
                    break;
                  }
                }
                if (!parentKey) {
                  for (const key of Object.keys(providerMap)) {
                    if (key === 'default' || key === short) continue;
                    if (key.startsWith(short + '-') || key.startsWith(short)) {
                      parentKey = key;
                      break;
                    }
                  }
                }
                const parentMapping = parentKey ? providerMap[parentKey]?.[providerId] : undefined;
                if (parentMapping) {
                  resolvedModel = Array.isArray(parentMapping) ? parentMapping[0] : parentMapping;
                } else {
                  const providerDefault = this.modelResolver.getDefaultModel(providerId);
                  if (providerDefault) {
                    resolvedModel = providerDefault;
                  } else if (this.modelResolver.defaultModel) {
                    resolvedModel = this.modelResolver.defaultModel;
                  }
                }
              }
            }
          }

          const isFallbackModel = modelIdx > 0;
          if (isFallbackModel) {
            logger.info(`[router] ${providerId} (fallback) trying model ${modelIdx + 1}/${fallbackModels.length}: ${resolvedModel}`);
          } else {
            logger.info(`[router] Fallback trying ${providerId} → ${resolvedModel} (from ${model})`);
          }

          for (let attempt = 0; attempt <= fallbackRetries; attempt++) {
            yield { type: 'attempt', provider: providerId, resolvedModel, attempt: attempt + 1, status: attempt === 0 ? 'trying' : 'retrying', fallback: true, ...(isFallbackModel ? { modelFallback: true } : {}) };
            let hasStreamedData = false;
            try {
              const blocked = checkBlocked(providerId, resolvedModel, JSON.stringify(messages));
              if (blocked.blocked) throw Object.assign(new Error(blocked.reason), { status: 403 });
              const limit = checkRateLimit(providerId);
              if (!limit.allowed) throw Object.assign(new Error('Gateway rate limit exceeded'), { status: 429 });
              recordRequest(providerId);
              const gen = adapter.stream(resolvedModel, messages, tools, config, combinedSignal, system);
              for await (const chunk of gen) {
                if (chunk.type === 'error') throw new Error(chunk.content || 'provider error');
                if (((chunk.type === 'text' || chunk.type === 'thought') && chunk.content) || chunk.type === 'tool-call') hasStreamedData = true;
                yield { ...chunk, provider: providerId, resolvedModel };
              }
              if (!hasStreamedData) throw new Error('Provider returned an empty completion');
              logger.info(`[router] ${providerId} succeeded with ${resolvedModel} (fallback)`);
              return;
            } catch (err: any) {
              if (combinedSignal.aborted || err.status === 403 || err.status === 429) throw err;
              if (hasStreamedData) { throw err; }
              // Deterministic failures never succeed on retry — advance to the
              // next fallback model (or provider). Account-wide failures skip
              // the provider's remaining models too.
              if (classifyProviderError(err.message) === 'failover') {
                if (isAccountFailure(err.message)) {
                  logger.error(`[router] ${providerId} (fallback) account/billing failure (check console billing or usage limits) — trying next without retry: ${err.message}`);
                  providerFullyFailed = true;
                } else {
                  logger.warn(`[router] ${providerId} model ${resolvedModel} (fallback) deterministic failure — trying next without retry: ${err.message}`);
                }
                fireFailoverWebhook(providerId, resolvedModel, err.message, 'failover');
                yield { type: 'attempt', provider: providerId, resolvedModel, attempt: attempt + 1, status: 'failover', fallback: true, ...(isFallbackModel ? { modelFallback: true } : {}) };
                lastError = err.message;
                break;
              }
              const isLastAttempt = attempt >= fallbackRetries;
              const isLastFallbackModel = modelIdx === fallbackModels.length - 1;
              const isLastFallbackProvider = fallback.indexOf(providerId) === fallback.length - 1;

              if (isLastAttempt && isLastFallbackModel && isLastFallbackProvider) {
                logger.error(`[router] All providers (including fallback) exhausted for ${model}`);
                fireFailoverWebhook(providerId, resolvedModel, err.message, 'failed');
                yield { type: 'attempt', provider: providerId, resolvedModel, attempt: attempt + 1, status: 'failed', fallback: true };
                yield { type: 'error', content: `All providers failed: ${err.message}`, provider: providerId, resolvedModel };
                return;
              }
              if (!isLastAttempt) {
                const isRateLimit = err.message.includes('429') || err.message.includes('rate_limit') || err.message.includes('413') || err.message.includes('Request too large');
                const waitMs = isRateLimit ? Math.min(10000 * Math.pow(2, attempt), 60000) : this.options.backoffMs * Math.pow(2, attempt);
                logger.warn(`[router] ${providerId} ${resolvedModel} (fallback) attempt ${attempt + 1}/${fallbackRetries + 1} failed, retry in ${waitMs}ms: ${err.message}`);
                await wait(waitMs, undefined, { signal: combinedSignal });
              } else {
                logger.warn(`[router] ${providerId} model ${resolvedModel} (fallback) exhausted: ${err.message}`);
                fireFailoverWebhook(providerId, resolvedModel, err.message, 'failover');
                yield { type: 'attempt', provider: providerId, resolvedModel, attempt: attempt + 1, status: 'failover', fallback: true };
                lastError = err.message;
              }
            }
          }

          if (providerFullyFailed) break;
        }
      }
    }

    yield { type: 'error', content: `All providers failed: ${lastError || 'unknown'}` };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export type { ProviderId, ProviderConfig } from './adapter.js';
