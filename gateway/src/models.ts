import { dataFile } from './data-paths.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectModelCapabilities } from './model-capabilities.js';
import type { ModelCapabilities } from './model-capabilities.js';
import type { ProviderId } from './adapter.js';
import { BUILTIN_PROVIDERS } from './provider-catalog.js';

export type RoutingMode = 'priority-chain' | 'per-model-per-provider';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_PATH = dataFile('models.json');

export type ProviderModelValue = string | string[];

export interface AliasCapabilities {
  supportsVision?: boolean;
  supportsThinking?: boolean;
}

export function validateModels(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model configuration must be an object');
  const data = value as Record<string, any>;
  if (data._routing_mode !== undefined && !['priority-chain', 'per-model-per-provider'].includes(data._routing_mode)) throw new Error('Invalid routing mode');
  if (data._provider_models !== undefined) {
    if (!data._provider_models || typeof data._provider_models !== 'object' || Array.isArray(data._provider_models)) throw new Error('Provider model map must be an object');
    for (const routes of Object.values(data._provider_models)) {
      if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('Every model needs a provider map');
      for (const model of Object.values(routes)) {
        if (typeof model === 'string' && model.trim()) continue;
        if (Array.isArray(model) && model.length && model.every(v => typeof v === 'string' && v.trim())) continue;
        throw new Error('Provider routes must contain a model name or a nonempty fallback list');
      }
    }
  }
  if (data._compaction_threshold !== undefined && (!Number.isFinite(data._compaction_threshold) || data._compaction_threshold <= 0 || data._compaction_threshold >= 1)) throw new Error('Compaction threshold must be between 0 and 1');
  if (data._compaction_tail_turns !== undefined && (!Number.isInteger(data._compaction_tail_turns) || data._compaction_tail_turns < 1)) throw new Error('Compaction must retain at least one turn');
  if (data._context_windows !== undefined && (!data._context_windows || typeof data._context_windows !== 'object' || Object.values(data._context_windows).some(v => !Number.isInteger(v) || (v as number) < 256))) throw new Error('Context windows must contain positive token limits (at least 256)');
  if (data._model_capabilities !== undefined) {
    if (!data._model_capabilities || typeof data._model_capabilities !== 'object' || Array.isArray(data._model_capabilities)) throw new Error('Model capabilities must be an alias map');
    for (const capabilities of Object.values(data._model_capabilities) as any[]) {
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new Error('Model capabilities must contain objects');
      for (const key of ['supportsVision', 'supportsThinking']) {
        if (capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
      }
    }
  }
}

export interface ProviderModelMap {
  [antigravityModel: string]: {
    [providerId: string]: ProviderModelValue;
  };
}

export class ModelResolver {
  private flatMap: Record<string, string> = {};
  private providerMap: ProviderModelMap = {};
  private aliasCapabilities: Record<string, AliasCapabilities> = {};
  routingMode: RoutingMode = 'priority-chain';
  globalProviderPriority: ProviderId[] = [...new Set([
    'openrouter', 'nvidia', 'anthropic', 'google', 'zen', 'opencode-go', 'openai', 'groq',
    ...BUILTIN_PROVIDERS.map(provider => provider.id),
  ])];
  titleModel: string = '';
  fallbackModel: string = '';
  defaultProvider: ProviderId | '' = '';
  defaultModel: string = '';
  compactionEnabled: boolean = true;
  compactionThreshold: number = 0.8;
  compactionModel: string = '';
  compactionTailTurns: number = 2;

  constructor() {
    this.load();
  }

  load(): void {
    this.flatMap = {};
    this.providerMap = {};
    this.aliasCapabilities = {};

    try {
      if (fs.existsSync(MODELS_PATH)) {
        const raw = fs.readFileSync(MODELS_PATH, 'utf-8');
        const file = JSON.parse(raw);
        validateModels(file);
        if (file._provider_models) {
          this.providerMap = file._provider_models;
        }
        this.aliasCapabilities = file._model_capabilities || {};
        if (file._routing_mode === 'per-model-per-provider' || file._routing_mode === 'priority-chain') {
          this.routingMode = file._routing_mode;
        }
        if (Array.isArray(file._global_provider_priority)) {
          this.globalProviderPriority = file._global_provider_priority;
        }
        if (typeof file._title_model === 'string') {
          this.titleModel = file._title_model;
        }
        if (typeof file._fallback_model === 'string') {
          this.fallbackModel = file._fallback_model;
        }
        if (typeof file._default_provider === 'string') {
          this.defaultProvider = file._default_provider as ProviderId;
        }
        if (typeof file._default_model === 'string') {
          this.defaultModel = file._default_model;
        }
        if (typeof file._compaction_enabled === 'boolean') {
          this.compactionEnabled = file._compaction_enabled;
        }
        if (typeof file._compaction_threshold === 'number') {
          this.compactionThreshold = file._compaction_threshold;
        }
        if (typeof file._compaction_model === 'string') {
          this.compactionModel = file._compaction_model;
        }
        if (typeof file._compaction_tail_turns === 'number') {
          this.compactionTailTurns = file._compaction_tail_turns;
        }
        for (const [k, v] of Object.entries(file)) {
          if (!k.startsWith('_')) this.flatMap[k] = String(v);
        }
      }
    } catch { /* use defaults */ }
  }

  reload(): void {
    this.load();
  }

  private extractPrimary(value: ProviderModelValue): string {
    return Array.isArray(value) ? value[0] : value;
  }

  getDefaultModel(providerId?: string): string {
    if (providerId) {
      const fromProviderMap = this.providerMap['default']?.[providerId];
      if (fromProviderMap != null) return this.extractPrimary(fromProviderMap);
    }
    return this.flatMap['default'] || '';
  }

  /**
   * Returns the full list of fallback models for a given antigravity model + provider.
   * Falls back to the resolved primary model as a single-element array if no mapping exists.
   */
  getFallbackModels(model: string, providerId: string): string[] {
    const value = this.providerMap[model]?.[providerId];
    if (value != null) {
      return Array.isArray(value) ? [...value] : [value];
    }
    const short = model.replace(/^models\//, '');
    if (short !== model) {
      const shortValue = this.providerMap[short]?.[providerId];
      if (shortValue != null) {
        return Array.isArray(shortValue) ? [...shortValue] : [shortValue];
      }
    }
    const primary = this.findPrimaryModel(short);
    if (primary) {
      const primaryValue = this.providerMap[primary]?.[providerId];
      if (primaryValue != null) {
        return Array.isArray(primaryValue) ? [...primaryValue] : [primaryValue];
      }
    }
    return [short || model];
  }

  resolve(model: string, providerId?: string): string {
    if (providerId && this.providerMap[model]?.[providerId] != null) {
      return this.extractPrimary(this.providerMap[model][providerId]);
    }
    const short = model.replace(/^models\//, '');
    if (short !== model && providerId && this.providerMap[short]?.[providerId] != null) {
      return this.extractPrimary(this.providerMap[short][providerId]);
    }
    if (this.flatMap[model]) return this.flatMap[model];
    if (this.flatMap[short]) return this.flatMap[short];
    for (const key of Object.keys(this.flatMap)) {
      if (key === 'default') continue;
      if (short.startsWith(key) || key.startsWith(short)) return this.flatMap[key];
    }
    const primary = this.findPrimaryModel(short);
    if (primary && providerId && this.providerMap[primary]?.[providerId] != null) {
      return this.extractPrimary(this.providerMap[primary][providerId]);
    }
    return short || model;
  }

  getProvidersForModel(model: string): string[] | null {
    const exact = this.providerMap[model];
    if (exact) return Object.keys(exact);
    const short = model.replace(/^models\//, '');
    if (short !== model) {
      const exactShort = this.providerMap[short];
      if (exactShort) return Object.keys(exactShort);
    }
    const primary = this.findPrimaryModel(short);
    if (primary && primary !== short) {
      const primaryProviders = this.providerMap[primary];
      if (primaryProviders) return Object.keys(primaryProviders);
    }
    // Reverse lookup: model starts with config key (e.g., "gemini-3.5-flash-extra-low" → "gemini-3.5-flash")
    // OR config key starts with model (e.g., "gemini-3-flash" → "gemini-3.5-flash")
    // Exact match above already catches exact variant names, so this only runs for unmatched names.
    for (const key of Object.keys(this.providerMap)) {
      if (key === 'default' || key === short) continue;
      if (short.startsWith(key + '-') || key.startsWith(short + '-')) {
        const keyProviders = this.providerMap[key];
        if (keyProviders) return Object.keys(keyProviders);
      }
    }
    return null;
  }

  private findPrimaryModel(model: string): string | null {
    for (const key of Object.keys(this.providerMap)) {
      if (key === 'default' || key === model) continue;
      // Config key "claude-sonnet-4-6-thinking" should match model "claude-sonnet-4-6"
      // because the key starts with the model + "-" (the key is a longer variant).
      if (key.startsWith(model + '-')) return key;
    }
    const stripped = model.replace(/-thinking$/, '');
    if (stripped !== model && this.providerMap[stripped]) return stripped;
    for (const key of Object.keys(this.providerMap)) {
      if (key === 'default' || key === stripped) continue;
      if (key.startsWith(stripped + '-')) return key;
    }
    return null;
  }

  hasModel(model: string): boolean {
    const short = model.replace(/^models\//, '');
    if (this.providerMap[model] || this.providerMap[short]) return true;
    if (this.flatMap[model] || this.flatMap[short]) return true;
    for (const key of Object.keys(this.flatMap)) {
      if (key === 'default') continue;
      if (short.startsWith(key) || key.startsWith(short)) return true;
    }
    return false;
  }

  getFlatMap(): Record<string, string> {
    return { ...this.flatMap };
  }

  getProviderMap(): ProviderModelMap {
    return JSON.parse(JSON.stringify(this.providerMap));
  }

  getAliasCapabilities(alias: string): AliasCapabilities {
    return { ...(this.aliasCapabilities[alias] || this.aliasCapabilities[alias.replace(/^models\//, '')] || {}) };
  }

  /**
   * Detect capabilities for a model by its name.
   * Uses pattern matching on the resolved model name.
   */
  getCapabilities(modelOrResolved: string): ModelCapabilities {
    return detectModelCapabilities(modelOrResolved);
  }

  /**
   * Resolve a model name and then detect its capabilities.
   */
  resolveWithCapabilities(model: string, providerId?: string): { resolvedModel: string; capabilities: ModelCapabilities } {
    const resolvedModel = this.resolve(model, providerId);
    return {
      resolvedModel,
      capabilities: detectModelCapabilities(resolvedModel),
    };
  }
}

export const modelResolver = new ModelResolver();
