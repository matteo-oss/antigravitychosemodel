import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getContextWindow, setContextWindow, loadContextWindowsFromModels } from '../src/context-windows.js';

describe('ContextWindowRegistry', () => {
  it('returns default 128000 for unknown models', () => {
    assert.equal(getContextWindow('unknown-model'), 128000);
  });

  it('returns configured value for known model', () => {
    setContextWindow('gpt-4o', 128000);
    assert.equal(getContextWindow('gpt-4o'), 128000);
  });

  it('loads from models.json _context_windows', () => {
    const windows = { 'claude-sonnet-4': 200000, 'gpt-4o': 128000 };
    loadContextWindowsFromModels(windows);
    assert.equal(getContextWindow('claude-sonnet-4'), 200000);
    assert.equal(getContextWindow('gpt-4o'), 128000);
  });

  it('manual override takes precedence over loaded values', () => {
    loadContextWindowsFromModels({ 'model-a': 100000 });
    setContextWindow('model-a', 200000);
    assert.equal(getContextWindow('model-a'), 200000);
  });
});