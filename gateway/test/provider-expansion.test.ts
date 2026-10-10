import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BUILTIN_PROVIDERS, getProviderDefinition, getProviderApiKey } from '../src/provider-catalog.js';
import { fetchProviderModels, clearProviderCache, parseProviderModelDetails } from '../src/provider-cache.js';
import { registerBuiltinPlugins } from '../src/plugins/builtin-plugins.js';
import { providerRegistry } from '../src/provider-registry.js';
import { createAdapter } from '../src/adapter.js';
import { buildProviders } from '../src/config.js';
import { openAIEndpoint } from '../src/provider-endpoints.js';
import { httpPool } from '../src/http-pool.js';

const additions = [
  'together',
  'huggingface',
  'sambanova',
  'siliconflow',
  'novita',
  'dashscope',
  'deepseek',
  'mistral',
  'xai',
  'cerebras',
  'fireworks',
];
const servers: http.Server[] = [];
const changed = new Map<string, string | undefined>();
function env(key: string, value?: string) {
  if (!changed.has(key)) changed.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(async () => {
  for (const [key, value] of changed)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  changed.clear();
  clearProviderCache();
  providerRegistry.clearAdapterCache();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
after(() => httpPool.closeAll());
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('all additional providers register, resolve canonical env keys and preserve official endpoint prefixes', () => {
  registerBuiltinPlugins();
  for (const id of additions) {
    const definition = getProviderDefinition(id)!;
    assert.ok(definition, id);
    assert.ok(providerRegistry.hasProvider(id), id);
    env(definition.envKey, `${id}-fixture-secret`);
    const [configuration] = buildProviders([id]);
    assert.equal(configuration.enabled, true);
    assert.equal(configuration.apiKey, `${id}-fixture-secret`);
    assert.equal(openAIEndpoint(definition.baseUrl, 'chat/completions'), `${definition.baseUrl}/chat/completions`);
    assert.equal(providerRegistry.getAdapter(configuration).provider, id);
  }
  const hf = getProviderDefinition('huggingface')!;
  env(hf.envKey);
  env('HF_TOKEN', 'hf-fixture-token');
  assert.equal(getProviderApiKey(hf), 'hf-fixture-token');
  assert.equal(buildProviders(['huggingface'])[0].apiKey, 'hf-fixture-token');
  assert.equal(new Set(BUILTIN_PROVIDERS.map((item) => item.id)).size, BUILTIN_PROVIDERS.length);
  assert.equal(
    openAIEndpoint('https://example.invalid/v3/openai/chat/completions', 'models'),
    'https://example.invalid/v3/openai/models',
  );
  assert.throws(() => openAIEndpoint('https://user:password@example.invalid/v1', 'models'), /credentials/);
});

test('each new provider sends authenticated chat, reasoning, tools and SSE through its real registered adapter', async () => {
  registerBuiltinPlugins();
  for (const id of additions) {
    const definition = getProviderDefinition(id)!;
    let calls = 0;
    const origin = await serve(async (req, res) => {
      calls++;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, new URL(definition.baseUrl).pathname + '/chat/completions');
      assert.equal(req.headers.authorization, `Bearer ${id}-fixture-key`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(
        body.model,
        id === 'huggingface' ? 'org/model:fastest' : id === 'siliconflow' ? 'deepseek-ai/DeepSeek-V3.1' : 'org/model',
      );
      assert.equal(body.stream, true);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.tools[0].function.name, 'lookup');
      if (id === 'siliconflow') assert.equal(body.enable_thinking, false);
      if (calls === 1) {
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"choices":[{"delta":{"reasoning_content":"Plan"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"lookup","arguments":"{\\\"limit\\\":"}}]}}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"2}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        );
        res.end('data: [DONE]\n\n');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'JSON answer' } }] }));
      }
    });
    const adapter = createAdapter({
      id,
      priority: 0,
      enabled: true,
      apiKey: `${id}-fixture-key`,
      baseUrl: origin + new URL(definition.baseUrl).pathname,
    });
    const model =
      id === 'huggingface' ? 'org/model:fastest' : id === 'siliconflow' ? 'deepseek-ai/DeepSeek-V3.1' : 'org/model';
    const invoke = () =>
      adapter.stream(
        model,
        [{ role: 'user', content: 'Hi' }],
        { lookup: { parameters: { type: 'object' } } },
        {},
        undefined,
        'Keep this system instruction',
      );
    const streamed = [];
    for await (const chunk of invoke()) streamed.push(chunk);
    assert.equal(streamed.find((chunk) => chunk.type === 'text')?.content, 'Hello', id);
    assert.equal(streamed.find((chunk) => chunk.type === 'thought')?.content, 'Plan', id);
    assert.deepEqual(streamed.find((chunk) => chunk.type === 'tool-call')?.args, { limit: 2 }, id);
    const json = [];
    for await (const chunk of invoke()) json.push(chunk);
    assert.equal(json[0].content, 'JSON answer', id);
    assert.equal(calls, 2);
  }
});

test('discovers Together arrays, HF live provider metadata and standard model lists with correct authenticated URLs', async () => {
  for (const id of additions.filter((id) => !['dashscope', 'fireworks'].includes(id))) {
    const definition = getProviderDefinition(id)!;
    let requests = 0;
    const origin = await serve((req, res) => {
      requests++;
      assert.equal(req.method, 'GET');
      assert.equal(req.headers.authorization, `Bearer ${id}-key`);
      assert.equal(
        req.url,
        new URL(definition.baseUrl).pathname + '/models' + (id === 'siliconflow' ? '?sub_type=chat' : ''),
      );
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          id === 'together'
            ? [
                { id: 'chat-model', type: 'chat', display_name: 'Chat', context_length: 32768 },
                { id: 'embedding-model', type: 'embedding' },
              ]
            : id === 'huggingface'
              ? {
                  data: [
                    {
                      id: 'chat-model',
                      architecture: { input_modalities: ['text', 'image'] },
                      providers: [
                        { provider: 'a', status: 'live', context_length: 64000, supports_tools: true },
                        { provider: 'b', status: 'live', context_length: 32000, supports_tools: false },
                        { provider: 'c', status: 'error', context_length: 1000 },
                      ],
                    },
                    { id: 'offline-model', providers: [{ status: 'error' }] },
                  ],
                }
              : { data: [{ id: 'chat-model' }, { id: 'chat-model' }, { id: null }] },
        ),
      );
    });
    env(definition.baseUrlEnv, origin + new URL(definition.baseUrl).pathname);
    const result = await fetchProviderModels(id, `${id}-key`);
    assert.equal(result.error, undefined, id);
    assert.deepEqual(result.models, ['chat-model'], id);
    if (id === 'huggingface')
      assert.deepEqual(result.modelDetails?.[0], {
        id: 'chat-model',
        supportsVision: true,
        contextWindow: 32000,
        supportsTools: false,
      });
    if (id === 'together') assert.equal(result.modelDetails?.[0].contextWindow, 32768);
    await fetchProviderModels(id, `${id}-key`);
    assert.equal(requests, 1, 'same credentials use cache');
  }
});

test('DashScope and Fireworks discover separate same-origin paginated catalogs and keep canonical model IDs', async () => {
  for (const id of ['dashscope', 'fireworks']) {
    const definition = getProviderDefinition(id)!;
    const urls: URL[] = [];
    const origin = await serve((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      urls.push(url);
      assert.equal(req.headers.authorization, 'Bearer list-key');
      assert.equal(url.pathname, id === 'dashscope' ? '/api/v1/models' : '/v1/accounts/fireworks/models');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          id === 'dashscope'
            ? {
                output: {
                  total: 2,
                  models: [
                    {
                      model: `qwen-${urls.length}`,
                      name: 'Human name',
                      model_info: { context_window: 128000 },
                      inference_metadata: { request_modality: ['Text', 'Image'] },
                      features: ['function-calling'],
                    },
                  ],
                },
              }
            : {
                models: [
                  {
                    name: `accounts/fireworks/models/model-${urls.length}`,
                    supportsServerless: true,
                    contextLength: 16384,
                    state: 'READY',
                  },
                ],
                ...(urls.length === 1 ? { nextPageToken: 'opaque/next?token' } : {}),
              },
        ),
      );
    });
    env(definition.baseUrlEnv, origin + new URL(definition.baseUrl).pathname);
    const result = await fetchProviderModels(id, 'list-key');
    assert.equal(result.error, undefined);
    assert.equal(result.models.length, 2);
    assert.equal(urls.length, 2);
    if (id === 'dashscope') {
      assert.equal(urls[0].searchParams.get('capabilities'), 'TG');
      assert.equal(urls[1].searchParams.get('page_no'), '2');
      assert.deepEqual(result.models, ['qwen-1', 'qwen-2']);
      assert.equal(result.modelDetails?.[0].supportsVision, true);
    } else {
      assert.equal(urls[0].searchParams.get('pageSize'), '200');
      assert.equal(urls[1].searchParams.get('pageToken'), 'opaque/next?token');
      assert.deepEqual(result.models, ['accounts/fireworks/models/model-1', 'accounts/fireworks/models/model-2']);
    }
  }
});

test('discovery cache is isolated by credentials and origin; metadata does not invent unknown HF limits', async () => {
  const origin = await serve((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: req.headers.authorization }] }));
  });
  env('DEEPSEEK_BASE_URL', origin + '/v1');
  assert.deepEqual((await fetchProviderModels('deepseek', 'one')).models, ['Bearer one']);
  assert.deepEqual((await fetchProviderModels('deepseek', 'two')).models, ['Bearer two']);
  const different = await serve((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[{"id":"other-origin"}]}');
  });
  env('DEEPSEEK_BASE_URL', different + '/v1');
  assert.deepEqual((await fetchProviderModels('deepseek', 'two')).models, ['other-origin']);
  assert.deepEqual(
    parseProviderModelDetails('huggingface', {
      data: [{ id: 'org/model', providers: [{ status: 'live', context_length: 100000 }, { status: 'live' }] }],
    }),
    [{ id: 'org/model' }],
  );
});

test('generation and discovery reject redirects without contacting their destination', async () => {
  let destinationRequests = 0;
  const destination = await serve((_req, res) => {
    destinationRequests++;
    res.end('{}');
  });
  const redirect = await serve((_req, res) => {
    res.writeHead(307, { location: destination + '/capture' });
    res.end();
  });
  env('TOGETHER_BASE_URL', redirect + '/v1');
  const discovery = await fetchProviderModels('together', 'redirect-secret', true);
  assert.ok(discovery.error);
  assert.ok(!JSON.stringify(discovery).includes('redirect-secret'));
  const adapter = createAdapter({
    id: 'together',
    priority: 0,
    enabled: true,
    apiKey: 'redirect-secret',
    baseUrl: redirect + '/v1',
  });
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream('test', [{ role: 'user', content: 'hi' }])) {
    }
  });
  assert.equal(destinationRequests, 0);
});

test('filters explicitly non-chat models and extracts current DeepSeek capability fields', () => {
  assert.deepEqual(
    parseProviderModelDetails('deepseek', {
      data: [
        {
          id: 'chat',
          name: 'DeepSeek Chat',
          context_window: 64000,
          max_output_tokens: 4096,
          input_modalities: ['text', 'image'],
          private_field: 'never-copy',
        },
        { id: 'audio', architecture: { output_modalities: ['audio'] } },
        { id: 'embed', type: 'embedding' },
        { id: 'rank', type: 'rerank' },
        { id: 'image', type: 'image' },
      ],
    }),
    [{ id: 'chat', displayName: 'DeepSeek Chat', contextWindow: 64000, maxOutputTokens: 4096, supportsVision: true }],
  );
});

test('special model catalogs accept root /v1 and full chat endpoint overrides on the same origin', async () => {
  for (const id of ['dashscope', 'fireworks']) {
    const seen: string[] = [];
    const origin = await serve((req, res) => {
      seen.push(new URL(req.url!, 'http://localhost').pathname);
      res.setHeader('content-type', 'application/json');
      res.end(id === 'dashscope' ? '{"output":{"models":[],"total":0}}' : '{"models":[]}');
    });
    for (const suffix of ['/v1', new URL(getProviderDefinition(id)!.baseUrl).pathname + '/chat/completions']) {
      env(getProviderDefinition(id)!.baseUrlEnv, origin + suffix);
      assert.equal((await fetchProviderModels(id, 'test-key', true)).error, undefined);
    }
    assert.deepEqual(seen, new Array(2).fill(id === 'dashscope' ? '/api/v1/models' : '/v1/accounts/fireworks/models'));
  }
});

test('DashScope rejects empty incomplete pages and continues full pages without a declared total', async () => {
  let requests = 0;
  let incomplete = true;
  const origin = await serve((_req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        incomplete
          ? { output: { total: 2, models: requests === 1 ? [{ model: 'first' }] : [] } }
          : {
              output: {
                models:
                  requests === 1
                    ? Array.from({ length: 100 }, (_, i) => ({ model: `model-${i}` }))
                    : [{ model: 'last' }],
              },
            },
      ),
    );
  });
  env('DASHSCOPE_BASE_URL', origin + '/compatible-mode/v1');
  const failed = await fetchProviderModels('dashscope', 'test-key');
  assert.ok(failed.error);
  assert.deepEqual(failed.models, []);
  assert.equal(requests, 2);
  incomplete = false;
  requests = 0;
  const complete = await fetchProviderModels('dashscope', 'test-key', true);
  assert.equal(complete.error, undefined);
  assert.equal(complete.models.length, 101);
  assert.equal(requests, 2);
});

test('discovery bounds both advertised/streamed payload size and model count', async () => {
  let mode = 'header';
  const origin = await serve((_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'header') {
      res.setHeader('content-length', String(4 * 1024 * 1024 + 1));
      res.end('{}');
    } else if (mode === 'body') {
      res.write(' '.repeat(4 * 1024 * 1024));
      res.end('{}');
    } else res.end(JSON.stringify({ data: Array.from({ length: 10001 }, (_, i) => ({ id: `model-${i}` })) }));
  });
  env('DEEPSEEK_BASE_URL', origin + '/v1');
  for (mode of ['header', 'body', 'count']) {
    const result = await fetchProviderModels('deepseek', 'bounded-secret', true);
    assert.ok(result.error, mode);
    assert.deepEqual(result.models, []);
    assert.ok(!JSON.stringify(result).includes('bounded-secret'));
  }
});
