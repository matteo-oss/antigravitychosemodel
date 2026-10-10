import { logger } from './logger.js';

const DEFAULT_CONTEXT_WINDOW = 128000;

const contextWindows = new Map<string, number>();
const manualOverrides = new Map<string, number>();

export function setContextWindow(model: string, tokens: number): void {
  manualOverrides.set(model, tokens);
}

export function getContextWindow(model: string): number {
  if (manualOverrides.has(model)) return manualOverrides.get(model)!;
  if (contextWindows.has(model)) return contextWindows.get(model)!;
  // Partial match: check if the model name starts with any key (prefix resolution)
  for (const [key, value] of contextWindows) {
    if (model.startsWith(key)) return value;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function loadContextWindowsFromModels(windows: Record<string, number>): void {
  for (const [model, tokens] of Object.entries(windows)) {
    if (!manualOverrides.has(model)) {
      contextWindows.set(model, tokens);
    }
  }
  logger.info(`[context-windows] Loaded ${Object.keys(windows).length} context window definitions`);
}

export function clearContextWindows(): void {
  contextWindows.clear();
  manualOverrides.clear();
}