/** Custom-model integration installed alongside the current vendor desktop runtime. */
import { app, dialog, session } from 'electron';
import { registerCustomModelHandlers } from './customIpc';
import { getProxyPort, stopProxy } from './proxy';

let installed = false;

export function install(getLanguageServerPort: () => number): void {
  if (installed) return;
  installed = true;
  registerCustomModelHandlers();

  // Registered before the vendor's ready callback, without replacing its startup,
  // updater, WSL integration, certificate policy, or window configuration.
  void app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const proxyPort = getProxyPort();
      const lsPort = getLanguageServerPort();
      if (!proxyPort || !lsPort) return callback({});
      const url = new URL(details.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        Number(url.port) !== lsPort
      ) {
        return callback({});
      }
      if (/(?:\/|\.)LanguageServerService\/SetCloudCodeURL$/.test(url.pathname)) {
        callback({ cancel: true });
      } else if (/(?:\/|\.)LanguageServerService\/GetAvailableModels$/.test(url.pathname)) {
        (callback as (value: { redirectURL: string }) => void)({
          redirectURL: `http://127.0.0.1:${proxyPort}/GetAvailableModels?ls=${encodeURIComponent(details.url)}`,
        });
      } else callback({});
    });
  });

  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3 || win.isDestroyed()) return;
      console.error('[Model Patch] Desktop page failed to load:', code, description);
      dialog.showErrorBox(
        'Antigravity could not load',
        `${description} (${code})\n\nCheck the Electron and language-server logs. ` +
          'If this began after an update, reinstall a clean vendor build and run the patch preflight again.',
      );
    });
    win.webContents.on('preload-error', (_event, _preload, error) => {
      console.error('[Model Patch] Preload failed:', error);
    });
  });
  app.on('will-quit', () => {
    void stopProxy();
  });
}
