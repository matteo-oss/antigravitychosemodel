/**
 * Anthropic Messages API over an OpenCode gateway base URL (Go /messages,
 * Zen /messages). Same protocol as AnthropicAdapter, but authenticates like
 * the gateway expects (Bearer + stable x-opencode-session + distinct UA)
 * and respects configured thinking effort.
 */

import { randomUUID } from 'crypto';
import { AnthropicAdapter } from './anthropic.js';

export class GatewayMessagesAdapter extends AnthropicAdapter {
  constructor(baseUrl: string, apiKey: string, gatewayProvider: string) {
    super(baseUrl, apiKey);
    this.provider = gatewayProvider;
  }

  protected override buildHeaders(config?: Record<string, unknown>): Record<string, string> {
    const sessionId = (config as any)?.providerOptions?.sessionId || randomUUID();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'x-opencode-session': String(sessionId),
      'User-Agent': 'antigravity-add-model-gateway/1.0.0',
    };
  }

}
