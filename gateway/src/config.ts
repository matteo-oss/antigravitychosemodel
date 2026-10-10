import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { initializeConfig } from './settings.js';
import { dataFile } from './data-paths.js';
import type { ProviderConfig, ProviderId } from './adapter.js';
import type { LocalProviderInfo } from './local-discovery.js';
import { getProviderApiKey, getProviderDefinition } from './provider-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Migrate config to user home and use that path
const ENV_PATH = initializeConfig();

dotenv.config({ path: ENV_PATH, quiet: true });

const MODELS_JSON_PATH = dataFile('models.json');

function readCompactionSettings(): { compactionEnabled: boolean; compactionThreshold: number; compactionModel: string; compactionTailTurns: number } {
  const defaults = { compactionEnabled: false, compactionThreshold: 0.8, compactionModel: '', compactionTailTurns: 2 };
  try {
    if (fs.existsSync(MODELS_JSON_PATH)) {
      const raw = fs.readFileSync(MODELS_JSON_PATH, 'utf-8');
      const file = JSON.parse(raw);
      return {
        compactionEnabled: typeof file._compaction_enabled === 'boolean' ? file._compaction_enabled : defaults.compactionEnabled,
        compactionThreshold: typeof file._compaction_threshold === 'number' ? file._compaction_threshold : defaults.compactionThreshold,
        compactionModel: typeof file._compaction_model === 'string' ? file._compaction_model : defaults.compactionModel,
        compactionTailTurns: typeof file._compaction_tail_turns === 'number' ? file._compaction_tail_turns : defaults.compactionTailTurns,
      };
    }
  } catch { /* use defaults */ }
  return defaults;
}

const VALID_CONTEXT_STRIP_MODES = ['passthrough', 'strip', 'lite'];

function validateContextStripMode(value: string): 'strip' | 'passthrough' | 'lite' {
  if (VALID_CONTEXT_STRIP_MODES.includes(value)) {
    return value as 'strip' | 'passthrough' | 'lite';
  }
  logger.warn(`Invalid CONTEXT_STRIP_MODE '${value}', defaulting to 'passthrough'`);
  return 'passthrough';
}

export type Provider = ProviderId;

function parsePriority(): ProviderId[] {
  const raw = (process.env.PROVIDER_PRIORITY || 'openrouter,nvidia').split(',').map(s => s.trim().toLowerCase() as ProviderId);
  return raw.length > 0 ? raw : ['openrouter', 'nvidia'];
}

export function buildProviders(priority: ProviderId[], localConfigs?: ProviderConfig[]): ProviderConfig[] {
  const fromPriority: ProviderConfig[] = priority.map((id, idx) => {
    const definition = getProviderDefinition(id);
    const envKey = id.toUpperCase().replace(/-/g, '_');
    const apiKey = definition ? getProviderApiKey(definition) : process.env[`${envKey}_API_KEY`];
    const baseUrlEnv = definition?.baseUrlEnv || `${envKey}_BASE_URL`;
    return {
      id,
      priority: idx,
      apiKey: apiKey || undefined,
      baseUrl: process.env[baseUrlEnv] || undefined,
      enabled: !!apiKey || ['ollama', 'vllm', 'lmstudio'].includes(id) || !!process.env[baseUrlEnv],
    };
  });
  if (!localConfigs || localConfigs.length === 0) return fromPriority;
  const localIds = new Set(localConfigs.map(c => c.id));
  const merged = fromPriority.filter(c => !localIds.has(c.id));
  const startPriority = merged.length;
  merged.push(...localConfigs.map((c, i) => ({ ...c, priority: startPriority + i })));
  return merged;
}

function parseEnvFile(): void {
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf-8');
    const parsed = dotenv.parse(raw);
    if (!parsed.DASHBOARD_USER || (parsed.DASHBOARD_PASSWORD || '').length < 16 || (parsed.AG_GATEWAY_TOKEN || '').length < 16) throw new Error('Refusing to reload invalid gateway credentials');
    Object.assign(process.env, parsed);
  } catch { /* ignore */ }
}

function createConfig() {
  let localProviders: ProviderConfig[] = [];
  try { localProviders = JSON.parse(fs.readFileSync(dataFile('local-providers.json'), 'utf8')); } catch { /* no applied discovery yet */ }

  return {
    legacyProvider: (process.env.PROVIDER || parsePriority()[0] || 'openrouter') as Provider,
    nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
    nvidiaBaseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    proxyPort: parseInt(process.env.PROXY_PORT || '51000', 10),
    apiPort: parseInt(process.env.API_PORT || '51001', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    retries: parseInt(process.env.PROXY_RETRIES || '2', 10),
    backoffMs: parseInt(process.env.PROXY_BACKOFF_MS || '1000', 10),
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10),
    rateLimitGlobal: parseInt(process.env.RATE_LIMIT_GLOBAL || '0', 10),
    rateLimitProvider: parseInt(process.env.RATE_LIMIT_PROVIDER || '0', 10),
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    dashboardUser: process.env.DASHBOARD_USER || '',
    dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
    failoverWebhookUrl: process.env.FAILOVER_WEBHOOK_URL || '',
    contextStripMode: validateContextStripMode(process.env.CONTEXT_STRIP_MODE || 'passthrough'),
    ...readCompactionSettings(),
    providerPriority: parsePriority(),
    providers: buildProviders(parsePriority(), localProviders),
    get localProviders(): ProviderConfig[] { return localProviders; },
    setLocalProviders(discovered: LocalProviderInfo[]): void {
      localProviders = discovered.filter(p => p.online).map(p => ({
        id: p.id,
        priority: 999,
        apiKey: '',
        baseUrl: p.baseUrl,
        enabled: true,
        models: p.models.reduce((acc, m) => { acc[m] = m; return acc; }, {} as Record<string, string>),
      } as ProviderConfig));
      this.providers = buildProviders(this.providerPriority, localProviders);
      fs.writeFileSync(dataFile('local-providers.json'), JSON.stringify(localProviders, null, 2), 'utf8');
    },
    get isConfigured(): boolean {
      return this.providers.some((p: ProviderConfig) => {
        if (!p.apiKey) return ['ollama', 'vllm', 'lmstudio'].includes(p.id) || (!!p.baseUrl && /^(http|https):/.test(p.baseUrl));
        const key = p.apiKey.trim();
        if (key.length < 10) return false;
        // Filter out placeholder values from .env.example
        if (/\.\.\.$/.test(key)) return false;
        return true;
      });
    },
    get provider(): string {
      return this.legacyProvider;
    },
    get baseUrl(): string {
      const current = this.providers.find(p => p.id === this.legacyProvider);
      return current?.baseUrl || getProviderDefinition(this.legacyProvider)?.baseUrl || '';
    },
    get apiKey(): string {
      return this.providers.find(p => p.id === this.legacyProvider)?.apiKey || '';
    },
    reload(): void {
      parseEnvFile();
      this.legacyProvider = (process.env.PROVIDER || parsePriority()[0] || 'openrouter') as Provider;
      this.nvidiaApiKey = process.env.NVIDIA_API_KEY || '';
      this.nvidiaBaseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
      this.openrouterApiKey = process.env.OPENROUTER_API_KEY || '';
      this.openrouterBaseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
      this.proxyPort = parseInt(process.env.PROXY_PORT || '51000', 10);
      this.apiPort = parseInt(process.env.API_PORT || '51001', 10);
      this.logLevel = process.env.LOG_LEVEL || 'info';
      this.retries = parseInt(process.env.PROXY_RETRIES || '2', 10);
      this.backoffMs = parseInt(process.env.PROXY_BACKOFF_MS || '1000', 10);
      this.requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10);
      this.rateLimitGlobal = parseInt(process.env.RATE_LIMIT_GLOBAL || '0', 10);
      this.rateLimitProvider = parseInt(process.env.RATE_LIMIT_PROVIDER || '0', 10);
      this.rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
      this.dashboardUser = process.env.DASHBOARD_USER || '';
      this.dashboardPassword = process.env.DASHBOARD_PASSWORD || '';
      this.failoverWebhookUrl = process.env.FAILOVER_WEBHOOK_URL || '';
      this.contextStripMode = validateContextStripMode(process.env.CONTEXT_STRIP_MODE || 'passthrough');
      Object.assign(this, readCompactionSettings());
      this.providerPriority = parsePriority();
      this.providers = buildProviders(this.providerPriority, localProviders);
    },
  };
}

export const config = createConfig();
