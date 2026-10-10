import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BUILTIN_PROVIDERS } from '../src/provider-catalog.js';

process.env.AG_GATEWAY_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'ag-gateway-integration-'));
const token = 'gateway-test-token-only-0123456789';
const password = 'dashboard-test-password-only-012345';
const basic = 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
let generation = '', dashboard = '', upstream: http.Server, instance: any;
let requested: { url: string; body: any; authorization?: string }[] = [];
let broken = false, midstream = false, mockTools = false;
let responseMode: 'normal' | 'empty-primary-sse' | 'empty-primary-json' | 'all-empty' | 'error-primary' | 'partial-error' = 'normal';
const setup = { _routing_mode: 'priority-chain', _provider_models: { demo: { openai: 'model-primary', nvidia: 'model-secondary' } }, _compaction_enabled: false };

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requested.push({ url: req.url || '', body, authorization: req.headers.authorization });
    if (req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-primary' }] })); return; }
    if (broken && req.url?.startsWith('/primary')) { res.writeHead(503); res.end('Provider unavailable'); return; }
    const primary = req.url?.startsWith('/primary');
    if (responseMode === 'empty-primary-json' && primary) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '' } }] })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (responseMode === 'all-empty' || (primary && responseMode === 'empty-primary-sse')) { res.end('data: [DONE]\n\n'); return; }
    if (primary && responseMode === 'error-primary') { res.end('data: {"error":{"message":"private-upstream-details"}}\n\n'); return; }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
    if (responseMode === 'partial-error') { res.end('data: {"error":{"message":"private-upstream-details"}}\n\n'); return; }
    if (midstream) { setTimeout(() => res.destroy(), 25); return; }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world' } }] })}\n\n`);
    if (mockTools) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"Limit":"2"}' } }] } }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as any).port;
  const { writeSettings } = await import('../src/settings.js');
  writeSettings({ PROXY_PORT: '0', API_PORT: '0', AG_GATEWAY_TOKEN: token, DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD: password,
    PROVIDER_PRIORITY: 'openai,nvidia', OPENAI_API_KEY: 'fake-primary-key', NVIDIA_API_KEY: 'fake-secondary-key', OPENAI_BASE_URL: `http://127.0.0.1:${port}/primary/v1`, NVIDIA_BASE_URL: `http://127.0.0.1:${port}/secondary/v1`, PROXY_RETRIES: '0', LOG_LEVEL: 'error' });
  fs.writeFileSync(path.join(process.env.AG_GATEWAY_DATA_DIR!, 'models.json'), JSON.stringify(setup));
  const { startGateway } = await import('../src/server.js');
  instance = await startGateway();
  generation = `http://127.0.0.1:${instance.generationPort}`;
  dashboard = `http://127.0.0.1:${instance.dashboardPort}`;
});

after(async () => { await instance?.close(); await new Promise<void>(resolve => upstream?.close(() => resolve())); });
const api = (route: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') => fetch(dashboard + route, { method, headers: { Authorization: basic, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
const generate = (stream = false, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => fetch(`${generation}/v1beta/models/demo:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, { method: 'POST', headers: { 'x-goog-api-key': token, 'content-type': 'application/json', 'x-antigravity-conversation-id': 'test-conversation', ...headers }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Test question' }] }], ...extra }) });

test('health is minimal, models require auth and expose no provider secrets', async () => {
  assert.equal((await fetch(generation + '/health')).status, 200);
  assert.equal((await fetch(generation + '/models')).status, 401);
  const response = await fetch(generation + '/models', { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json() as any;
  assert.equal(data.models[0].externalModelName, 'demo');
  assert.equal(data.models[0].provider, 'google');
  assert.equal(data.models[0].contextWindow, 128000);
  assert.equal(data.models[0].supportsVision, false);
  assert.equal(data.models[0].supportsThinking, false);
  assert.ok(!JSON.stringify(data).includes('fake-primary-key'));
});

test('dashboard login, authenticated APIs, and origin/host protection', async () => {
  assert.equal((await fetch(dashboard + '/api/config')).status, 401);
  assert.equal((await fetch(dashboard + '/login.html')).status, 200);
  const login = await fetch(dashboard + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie') || '', /HttpOnly/);
  assert.equal((await fetch(dashboard + '/api/config', { headers: { cookie: (login.headers.get('set-cookie') || '').split(';')[0] } })).status, 200);
  assert.equal((await fetch(dashboard + '/api/status', { headers: { Authorization: basic, Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await api('/api/auth/disable', {})).status, 400);
  const offlineChart = await fetch(dashboard + '/vendor/chart.umd.js');
  assert.equal(offlineChart.status, 200); assert.match(await offlineChart.text(), /Chart\.js/);
});

test('malformed dashboard request targets return 400 without stopping either listener', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: instance.dashboardPort, path: '//[', method: 'GET' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(dashboard + '/api/health')).status, 200);
  assert.equal((await fetch(generation + '/health')).status, 200);
});

test('config reads mask credentials while preserving nonsecret settings', async () => {
  assert.equal((await api('/api/config', { OAUTH_CLIENT_SECRET: 'fixture-private-client-secret' })).status, 400);
  // Legacy/CLI settings can still contain arbitrary secrets and must remain masked.
  (await import('../src/settings.js')).writeSettings({ OAUTH_CLIENT_SECRET: 'fixture-private-client-secret' });
  const settings = await (await api('/api/config')).json() as any;
  for (const key of ['OPENAI_API_KEY', 'NVIDIA_API_KEY', 'AG_GATEWAY_TOKEN', 'DASHBOARD_PASSWORD', 'OAUTH_CLIENT_SECRET']) assert.equal(settings[key], '********');
  assert.match(settings.OPENAI_BASE_URL, /\/primary\/v1$/);
  assert.equal(settings.DASHBOARD_USER, 'admin');
  assert.ok(!JSON.stringify(settings).includes(password));
});

test('provider metadata and settings support every catalog entry without exposing credentials', async () => {
  assert.equal((await fetch(dashboard + '/api/providers')).status, 401);
  const metadata = await (await api('/api/providers')).json() as any;
  assert.deepEqual(metadata.providers.map((item: any) => item.id), BUILTIN_PROVIDERS.map(item => item.id));
  const secrets: Record<string, string> = {};
  const origin = `http://127.0.0.1:${(upstream.address() as any).port}`;
  for (const definition of BUILTIN_PROVIDERS.filter(item => ['together', 'huggingface', 'sambanova', 'siliconflow', 'novita', 'dashscope', 'deepseek', 'mistral', 'xai', 'cerebras', 'fireworks'].includes(item.id))) {
    const entry = metadata.providers.find((item: any) => item.id === definition.id);
    assert.equal(entry.envKey, definition.envKey);
    assert.equal(entry.baseUrlEnv, definition.baseUrlEnv);
    assert.equal(entry.baseUrl, definition.baseUrl);
    secrets[definition.envKey] = `fixture-private-${definition.id}-key`;
    secrets[definition.baseUrlEnv] = origin + '/providers/' + definition.id + new URL(definition.baseUrl).pathname;
  }
  secrets.HUGGINGFACE_API_KEY = '';
  secrets.HF_TOKEN = 'fixture-private-hf-alias-token';
  assert.equal((await api('/api/config', secrets)).status, 200);
  const status = await (await api('/api/status')).json() as any;
  assert.match(status.env.TOGETHER_API_KEY, /••••/);
  assert.match(status.env.HUGGINGFACE_API_KEY, /••••/);
  assert.equal(status.providers.find((item: any) => item.id === 'huggingface').hasKey, true);
  assert.ok(!JSON.stringify(status).includes('fixture-private-'));
  assert.ok(!JSON.stringify(metadata).includes('fixture-private-'));
});

test('new provider selections actually route authenticated Gemini JSON and SSE requests after reload', async () => {
  try {
    for (const id of ['together', 'huggingface', 'sambanova', 'siliconflow', 'novita', 'dashscope', 'deepseek', 'mistral', 'xai', 'cerebras', 'fireworks']) {
      assert.equal((await api('/api/config', { PROVIDER_PRIORITY: id })).status, 200);
      assert.equal((await api('/api/models', { ...setup, _provider_models: { demo: { [id]: `model-${id}` } } })).status, 200);
      const response = await generate(); assert.equal(response.status, 200, id);
      const value = await response.json() as any;
      assert.equal(value.candidates[0].content.parts[0].text, 'Hello world', id);
      assert.equal(value.modelVersion, `model-${id}`, id);
      assert.match(requested.at(-1)!.url, new RegExp(`/providers/${id}/`));
      assert.equal(requested.at(-1)!.authorization, id === 'huggingface' ? 'Bearer fixture-private-hf-alias-token' : `Bearer fixture-private-${id}-key`);
      const stream = await generate(true); assert.equal(stream.status, 200, id);
      assert.match(await stream.text(), /Hello /);
    }
  } finally {
    await api('/api/config', { PROVIDER_PRIORITY: 'openai,nvidia' });
    await api('/api/models', setup);
  }
});

test('native Gemini JSON preserves text and usage; SSE contains unwrapped deltas exactly once', async () => {
  let response = await generate(); assert.equal(response.status, 200);
  const value = await response.json() as any;
  assert.equal(value.candidates[0].content.parts[0].text, 'Hello world');
  assert.ok(value.usageMetadata.promptTokenCount > 0); assert.equal(value.response, undefined);
  response = await generate(true); const sse = await response.text();
  const chunks = sse.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert.equal(chunks.flatMap(c => c.candidates?.[0]?.content.parts || []).map(p => p.text || '').join(''), 'Hello world');
  assert.equal(chunks.at(-1).candidates[0].finishReason, 'STOP');
  assert.ok(chunks.every(c => !c.response));
  assert.equal(requested.at(-1)?.authorization, 'Bearer fake-primary-key');
});

test('tool calls flush at DONE and normalize against this request schema', async () => {
  mockTools = true;
  try {
    const response = await generate(false, { tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'OBJECT', properties: { Limit: { type: 'INTEGER' } }, required: ['Limit'] } }] }] });
    const value = await response.json() as any;
    assert.deepEqual(value.candidates[0].content.parts.find((p:any) => p.functionCall)?.functionCall, { name: 'lookup', args: { Limit: 2 } });
  } finally { mockTools = false; }
});

test('provider/model fallback happens before output; partial streams are not retried', async () => {
  broken = true; const start = requested.length;
  try {
    const response = await generate(); assert.equal(response.status, 200);
    const value = await response.json() as any; assert.equal(value.modelVersion, 'model-secondary');
    assert.equal(requested.length - start, 2);
  } finally { broken = false; }
  midstream = true; const beforeFailure = requested.length;
  try {
    const response = await generate(true); const value = await response.text();
    assert.match(value, /Hello /); assert.match(value, /"error"/);
    assert.equal(requested.length - beforeFailure, 1, 'never switch providers after text has reached the caller');
  } finally { midstream = false; }
});

test('empty completions and SSE errors fail over before output; all-empty and partial-error requests fail', async () => {
  try {
    for (const mode of ['empty-primary-sse', 'empty-primary-json', 'error-primary'] as const) {
      responseMode = mode;
      const before = requested.length;
      const response = await generate();
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).modelVersion, 'model-secondary');
      assert.equal(requested.length - before, 2);
    }
    // Exercise the router's second/global fallback pass as well.
    await api('/api/models', { ...setup, _routing_mode: 'per-model-per-provider' });
    responseMode = 'empty-primary-sse';
    assert.equal((await (await generate()).json() as any).modelVersion, 'model-secondary');
    responseMode = 'all-empty';
    let response = await generate(); assert.equal(response.status, 502);
    assert.match(await response.text(), /empty completion/);
    await api('/api/models', setup);
    response = await generate(); assert.equal(response.status, 502);
    responseMode = 'partial-error';
    const before = requested.length;
    response = await generate(true);
    const stream = await response.text();
    assert.match(stream, /Hello /); assert.match(stream, /"error"/);
    assert.ok(!stream.includes('private-upstream-details'));
    assert.equal(requested.length - before, 1, 'a provider stream error must not duplicate partial output via failover');
  } finally { responseMode = 'normal'; await api('/api/models', setup); }
});

test('model matrix hot reload changes routing and authenticated model discovery', async () => {
  const update = { ...setup, _provider_models: { demo: { openai: 'renamed-model' }, additional: { openai: 'extra-model' } } };
  assert.equal((await api('/api/models', update)).status, 200);
  let response = await generate(); assert.equal((await response.json() as any).modelVersion, 'renamed-model');
  response = await fetch(generation + '/models', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await response.json() as any).models.length, 2);
  await api('/api/models', setup);
  const models = await api('/api/provider-models', { provider: 'openai', force: true });
  assert.ok((await models.json() as any).models.includes('model-primary'));
});

test('model import metadata follows configured context windows and explicit alias capabilities', async () => {
  const update = { ...setup, _context_windows: { demo: 8192 }, _model_capabilities: { demo: { supportsVision: true, supportsThinking: true } } };
  assert.equal((await api('/api/models', update)).status, 200);
  try {
    let response = await fetch(generation + '/models', { headers: { Authorization: `Bearer ${token}` } });
    const metadata = (await response.json() as any).models[0];
    assert.equal(metadata.contextWindow, 8192);
    assert.equal(metadata.supportsVision, true);
    assert.equal(metadata.supportsThinking, true);
    assert.equal((await api('/api/models', { ...update, _model_capabilities: { demo: { supportsVision: 'yes' } } })).status, 400);
    response = await fetch(generation + '/models', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await response.json() as any).models[0].supportsVision, true, 'invalid capability updates preserve the previous configuration');
  } finally { await api('/api/models', setup); }
  const response = await fetch(generation + '/models', { headers: { Authorization: `Bearer ${token}` } });
  const metadata = (await response.json() as any).models[0];
  assert.equal(metadata.contextWindow, 128000);
  assert.equal(metadata.supportsVision, false);
  assert.equal(metadata.supportsThinking, false);
});

test('blocklists and rate limits reject before inference; settings reject auth disable and newline injection', async () => {
  await api('/api/blocklist', { blockedProviders: [], blockedModels: [], contentPatterns: ['Test question'] });
  const beforeBlocked = requested.length; assert.equal((await generate()).status, 403); assert.equal(requested.length, beforeBlocked);
  await api('/api/blocklist', { blockedProviders: [], blockedModels: [], contentPatterns: [] });
  await api('/api/rate-limit/reset', {});
  await api('/api/rate-limit', { globalMax: 1, providerMax: 1, windowMs: 60000 });
  assert.equal((await generate()).status, 200); assert.equal((await generate()).status, 429);
  await api('/api/rate-limit', { globalMax: 0, providerMax: 0, windowMs: 60000 });
  assert.equal((await api('/api/config', { DASHBOARD_PASSWORD: '' })).status, 500);
  assert.equal((await api('/api/config', { OPENAI_API_KEY: 'key\nAG_GATEWAY_TOKEN=stolen' })).status, 500);
});

test('SQLite history, sessions, search, pricing/cost, and replay are functional', async () => {
  await api('/api/pricing', { openai: { 'model-primary': { input: 10, output: 20 } } });
  await generate();
  const history = await (await api('/api/requests')).json() as any[];
  assert.ok(history.some(row => row.content === 'Hello world'));
  assert.ok(history.some(row => row.content.includes('Test question')));
  const sessions = await (await api('/api/sessions?date=' + new Date().toISOString().slice(0, 10))).json() as any[];
  assert.ok(sessions.some(row => row.file === 'test-conversation'));
  const rows = await (await api('/api/sessions/requests?file=test-conversation')).json() as any[];
  assert.ok(rows.length > 1);
  const search = await (await api('/api/search?q=Hello')).json() as any;
  assert.ok(search.requests.total > 0);
  const cost = await (await api('/api/cost?all=true')).json() as any;
  assert.ok(cost.total.total_cost > 0); assert.ok(cost.byModel.some((row: any) => row.key === 'demo'));
  assert.equal(cost.total.totalRequests, history.filter((row:any) => row.direction === 'outgoing').length);
  const replay = await (await api('/api/replay', { model: 'demo', requestId: history.find(row => row.direction === 'outgoing' && row.content === 'Hello world').id })).json() as any;
  assert.equal(replay.text, 'Hello world');
  const disk = new DatabaseSync(path.join(process.env.AG_GATEWAY_DATA_DIR!, 'data', 'gateway.db'), { readOnly: true });
  assert.ok((disk.prepare('select count(*) as count from requests').get() as any).count > 0); disk.close();
});

test('history replay restores the full original request from incoming or outgoing IDs and records the new result', async () => {
  const text = 'Replay full prompt '.repeat(70) + 'preserve-this-tail';
  const input = {
    contents: [{ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: 'Earlier assistant turn' }] }, { role: 'user', parts: [{ text: 'Follow-up question' }] }],
    systemInstruction: { parts: [{ text: 'Original system instruction' }] },
    tools: [{ functionDeclarations: [{ name: 'lookup', description: 'A test tool', parameters: { type: 'OBJECT', properties: { Limit: { type: 'INTEGER' } } } }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
  };
  await generate(false, input, { 'x-antigravity-conversation-id': 'replay-fixture' });
  const originalPayload = structuredClone(requested.at(-1)!.body);
  const history = await (await api('/api/sessions/requests?file=replay-fixture')).json() as any[];
  const incoming = history.find(row => row.direction === 'incoming');
  const outgoing = history.find(row => row.direction === 'outgoing');
  assert.ok(incoming && outgoing);
  assert.equal(incoming.request_json, undefined, 'snapshots are fetched by ID internally, not included in history lists');
  await api('/api/models', { ...setup, _provider_models: { ...setup._provider_models, 'replay-alias': { openai: 'model-replay' } } });
  try {
    for (const requestId of [incoming.id, outgoing.id]) {
      const response = await api('/api/replay', { requestId, model: 'replay-alias' });
      assert.equal(response.status, 200);
      const replay = await response.json() as any;
      assert.equal(replay.text, 'Hello world');
      assert.deepEqual(requested.at(-1)!.body, { ...originalPayload, model: 'model-replay' });
    }
    assert.equal((await api('/api/replay', { requestId: outgoing.id, model: 'missing-alias' })).status, 400);
    assert.equal((await api('/api/replay', { requestId: 'not-a-saved-request', model: 'demo' })).status, 404);
    const after = await (await api('/api/requests')).json() as any[];
    assert.ok(after.filter(row => row.model === 'replay-alias' && row.direction === 'outgoing').length >= 2);
    const disk = new DatabaseSync(path.join(process.env.AG_GATEWAY_DATA_DIR!, 'data', 'gateway.db'), { readOnly: true });
    assert.deepEqual(JSON.parse((disk.prepare('SELECT input_json FROM request_snapshots WHERE request_id = ?').get(incoming.id) as any).input_json), input);
    disk.close();
    await api('/api/sessions?file=replay-fixture', undefined, 'DELETE');
    assert.equal((await api('/api/replay', { requestId: outgoing.id, model: 'demo' })).status, 404);
  } finally { await api('/api/models', setup); }
});

test('remote listeners require explicit opt-in and strong credentials', async () => {
  const old = process.env.AG_GATEWAY_HOST; process.env.AG_GATEWAY_HOST = '0.0.0.0';
  const { startGateway } = await import('../src/server.js');
  try { await assert.rejects(startGateway(), /requires AG_GATEWAY_REMOTE/); }
  finally { if (old === undefined) delete process.env.AG_GATEWAY_HOST; else process.env.AG_GATEWAY_HOST = old; }
});

test('reasoning options and opt-in context compaction affect upstream payloads', async () => {
  await api('/api/reasoning-effort', { model: 'demo', effort: 'low' });
  await generate(); assert.equal(requested.at(-1)?.body.reasoning_effort, 'low');
  await api('/api/reasoning-effort', { model: 'demo', effort: 'default' });
  const compact = { ...setup, _compaction_enabled: true, _compaction_threshold: 0.5, _compaction_tail_turns: 1, _context_windows: { demo: 256 } };
  assert.equal((await api('/api/models', compact)).status, 200);
  const start = requested.length;
  const contents = [
    { role: 'user', parts: [{ text: 'earlier context '.repeat(500) }] },
    { role: 'model', parts: [{ text: 'old answer' }] },
    { role: 'user', parts: [{ text: 'recent question' }] },
    { role: 'model', parts: [{ text: 'recent answer' }] },
    { role: 'user', parts: [{ text: 'continue' }] },
  ];
  const response = await generate(false, { contents }); assert.equal(response.status, 200);
  assert.equal(requested.length - start, 2, 'summary request followed by generation');
  assert.ok(requested.at(-1)?.body.messages.some((m:any) => String(m.content).includes('[Context compacted]')));
  await api('/api/models', setup);
});

test('applied local endpoints are routable and persist separately', async () => {
  const port = (upstream.address() as any).port;
  const provider = { id: 'testlocal', label: 'Local test', online: true, baseUrl: `http://127.0.0.1:${port}/secondary/v1`, models: ['local-model'], capabilities: { supportsTools: true, supportsStreaming: true, supportsReasoning: false, supportsSystemMessages: true } };
  const applied = await api('/api/local/apply', { providers: [provider] }); assert.equal(applied.status, 200);
  await api('/api/models', { ...setup, _routing_mode: 'per-model-per-provider', _provider_models: { demo: { testlocal: 'local-model' } } });
  const response = await generate(); assert.equal((await response.json() as any).modelVersion, 'local-model');
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.AG_GATEWAY_DATA_DIR!, 'local-providers.json'), 'utf8'));
  assert.equal(stored[0].id, 'testlocal');
  await api('/api/local/apply', { providers: [] }); await api('/api/models', setup);
});

test('invalid matrix updates preserve working routes and key/base URL reload invalidates adapters', async () => {
  assert.equal((await api('/api/models', { _provider_models: { broken: null } })).status, 400);
  const response = await generate(); assert.equal(response.status, 200);
  await api('/api/config', { OPENAI_API_KEY: 'fake-rotated-key' });
  await generate(); assert.equal(requested.at(-1)?.authorization, 'Bearer fake-rotated-key');
  await api('/api/config', { OPENAI_API_KEY: 'fake-primary-key' });
  const envFile = path.join(process.env.AG_GATEWAY_DATA_DIR!, '.env');
  const original = fs.readFileSync(envFile, 'utf8');
  fs.writeFileSync(envFile, original.replace(/^DASHBOARD_PASSWORD=.*$/m, 'DASHBOARD_PASSWORD='));
  await api('/api/reload', {});
  assert.equal((await fetch(dashboard + '/api/config')).status, 401, 'invalid disk credentials must never make the dashboard public');
  fs.writeFileSync(envFile, original);
});

test('safe CLI status reports only gateway and config is masked by default', async () => {
  const run = (args:string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], { env: process.env, windowsHide: true });
    let result = ''; child.stdout.on('data', c => result += c); child.stderr.on('data', c => result += c);
    child.on('exit', code => code ? reject(new Error(result)) : resolve(result));
  });
  assert.match(await run(['status']), /antigravity-model-gateway/);
  const shown = await run(['config']); assert.ok(!shown.includes(token)); assert.match(shown, /\*{8}/);
});
