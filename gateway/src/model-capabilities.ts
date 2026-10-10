/**
 * Model Capability Detection
 *
 * Detects and caches model capabilities (reasoning, tools, streaming, etc.)
 * based on model name patterns and provider-level defaults.
 *
 * This enables the router and engine to make intelligent decisions about
 * which models to use for which tasks, without requiring manual config.
 *
 * ## Capability Sources (in priority order)
 * 1. Explicit provider-level capabilities (from local-discovery)
 * 2. Model name pattern matching (e.g., "r1" → supports reasoning)
 * 3. Default fallback (conservative — assumes no special capabilities)
 */

import { logger } from './logger.js';
import type { LocalProviderInfo } from './local-discovery.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface ModelCapabilities {
  /** Whether the model supports reasoning/thinking output */
  supportsReasoning: boolean;
  /** Whether the model supports function/tool calling */
  supportsTools: boolean;
  /** Whether the model supports streaming responses */
  supportsStreaming: boolean;
  /** Whether the model supports system messages */
  supportsSystemMessages: boolean;
  /** Whether the model supports image inputs */
  supportsImages: boolean;
  /** Whether the model supports structured JSON output */
  supportsJsonMode: boolean;
}

/** Default (conservative) capabilities — assumes nothing special */
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  supportsReasoning: false,
  supportsTools: false,
  supportsStreaming: true,
  supportsSystemMessages: true,
  supportsImages: false,
  supportsJsonMode: false,
};

// ─── Model name pattern matching ──────────────────────────────────────

interface ModelPattern {
  pattern: RegExp;
  capabilities: Partial<ModelCapabilities>;
  label: string;
}

/**
 * Patterns for detecting model capabilities from model names.
 * Ordered most-specific first — the first match wins.
 */
const MODEL_PATTERNS: ModelPattern[] = [
  // Reasoning models — detect by name keywords
  { pattern: /r1/i,                     capabilities: { supportsReasoning: true }, label: 'reasoning-r1' },
  { pattern: /r2/i,                     capabilities: { supportsReasoning: true }, label: 'reasoning-r2' },
  { pattern: /reasoner/i,               capabilities: { supportsReasoning: true }, label: 'reasoning-reasoner' },
  { pattern: /-thinking$/i,             capabilities: { supportsReasoning: true }, label: 'reasoning-thinking-suffix' },
  { pattern: /thinking/i,               capabilities: { supportsReasoning: true }, label: 'reasoning-thinking' },
  { pattern: /qwq/i,                    capabilities: { supportsReasoning: true }, label: 'reasoning-qwq' },
  { pattern: /deepseek.*r[0-9]/i,       capabilities: { supportsReasoning: true }, label: 'reasoning-deepseek-r' },
  { pattern: /^o[1-9]/i,                capabilities: { supportsReasoning: true }, label: 'reasoning-o-series' },
  { pattern: /stepfun/i,                capabilities: { supportsReasoning: true }, label: 'reasoning-stepfun' },
  { pattern: /step-[0-9]/i,             capabilities: { supportsReasoning: true }, label: 'reasoning-step' },
  { pattern: /claude.*think/i,          capabilities: { supportsReasoning: true }, label: 'reasoning-claude-thinking' },

  // Vision models — detect image support
  { pattern: /vision/i,                 capabilities: { supportsImages: true },    label: 'vision' },
  { pattern: /vl$/i,                    capabilities: { supportsImages: true },    label: 'vision-vl' },
  { pattern: /multimodal/i,             capabilities: { supportsImages: true },    label: 'vision-multimodal' },
  { pattern: /llava/i,                  capabilities: { supportsImages: true },    label: 'vision-llava' },
  { pattern: /cogvlm/i,                 capabilities: { supportsImages: true },    label: 'vision-cogvlm' },
  { pattern: /qwen.*vl/i,               capabilities: { supportsImages: true },    label: 'vision-qwen-vl' },
  { pattern: /gemini.*vision/i,         capabilities: { supportsImages: true },    label: 'vision-gemini' },
  { pattern: /gpt.*vision/i,            capabilities: { supportsImages: true },    label: 'vision-gpt' },

  // Tool-capable models — known to support function calling
  { pattern: /function/i,               capabilities: { supportsTools: true },     label: 'tools-function' },
  { pattern: /tool/i,                   capabilities: { supportsTools: true },     label: 'tools-tool' },
];

// ─── Cache ─────────────────────────────────────────────────────────────

interface CachedEntry {
  capabilities: ModelCapabilities;
  timestamp: number;
}

const capabilityCache = new Map<string, CachedEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Detector ──────────────────────────────────────────────────────────

/**
 * Detect capabilities for a given model name.
 * Applies pattern matching and caches results.
 */
export function detectModelCapabilities(modelName: string): ModelCapabilities {
  const lower = modelName.toLowerCase();

  // Check cache first
  const cached = capabilityCache.get(lower);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ...cached.capabilities };
  }

  // Apply patterns
  const result: ModelCapabilities = { ...DEFAULT_CAPABILITIES };
  for (const mp of MODEL_PATTERNS) {
    if (mp.pattern.test(lower)) {
      Object.assign(result, mp.capabilities);
    }
  }

  // Cache and return
  capabilityCache.set(lower, {
    capabilities: { ...result },
    timestamp: Date.now(),
  });

  return result;
}

/**
 * Detect capabilities for a model, overriding with provider-level defaults
 * when the provider is known.
 */
export function detectModelCapabilitiesWithProvider(
  modelName: string,
  providerInfo?: LocalProviderInfo,
): ModelCapabilities {
  const modelCaps = detectModelCapabilities(modelName);

  if (!providerInfo) return modelCaps;

  // Merge: provider-level capabilities serve as a baseline,
  // model-level pattern matching can add to them
  return {
    supportsReasoning: modelCaps.supportsReasoning || providerInfo.capabilities.supportsReasoning,
    supportsTools: modelCaps.supportsTools || providerInfo.capabilities.supportsTools,
    supportsStreaming: modelCaps.supportsStreaming && providerInfo.capabilities.supportsStreaming,
    supportsSystemMessages: modelCaps.supportsSystemMessages && providerInfo.capabilities.supportsSystemMessages,
    supportsImages: modelCaps.supportsImages,
    supportsJsonMode: modelCaps.supportsJsonMode,
  };
}

/**
 * Get a human-readable label describing a model's key capabilities.
 */
export function getModelCapabilityLabel(modelName: string): string {
  const caps = detectModelCapabilities(modelName);
  const tags: string[] = [];
  if (caps.supportsReasoning) tags.push('🧠 reasoning');
  if (caps.supportsTools) tags.push('🔧 tools');
  if (caps.supportsImages) tags.push('🖼️ vision');
  return tags.length > 0 ? tags.join(' ') : 'basic';
}

/**
 * Clear the capability cache (e.g. on config reload).
 */
export function clearModelCapabilityCache(): void {
  capabilityCache.clear();
  logger.info('[model-capabilities] Cache cleared');
}

/**
 * Get the number of cached model entries.
 */
export function getModelCapabilityCacheSize(): number {
  return capabilityCache.size;
}
