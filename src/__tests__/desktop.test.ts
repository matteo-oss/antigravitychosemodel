import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync('src/desktop.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

async function fixture(proxyPort = 50999, lsPort = 54321) {
  const events = new Map<string, (...args: unknown[]) => void>();
  let intercept: (details: { url: string }, callback: ReturnType<typeof vi.fn>) => void;
  const register = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  const showErrorBox = vi.fn();
  const exported: { install?: (getPort: () => number) => void } = {};
  const dependencies = {
    electron: {
      app: { whenReady: () => Promise.resolve(), on: (name, fn) => events.set(name, fn) },
      session: { defaultSession: { webRequest: { onBeforeRequest: (fn) => (intercept = fn) } } },
      dialog: { showErrorBox },
    },
    './customIpc': { registerCustomModelHandlers: register },
    './proxy': { getProxyPort: () => proxyPort, stopProxy: stop },
  };
  runInNewContext(compiled, { exports: exported, require: (name) => dependencies[name], URL, console });
  exported.install!(() => lsPort);
  exported.install!(() => lsPort);
  await Promise.resolve();
  return {
    events,
    register,
    stop,
    showErrorBox,
    request(url: string) {
      const callback = vi.fn();
      intercept!({ url }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0][0];
    },
  };
}

describe('additive desktop integration', () => {
  const route = '/exa.language_server_pb.LanguageServerService/';

  it('registers only once, redirects local model lists and leaves generation to the LS', async () => {
    const f = await fixture();
    expect(f.register).toHaveBeenCalledTimes(1);
    const url = `https://127.0.0.1:54321${route}GetAvailableModels`;
    expect(f.request(url)).toEqual({
      redirectURL: `http://127.0.0.1:50999/GetAvailableModels?ls=${encodeURIComponent(url)}`,
    });
    expect(f.request(`https://127.0.0.1:54321${route}SetCloudCodeURL`)).toEqual({ cancel: true });
    expect(f.request(`https://127.0.0.1:54321${route}GenerateContent`)).toEqual({});
  });

  it.each([
    'https://example.com:54321',
    'https://127.0.0.1:11111',
    'http://127.0.0.1:50999',
    'https://localhost.evil.example:54321',
  ])('does not intercept other origins: %s', async (origin) => {
    const f = await fixture();
    expect(f.request(`${origin}${route}GetAvailableModels`)).toEqual({});
    expect(f.request(`${origin}${route}SetCloudCodeURL`)).toEqual({});
  });

  it.each([
    [0, 54321],
    [50999, 0],
  ])('passes through without both local services (proxy %s, LS %s)', async (proxy, ls) => {
    const f = await fixture(proxy, ls);
    expect(f.request(`https://127.0.0.1:54321${route}SetCloudCodeURL`)).toEqual({});
  });

  it('closes its proxy on exit', async () => {
    const f = await fixture();
    f.events.get('will-quit')!();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('reports document load failures while ignoring subframes and canceled navigation', async () => {
    const f = await fixture();
    const events = new Map<string, (...args: unknown[]) => void>();
    f.events.get('browser-window-created')!(
      {},
      {
        isDestroyed: () => false,
        webContents: { on: (name, callback) => events.set(name, callback) },
      },
    );
    const onFailed = events.get('did-fail-load')!;
    onFailed({}, -3, 'ERR_ABORTED', '', true);
    onFailed({}, -202, 'ERR_CERT_AUTHORITY_INVALID', '', false);
    expect(f.showErrorBox).not.toHaveBeenCalled();
    onFailed({}, -202, 'ERR_CERT_AUTHORITY_INVALID', '', true);
    expect(f.showErrorBox).toHaveBeenCalledWith(
      'Antigravity could not load',
      expect.stringContaining('ERR_CERT_AUTHORITY_INVALID'),
    );
  });
});
