import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { USER_ENV_PATH, migrateUserData, dataFile } from './data-paths.js';

export function initializeConfig(): string {
  migrateUserData();
  for (const name of ['models.json', 'pricing.json', 'blocklist.json', 'reasoning-effort.json']) dataFile(name);
  if (!fs.existsSync(USER_ENV_PATH)) {
    const defaults = {
      PROVIDER_PRIORITY: 'openai', PROXY_PORT: '51000', API_PORT: '51001',
      AG_GATEWAY_HOST: '127.0.0.1', AG_GATEWAY_REMOTE: 'false',
      AG_GATEWAY_TOKEN: randomBytes(32).toString('hex'),
      DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: randomBytes(24).toString('base64url'),
      CONTEXT_STRIP_MODE: 'passthrough', COMPACTION_ENABLED: 'true',
      PROXY_RETRIES: '2', PROXY_BACKOFF_MS: '500', LOG_LEVEL: 'info',
      RATE_LIMIT_GLOBAL: '0', RATE_LIMIT_PROVIDER: '0', RATE_LIMIT_WINDOW_MS: '60000',
    };
    fs.writeFileSync(USER_ENV_PATH, Object.entries(defaults).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  }
  return USER_ENV_PATH;
}

export function readSettings(): Record<string, string> {
  return dotenv.parse(fs.readFileSync(initializeConfig(), 'utf8'));
}

export function writeSettings(updates: Record<string, unknown>): void {
  const current = readSettings();
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Settings must contain uppercase keys and single-line string values');
    if ((key === 'AG_GATEWAY_TOKEN' || key === 'DASHBOARD_PASSWORD') && value.length < 16) throw new Error(`${key} must contain at least 16 characters`);
    if (key === 'DASHBOARD_USER' && !value.trim()) throw new Error('Dashboard username cannot be empty');
    current[key] = value;
  }
  fs.writeFileSync(USER_ENV_PATH, Object.entries(current).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n', { mode: 0o600 });
}
