import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('CLI setup/start/status/stop works in an isolated profile without desktop processes', { timeout: 30000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gateway-lifecycle-'));
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, AG_GATEWAY_DATA_DIR: profile }, windowsHide: true });
    let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    child.on('error', reject); child.on('exit', code => code ? reject(new Error(output)) : resolve(output));
  });
  await run(['setup', '--non-interactive']);
  await run(['config', 'set', 'PROXY_PORT', '0']);
  await run(['config', 'set', 'API_PORT', '0']);
  try {
    assert.match(await run(['start']), /Gateway started/);
    const first = JSON.parse(fs.readFileSync(path.join(profile, 'runtime.json'), 'utf8'));
    assert.match(await run(['start']), /already running/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'runtime.json'), 'utf8')).pid, first.pid);
    assert.match(await run(['status']), /antigravity-model-gateway/);
    assert.ok(fs.existsSync(path.join(profile, 'data', 'gateway.db')));
    assert.match(await run(['stop']), /shutdown requested/);
    for (let i = 0; i < 30 && fs.existsSync(path.join(profile, 'runtime.json')); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(path.join(profile, 'runtime.json')), false);
    await assert.rejects(fetch(`http://127.0.0.1:${first.generationPort}/health`));
  } finally { try { await run(['stop']); } catch { /* already stopped */ } }
});
