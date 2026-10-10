import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { modelResolver } from './models.js';
import { createDashboardHandler } from './dashboard.js';
import { mapContentsToMessages, mapTools, mapGenerationConfig } from './mapper.js';
import { streamResponse, extractConvId, injectReasoning, saveReasoning, getRouter, reloadRouter } from './engine.js';
import { injectContext } from './context-injector.js';
import { compactIfNeeded } from './compaction.js';
import { getContextWindow, loadContextWindowsFromModels } from './context-windows.js';
import { getSessionId, setSessionId } from './session-store.js';
import { checkBlocked } from './blocklist.js';
import { setRateLimitConfig } from './rate-limiter.js';
import { requestStore } from './request-store.js';
import { calculateCost } from './pricing.js';
import { httpPool } from './http-pool.js';
import { dataFile, USER_DATA_DIR } from './data-paths.js';
import { logger } from './logger.js';
import * as db from './db.js';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);
const estimateTokens = (text: string) => text ? Math.ceil(text.length / 4) : 0;

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function authorized(req: http.IncomingMessage): boolean {
  const key = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : req.headers['x-goog-api-key'];
  const expected = process.env.AG_GATEWAY_TOKEN || '';
  if (typeof key !== 'string' || !expected) return false;
  const a = Buffer.from(key), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function secureOrigin(req: http.IncomingMessage, host: string): boolean {
  try {
    const authority = req.headers.host || '';
    const hostname = new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, '');
    if (isLoopback(host) && !isLoopback(hostname)) return false;
    if (req.headers.origin && new URL(req.headers.origin).host !== authority) return false;
    return true;
  } catch { return false; }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw Object.assign(new Error('Request exceeds 16 MB limit'), { status: 413 });
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request must be valid JSON'), { status: 400 }); }
}

export function listGatewayModels(apiUrl: string): { models: Record<string, unknown>[] } {
  const aliases = new Set([...Object.keys(modelResolver.getFlatMap()), ...Object.keys(modelResolver.getProviderMap())].filter(k => k !== 'default'));
  return { models: [...aliases].sort().map(alias => ({
    name: `models/${alias}`, displayName: alias, description: 'Routed by the Antigravity model gateway',
    provider: 'google', apiUrl, externalModelName: alias,
    contextWindow: getContextWindow(alias),
    supportsVision: modelResolver.getAliasCapabilities(alias).supportsVision === true,
    supportsThinking: modelResolver.getAliasCapabilities(alias).supportsThinking === true,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  })) };
}

async function generate(req: http.IncomingMessage, res: http.ServerResponse, model: string, streaming: boolean): Promise<void> {
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const body = await readBody(req);
  const input = body.request || body;
  if (!Array.isArray(input.contents)) throw Object.assign(new Error('contents must be an array'), { status: 400 });
  const requestSnapshot = structuredClone(input);
  const blocked = checkBlocked([], model, JSON.stringify(input.contents));
  if (blocked.blocked) throw Object.assign(new Error(blocked.reason), { status: 403 });
  let system = (input.systemInstruction?.parts || input.system_instruction?.parts || []).map((part: any) => part.text || '').join('\n');
  let contents = input.contents;
  if (config.contextStripMode !== 'passthrough') {
    const strip = (text: string) => text.replace(/<(skills|plugins|user_rules)>[\s\S]*?<\/\1>/gi, '');
    system = strip(system);
    contents = contents.map((content: any) => ({ ...content, parts: (content.parts || []).map((part: any) => typeof part.text === 'string' ? { ...part, text: strip(part.text) } : part) }));
  }
  let mapped = mapContentsToMessages(contents, system);
  Object.assign(mapped, mapGenerationConfig(input.generationConfig));
  mapped.tools = mapTools(input.tools || []);
  injectContext(mapped, config.contextStripMode);
  mapped = await compactIfNeeded(mapped, model, getRouter(), controller.signal);
  if (controller.signal.aborted) return;
  // Never share reasoning or sessions across unrelated clients/conversations.
  const suppliedId = req.headers['x-antigravity-conversation-id'] || body.conversationId || input.conversationId || body.requestId;
  const conversation = typeof suppliedId === 'string' && suppliedId ? extractConvId(suppliedId) : randomUUID();
  injectReasoning(mapped.messages, conversation);
  const session = getSessionId(conversation) || randomUUID();
  setSessionId(conversation, session);
  (mapped.providerOptions ||= {} as any as NonNullable<typeof mapped.providerOptions>);
  (mapped.providerOptions as any).sessionId = session;
  const id = randomUUID(), start = Date.now(), now = new Date().toISOString();
  const promptTokens = estimateTokens(JSON.stringify(mapped));
  const fullPrompt = JSON.stringify(input.contents);
  db.upsertSession(conversation, { startedAt: now });
  requestStore.push({ id: `${id}:in`, sessionId: conversation, timestamp: now, model, resolvedModel: '', direction: 'incoming', type: 'text', content: fullPrompt, promptTokens: 0, requestInput: requestSnapshot });
  let text = '', thought = '', provider = '', resolvedModel = model;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const attempts: unknown[] = [];
  const emit = async (parts: unknown[], finish = false) => {
    const chunk = { candidates: [{ index: 0, content: { role: 'model', parts }, ...(finish ? { finishReason: 'STOP' } : {}) }], modelVersion: resolvedModel, responseId: id,
      ...(finish ? { usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: estimateTokens(text + thought), totalTokenCount: promptTokens + estimateTokens(text + thought) } } : {}) };
    if (streaming) {
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      if (!res.write(`data: ${JSON.stringify(chunk)}\n\n`)) await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve); });
    } else if (finish) json(res, 200, chunk);
  };
  try {
    for await (const chunk of streamResponse(mapped, model, controller.signal)) {
      if (controller.signal.aborted) return;
      if (chunk.provider) provider = chunk.provider;
      if (chunk.resolvedModel) resolvedModel = chunk.resolvedModel;
      if ('sessionId' in chunk && chunk.sessionId) setSessionId(conversation, chunk.sessionId);
      if (chunk.type === 'attempt') { attempts.push(chunk); continue; }
      if (chunk.type === 'tool-call') calls.push({ name: chunk.name, args: chunk.args });
      if (chunk.type === 'text') { text += chunk.content; if (streaming) await emit([{ text: chunk.content }]); }
      if (chunk.type === 'thought') { thought += chunk.content; if (streaming) await emit([{ thought: true, text: chunk.content }]); }
    }
    if (controller.signal.aborted) return;
    if (thought) saveReasoning(conversation, thought);
    const parts: unknown[] = [];
    if (!streaming && text) parts.push({ text });
    if (!streaming && thought) parts.push({ thought: true, text: thought });
    for (const call of calls) parts.push({ functionCall: call });
    await emit(parts, true);
    if (streaming) res.end();
    const outputTokens = estimateTokens(text + thought);
    requestStore.push({ id: `${id}:out`, sessionId: conversation, timestamp: new Date().toISOString(), model, resolvedModel, provider, direction: 'outgoing', type: calls.length ? 'tool-call' : 'text', content: text, toolCalls: calls, promptTokens, outputTokens,
      duration: Date.now() - start, cost: calculateCost(provider, resolvedModel, promptTokens, outputTokens), failoverEvents: JSON.stringify(attempts) });
    db.upsertSession(conversation, { endedAt: new Date().toISOString(), requestCount: db.getSessionContent(conversation).filter((r:any) => r.direction === 'outgoing').length });
  } catch (error: any) {
    requestStore.push({ id: `${id}:out`, sessionId: conversation, timestamp: new Date().toISOString(), model, resolvedModel, provider, direction: 'outgoing', type: 'error', content: '', error: controller.signal.aborted ? 'client_abort' : error.message, duration: Date.now() - start });
    if (controller.signal.aborted) return;
    if (res.headersSent) { res.end(`data: ${JSON.stringify({ error: { code: error.status || 502, message: error.message } })}\n\n`); }
    else throw error;
  }
}

export interface GatewayInstance { generationPort: number; dashboardPort: number; host: string; close(): Promise<void> }

export async function startGateway(): Promise<GatewayInstance> {
  const host = process.env.AG_GATEWAY_HOST || '127.0.0.1';
  if (!isLoopback(host) && process.env.AG_GATEWAY_REMOTE !== 'true') throw new Error('Non-loopback binding requires AG_GATEWAY_REMOTE=true');
  if ((process.env.AG_GATEWAY_TOKEN || '').length < 16) throw new Error('AG_GATEWAY_TOKEN must contain at least 16 characters');
  if (!config.dashboardUser || config.dashboardPassword.length < 16) throw new Error('Dashboard credentials are required (password at least 16 characters)');
  for (const value of [config.proxyPort, config.apiPort]) if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Invalid listening port');
  setRateLimitConfig({ globalMax: config.rateLimitGlobal, providerMax: config.rateLimitProvider, windowMs: config.rateLimitWindow });
  try { const models = JSON.parse(fs.readFileSync(dataFile('models.json'), 'utf8')); loadContextWindowsFromModels(models._context_windows || {}); } catch { /* optional */ }
  let instance: GatewayInstance;
  const endpoint = http.createServer(async (req, res) => {
    try {
      if (!secureOrigin(req, host)) { json(res, 403, { error: 'Origin or host rejected' }); return; }
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { status: 'ok', service: 'antigravity-model-gateway', uptime: process.uptime() }); return; }
      if (!authorized(req)) { json(res, 401, { error: 'Gateway bearer token required' }); return; }
      if (req.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1beta/models')) {
        json(res, 200, listGatewayModels(`http://${req.headers.host}`)); return;
      }
      if (req.method === 'POST' && url.pathname === '/admin/shutdown') { json(res, 200, { ok: true }); setTimeout(() => void instance.close(), 25).unref(); return; }
      const match = /^\/v1(?:beta)?\/models\/(.+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
      if (req.method !== 'POST' || !match) { json(res, 404, { error: 'Unknown gateway endpoint' }); return; }
      await generate(req, res, decodeURIComponent(match[1]), match[2] === 'streamGenerateContent');
    } catch (error: any) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 502, { error: { message: error.message, code: error.status || 502 } });
      else if (!res.writableEnded) res.end();
    }
  });
  const dashboardHandler = createDashboardHandler({ replay: async (input, model, signal) => {
    const targetHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
    const authority = `${targetHost.includes(':') ? `[${targetHost}]` : targetHost}:${instance.generationPort}`;
    const response = await fetch(`http://${authority}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.AG_GATEWAY_TOKEN}`, 'x-antigravity-conversation-id': `replay-${randomUUID()}` }, body: JSON.stringify(input),
    });
    const value = await response.json() as any;
    if (!response.ok) throw Object.assign(new Error(value.error?.message || 'Replay generation failed'), { status: response.status });
    return value;
  } });
  const dashboard = http.createServer(async (req, res) => {
    try {
      if (!secureOrigin(req, host)) { json(res, 403, { error: 'Origin or host rejected' }); return; }
      if (!config.dashboardUser || config.dashboardPassword.length < 16) { json(res, 503, { error: 'Dashboard credentials need repair in the local gateway config' }); return; }
      await dashboardHandler(req, res);
    } catch (error: any) {
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'Invalid dashboard request' });
      else if (!res.writableEnded) res.end();
    }
  });
  const listen = (server: http.Server, port: number) => new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve((server.address() as any).port); });
  });
  let generationPort: number, dashboardPort: number;
  try { generationPort = await listen(endpoint, config.proxyPort); dashboardPort = await listen(dashboard, config.apiPort); }
  catch (error) { endpoint.close(); dashboard.close(); throw error; }
  let closed = false;
  instance = { generationPort, dashboardPort, host, async close() {
    if (closed) return; closed = true;
    for (const server of [endpoint, dashboard]) { server.closeAllConnections(); server.close(); }
    await httpPool.closeAll();
    try { fs.unlinkSync(path.join(USER_DATA_DIR, 'runtime.json')); } catch { /* no runtime record */ }
    db.close();
  } };
  fs.writeFileSync(path.join(USER_DATA_DIR, 'runtime.json'), JSON.stringify({ pid: process.pid, generationPort, dashboardPort, host, startedAt: new Date().toISOString() }), { mode: 0o600 });
  logger.info(`Gateway http://${host}:${generationPort}; dashboard http://${host}:${dashboardPort}`);
  return instance;
}
