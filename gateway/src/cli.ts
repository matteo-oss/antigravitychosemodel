#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { USER_DATA_DIR, USER_LOGS_DIR, USER_ENV_PATH } from './data-paths.js';
import { readSettings, writeSettings } from './settings.js';
import { BUILTIN_PROVIDERS, getProviderDefinition } from './provider-catalog.js';

const args = process.argv.slice(2), command = args[0] || 'help';
const settings = readSettings();
const address = () => {
  let port = settings.PROXY_PORT || '51000';
  let host = settings.AG_GATEWAY_HOST || '127.0.0.1';
  try { const state = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, 'runtime.json'), 'utf8')); port = String(state.generationPort); host = state.host; } catch { /* not running */ }
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
};
async function health(): Promise<any> {
  const response = await fetch(`${address()}/health`, { signal: AbortSignal.timeout(1500) });
  const value = await response.json() as any;
  if (value.service !== 'antigravity-model-gateway') throw new Error('The port belongs to another service');
  return value;
}

async function main(): Promise<void> {
  if (command === 'setup') {
    if (process.stdin.isTTY && !args.includes('--non-interactive')) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const provider = (await rl.question(`Provider (${BUILTIN_PROVIDERS.map(item => item.id).join('/')}): `)).trim() || settings.PROVIDER_PRIORITY.split(',')[0];
        const key = await rl.question('Provider API key (empty keeps current; local services need none): ');
        const definition = getProviderDefinition(provider);
        if (!definition) throw new Error('Select a provider from the supported list');
        writeSettings({ PROVIDER_PRIORITY: provider, ...(key && definition.envKey ? { [definition.envKey]: key } : {}) });
      } finally { rl.close(); }
    }
    const active = readSettings();
    console.log(`Config: ${USER_ENV_PATH}\nDashboard: http://127.0.0.1:${active.API_PORT}\nUsername: ${active.DASHBOARD_USER}\nPassword: ${active.DASHBOARD_PASSWORD}\nGateway token: ${active.AG_GATEWAY_TOKEN}`);
    console.log('Start the gateway, then configure model routes in the dashboard.');
    return;
  }
  if (command === 'config') {
    if (args[1] === 'set') {
      if (!args[2] || args[3] === undefined) throw new Error('Usage: config set KEY VALUE');
      writeSettings({ [args[2]]: args[3] }); console.log('Saved. Restart or use dashboard Reload to apply.'); return;
    }
    if (args[1] === 'get') { console.log(settings[args[2]] || ''); return; }
    const masked = Object.fromEntries(Object.entries(settings).map(([k,v]) => [k, /KEY|TOKEN|PASSWORD/.test(k) && v ? '********' : v]));
    console.log(JSON.stringify(masked, null, 2)); return;
  }
  if (command === 'status' || command === 'health') {
    try { console.log(JSON.stringify(await health(), null, 2)); }
    catch { console.log('Gateway is stopped.'); process.exitCode = 1; }
    return;
  }
  if (command === 'stop') {
    try { await health(); } catch { console.log('Gateway is already stopped.'); return; }
    const response = await fetch(`${address()}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.AG_GATEWAY_TOKEN || settings.AG_GATEWAY_TOKEN}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Stop rejected (HTTP ${response.status})`);
    console.log('Gateway shutdown requested.'); return;
  }
  if (command === 'logs') {
    const files = fs.existsSync(USER_LOGS_DIR) ? fs.readdirSync(USER_LOGS_DIR).filter(f => f.endsWith('.log')).sort() : [];
    if (args[1] === 'list') { console.log(files.join('\n')); return; }
    if (!files.length) { console.log('No gateway logs yet.'); return; }
    const file = path.join(USER_LOGS_DIR, files.at(-1)!);
    console.log(fs.readFileSync(file, 'utf8').split('\n').slice(-100).join('\n')); return;
  }
  if (command === 'start' && !args.includes('--foreground')) {
    try { await health(); console.log('Gateway is already running.'); return; } catch { /* start */ }
    fs.mkdirSync(USER_LOGS_DIR, { recursive: true });
    const log = fs.openSync(path.join(USER_LOGS_DIR, 'gateway-service.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
    child.unref(); fs.closeSync(log);
    for (let i = 0; i < 40; i++) {
      try { await health(); console.log(`Gateway started. Dashboard: http://127.0.0.1:${settings.API_PORT}. Login details: gateway setup --non-interactive`); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    throw new Error('Gateway did not become ready; inspect gateway logs.');
  }
  if (command === 'serve' || command === 'start') {
    const { startGateway } = await import('./server.js');
    const instance = await startGateway();
    process.once('SIGINT', () => void instance.close());
    process.once('SIGTERM', () => void instance.close());
    return;
  }
  console.log('Antigravity model gateway\nCommands: setup [--non-interactive], start [--foreground], stop, status, health, config [get KEY | set KEY VALUE], logs [list]\nAll data is isolated in ' + USER_DATA_DIR);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
