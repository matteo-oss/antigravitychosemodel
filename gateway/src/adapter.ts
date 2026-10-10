import type { ModelAdapter, StreamChunk } from './adapters/types.js';
import { OpenAICompatAdapter } from './adapters/openai.js';
import { GroqAdapter } from './adapters/groq.js';
import { ZenAdapter } from './adapters/zen.js';
import { OpencodeGoAdapter } from './adapters/opencode-go.js';
import { NvidiaAdapter } from './adapters/nvidia.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';
import { providerRegistry } from './provider-registry.js';
import { BUILTIN_PROVIDERS, getProviderApiKey, getProviderDefinition } from './provider-catalog.js';
import type { OpenAIMessage } from './mapper.js';

export type ProviderId = 'nvidia' | 'openrouter' | 'openai' | 'groq' | 'anthropic' | 'google' | 'zen' | 'opencode-go' |
  'ollama' | 'vllm' | 'lmstudio' | 'together' | 'huggingface' | 'sambanova' | 'siliconflow' | 'novita' | 'dashscope' |
  'deepseek' | 'mistral' | 'xai' | 'cerebras' | 'fireworks' | (string & {});

export interface ProviderConfig {
  id: ProviderId;
  priority: number;
  apiKey?: string;
  baseUrl?: string;
  models?: Record<string, string>;
  enabled: boolean;
}

/**
 * Legacy default provider configs — kept for backward compatibility.
 * New code should use the plugin system (providerRegistry) instead.
 */
export const DEFAULT_PROVIDER_CONFIGS: Record<string, { baseUrl: string; adapterType: 'openai' | 'anthropic' | 'google'; envKey: string }> = Object.fromEntries(
  BUILTIN_PROVIDERS.map(({ id, baseUrl, adapterType, envKey }) => [id, { baseUrl, adapterType, envKey }]),
);

/**
 * Legacy adapter factory — creates an adapter for a provider.
 *
 * First tries the plugin registry; falls back to the hardcoded defaults
 * for backward compatibility with code that hasn't migrated to plugins yet.
 *
 * After full migration, this function will delegate entirely to the plugin system.
 */
export function createAdapter(cfg: ProviderConfig): ModelAdapter {
  // Prefer plugin-registered adapter
  if (providerRegistry.hasProvider(cfg.id)) {
    try {
      return providerRegistry.getAdapter(cfg);
    } catch {
      // Plugin adapter failed — fall through to legacy path
    }
  }

  // Legacy fallback for providers not yet registered as plugins
  const defaults = DEFAULT_PROVIDER_CONFIGS[cfg.id];
  if (!defaults && cfg.baseUrl) return new OpenAICompatAdapter(cfg.id, cfg.baseUrl, cfg.apiKey || '');
  if (!defaults) {
    throw new Error(`Unknown provider: ${cfg.id}. Register a plugin first.`);
  }
  const baseUrl = cfg.baseUrl || defaults.baseUrl;
  const definition = getProviderDefinition(cfg.id);
  const apiKey = cfg.apiKey || (definition ? getProviderApiKey(definition) : '');
  // Use provider-specific adapters when available
  switch (cfg.id) {
    case 'groq':
      return new GroqAdapter(cfg.id, baseUrl, apiKey);
    case 'zen':
      return new ZenAdapter(cfg.id, baseUrl, apiKey);
    case 'opencode-go':
      return new OpencodeGoAdapter(cfg.id, baseUrl, apiKey);
    case 'nvidia':
      return new NvidiaAdapter(cfg.id, baseUrl, apiKey);
  }
  switch (defaults.adapterType) {
    case 'openai':
      return new OpenAICompatAdapter(cfg.id, baseUrl, apiKey);
    case 'anthropic':
      return new AnthropicAdapter(baseUrl, apiKey);
    case 'google':
      return new GoogleAdapter(baseUrl, apiKey);
  }
}

// Re-export types for backward compatibility
export type { ModelAdapter, StreamChunk };
export type { OpenAIMessage };
