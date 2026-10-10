import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const USER_DATA_DIR = path.resolve(process.env.AG_GATEWAY_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'gateway'));
export const USER_DB_DIR = path.join(USER_DATA_DIR, 'data');
export const USER_DB_PATH = path.join(USER_DB_DIR, 'gateway.db');
export const USER_CERTS_DIR = path.join(USER_DATA_DIR, 'certs');
export const USER_CERT_FILE = path.join(USER_CERTS_DIR, 'cert.pem');
export const USER_KEY_FILE = path.join(USER_CERTS_DIR, 'key.pem');
export const USER_LOGS_DIR = path.join(USER_DATA_DIR, 'logs');
export const USER_ENV_PATH = path.join(USER_DATA_DIR, '.env');
export function dataFile(name: string): string {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(USER_DATA_DIR, name);
  const bundled = path.join(PACKAGE_DIR, 'defaults', name);
  if (!fs.existsSync(target) && fs.existsSync(bundled)) fs.copyFileSync(bundled, target, fs.constants.COPYFILE_EXCL);
  return target;
}
export function migrateUserData(): void {
  for (const dir of [USER_DATA_DIR, USER_DB_DIR, USER_LOGS_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
