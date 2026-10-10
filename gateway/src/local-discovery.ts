/**
 * Local Provider Discovery
 *
 * Auto-discovers local LLM inference endpoints by probing common ports
 * and API paths. Supports multiple inference solutions out of the box.
 *
 * Each provider definition includes:
 * - Default base URL and port
 * - API endpoint for listing models
 * - Response parser for extracting model names
 * - Expected capabilities
 */

import { poolFetch } from './http-pool.js';
import { logger } from './logger.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface LocalProviderCapabilities {
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsReasoning: boolean;
  supportsSystemMessages: boolean;
}

export interface LocalProviderInfo {
  id: string;
  label: string;
  baseUrl: string;
  online: boolean;
  models: string[];
  capabilities: LocalProviderCapabilities;
  error?: string;
}

// ─── Provider definitions ──────────────────────────────────────────────

interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  modelEndpoint: string;
  parser: (data: any) => string[];
  capabilities: LocalProviderCapabilities;
}

const LOCAL_PROVIDERS: ProviderDef[] = [
  // Ollama — most common local provider
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434',
    modelEndpoint: '/api/tags',
    parser: (data) => (data.models || []).map((m: any) => m.name),
    capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // vLLM — OpenAI-compatible serving
  {
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://localhost:8000',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id),
    capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // LM Studio — OpenAI-compatible local server
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id),
    capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // llama.cpp / llama-server
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    baseUrl: 'http://localhost:8080',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id || m.model || ''),
    capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // text-generation-webui (oobabooga)
  {
    id: 'textgen',
    label: 'TextGen WebUI',
    baseUrl: 'http://localhost:5000',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id || m.model || ''),
    capabilities: { supportsTools: false, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // TabbyAPI — OpenAI-compatible for exllama
  {
    id: 'tabby',
    label: 'TabbyAPI',
    baseUrl: 'http://localhost:5000',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id || ''),
    capabilities: { supportsTools: false, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // LocalAI — OpenAI-compatible
  {
    id: 'localai',
    label: 'LocalAI',
    baseUrl: 'http://localhost:8080',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id || ''),
    capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // LiteLLM — OpenAI proxy
  {
    id: 'litellm',
    label: 'LiteLLM',
    baseUrl: 'http://localhost:4000',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id || ''),
    capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
  // Aphrodite Engine — OpenAI-compatible
  {
    id: 'aphrodite',
    label: 'Aphrodite',
    baseUrl: 'http://localhost:8000',
    modelEndpoint: '/v1/models',
    parser: (data) => (data.data || []).map((m: any) => m.id || ''),
    capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true },
  },
];

// ─── Caching ───────────────────────────────────────────────────────────

let cachedResults: LocalProviderInfo[] = [];
let lastScan = 0;

// ─── Probing ───────────────────────────────────────────────────────────

/**
 * Probe a single provider endpoint to check if it's online and get its models.
 */
async function probeProvider(def: ProviderDef): Promise<LocalProviderInfo> {
  const info: LocalProviderInfo = {
    id: def.id,
    label: def.label,
    baseUrl: def.baseUrl,
    online: false,
    models: [],
    capabilities: { ...def.capabilities },
  };

  try {
    const url = `${def.baseUrl}${def.modelEndpoint}`;
    const resp = await poolFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });

    if (resp.ok) {
      const data = await resp.json();
      info.models = def.parser(data).filter(Boolean);
      info.online = true;
      logger.info(`[local-discovery] ${def.label} found at ${def.baseUrl} (${info.models.length} models)`);
    } else {
      info.error = `HTTP ${resp.status}`;
    }
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.code === 'ETIMEOUT' || err.code === 'ECONNREFUSED') {
      info.error = 'offline';
    } else {
      info.error = err.message || String(err);
    }
  }

  return info;
}

// ─── Main API ──────────────────────────────────────────────────────────

/**
 * Scan all known local provider endpoints.
 * Returns results for all probed providers — online and offline.
 */
export async function scanLocalProviders(): Promise<LocalProviderInfo[]> {
  const results = await Promise.all(
    LOCAL_PROVIDERS.map(def => probeProvider(def)),
  );

  cachedResults = results;
  lastScan = Date.now();
  return results;
}

/**
 * Get the last cached scan results without re-probing.
 */
export function getCachedLocalProviders(): LocalProviderInfo[] {
  return cachedResults;
}

/**
 * Get only providers that were online in the last scan.
 */
export function getOnlineLocalProviders(): LocalProviderInfo[] {
  return cachedResults.filter(p => p.online && p.models.length > 0);
}

/**
 * Get a specific provider's info from the cache by id.
 */
export function getCachedProvider(id: string): LocalProviderInfo | undefined {
  return cachedResults.find(p => p.id === id);
}

/**
 * Check if enough time has passed to warrant a re-scan.
 * Default: 60 seconds between scans.
 */
export function shouldRescan(minIntervalMs = 60000): boolean {
  return Date.now() - lastScan > minIntervalMs;
}
