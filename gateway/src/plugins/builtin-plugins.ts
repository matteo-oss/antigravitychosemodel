/**
 * Built-in Provider Plugins
 *
 * Registers all the default Antigravity providers as plugins.
 * Each provider is a separate IProviderPlugin that knows its own
 * defaults, adapter type, and capabilities.
 *
 * Extend by adding a new plugin registration in registerBuiltinPlugins().
 */

import { logger } from '../logger.js';
import { providerRegistry } from '../provider-registry.js';
import type { IProviderPlugin, ProviderCapabilities } from '../provider-plugin.js';
import type { ProviderConfig } from '../adapter.js';
import type { ModelAdapter } from '../adapters/types.js';
import { OpenAICompatAdapter } from '../adapters/openai.js';
import { AnthropicAdapter } from '../adapters/anthropic.js';
import { GoogleAdapter } from '../adapters/google.js';
import { GroqAdapter } from '../adapters/groq.js';
import { ZenAdapter } from '../adapters/zen.js';
import { OpencodeGoAdapter } from '../adapters/opencode-go.js';
import { NvidiaAdapter } from '../adapters/nvidia.js';
import { DEFAULT_CAPABILITIES } from '../provider-plugin.js';
import { BUILTIN_PROVIDERS, getProviderApiKey, type ProviderDef } from '../provider-catalog.js';

// ─── Plugin factory ────────────────────────────────────────────────────

function createAdapterForType(type: 'openai' | 'anthropic' | 'google', cfg: ProviderConfig): ModelAdapter {
  // Use provider-specific adapters for optimized behavior
  switch (cfg.id) {
    case 'groq':
      return new GroqAdapter(cfg.id, cfg.baseUrl || BUILTIN_PROVIDERS.find(p => p.id === cfg.id)?.baseUrl || '', cfg.apiKey || '');
    case 'zen':
      return new ZenAdapter(cfg.id, cfg.baseUrl || BUILTIN_PROVIDERS.find(p => p.id === cfg.id)?.baseUrl || '', cfg.apiKey || '');
    case 'opencode-go':
      return new OpencodeGoAdapter(cfg.id, cfg.baseUrl || BUILTIN_PROVIDERS.find(p => p.id === cfg.id)?.baseUrl || '', cfg.apiKey || '');
    case 'nvidia':
      return new NvidiaAdapter(cfg.id, cfg.baseUrl || BUILTIN_PROVIDERS.find(p => p.id === cfg.id)?.baseUrl || '', cfg.apiKey || '');
  }
  switch (type) {
    case 'openai':
      return new OpenAICompatAdapter(cfg.id, cfg.baseUrl || BUILTIN_PROVIDERS.find(p => p.id === cfg.id)?.baseUrl || '', cfg.apiKey || '');
    case 'anthropic':
      return new AnthropicAdapter(cfg.baseUrl || '', cfg.apiKey || '');
    case 'google':
      return new GoogleAdapter(cfg.baseUrl || '', cfg.apiKey || '');
  }
}

/**
 * Create an IProviderPlugin for a built-in provider definition.
 */
function buildPlugin(def: ProviderDef): IProviderPlugin {
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_CAPABILITIES,
    label: def.name,
    ...(def.capabilities || {}),
  };

  return {
    id: def.id,
    name: def.name,

    getAdapter(config: ProviderConfig): ModelAdapter {
      return createAdapterForType(def.adapterType, {
        ...config,
        id: def.id,
        baseUrl: config.baseUrl || def.baseUrl,
        apiKey: config.apiKey || getProviderApiKey(def),
      });
    },

    getCapabilities(): ProviderCapabilities {
      return capabilities;
    },

    validateConfig(config: Record<string, unknown>): string | null {
      // Local providers (ollama, vllm, lmstudio) don't need API keys
      if (!def.envKey) return null;
      if (!config.apiKey && !getProviderApiKey(def)) {
        return `Missing API key — set ${def.envKey} in .env or provide it in config`;
      }
      return null;
    },
  };
}

// ─── Registration ──────────────────────────────────────────────────────

/**
 * Register all built-in provider plugins with the global registry.
 * Called once at startup.
 */
export function registerBuiltinPlugins(): void {
  let count = 0;
  for (const def of BUILTIN_PROVIDERS) {
    const plugin = buildPlugin(def);
    providerRegistry.register(plugin);
    count++;
  }
  logger.info(`[plugins] Registered ${count} built-in providers`);
}
