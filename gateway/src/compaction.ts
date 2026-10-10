import { logger } from './logger.js';
import { estimateMessageTokens, estimateSystemTokens, estimateToolTokens } from './token-estimator.js';
import type { OpenAIMessage, MappedRequest } from './mapper.js';
import type { Router } from './router.js';
import { config } from './config.js';
import { getContextWindow } from './context-windows.js';
import { modelResolver } from './models.js';

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TAIL_TURNS = 2;

const SUMMARIZATION_TEMPLATE = `You are a conversation summarizer. Summarize the following conversation history into a structured format. Preserve all important context, decisions, and current state.

Output format:
## Objective
- [what the user is trying to accomplish]

## Important Details
- [constraints, decisions, facts, assumptions]

## Work State
- Completed: [finished work, verified facts]
- Active: [current work, partial changes]
- Blocked: [blockers, failing commands]

## Next Move
1. [immediate concrete action]
2. [next action if known]

Conversation to summarize:
`;

export function needsCompaction(
  system: string,
  messages: OpenAIMessage[],
  tools?: Record<string, unknown>,
  contextWindow?: number,
  threshold: number = DEFAULT_THRESHOLD,
): boolean {
  if (threshold <= 0 || threshold >= 1) return false;
  const window = contextWindow || 128000;
  const maxTokens = Math.floor(window * threshold);
  const systemTokens = estimateSystemTokens(system);
  const messageTokens = estimateMessageTokens(messages);
  const toolTokens = estimateToolTokens(tools);
  const totalTokens = systemTokens + messageTokens + toolTokens;
  return totalTokens > maxTokens;
}

export function selectMessagesToCompact(
  messages: OpenAIMessage[],
  tailTurns: number = DEFAULT_TAIL_TURNS,
): { toCompact: OpenAIMessage[]; toPreserve: OpenAIMessage[] } {
  // Each turn is a user + assistant pair (2 messages)
  const preserveCount = tailTurns * 2;
  if (messages.length <= preserveCount) {
    return { toCompact: [], toPreserve: messages };
  }
  let boundary = messages.length - preserveCount;
  // Keep a tool-call assistant message together with every corresponding result.
  while (boundary > 0 && messages[boundary]?.role === 'tool') boundary--;
  const toPreserve = messages.slice(boundary);
  const toCompact = messages.slice(0, boundary);
  return { toCompact, toPreserve };
}

export function buildSummarizationPrompt(messages: OpenAIMessage[]): string {
  const serialized = messages.map(msg => {
    const role = msg.role === 'user' ? '[User]' : '[Assistant]';
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return `${role}: ${content}${msg.tool_calls ? '\nTool calls: ' + JSON.stringify(msg.tool_calls) : ''}`;
  }).join('\n\n');
  return SUMMARIZATION_TEMPLATE + serialized;
}

/**
 * Attempt LLM-powered compaction. Falls back to truncation on failure.
 * Returns the mapped request with messages compacted if needed.
 */
export async function compactIfNeeded(
  mapped: MappedRequest,
  model: string,
  router: Router,
  signal?: AbortSignal,
): Promise<MappedRequest> {
  const cfg = getCompactionConfig();
  if (!cfg.enabled) return mapped;

  const contextWindow = getContextWindow(model);
  const system = mapped.system || '';
  const tools = mapped.tools as Record<string, unknown> | undefined;

  if (!needsCompaction(system, mapped.messages, tools, contextWindow, cfg.threshold)) {
    return mapped;
  }

  logger.info(`[compaction] Compaction needed for model ${model} (window: ${contextWindow})`);

  const { toCompact, toPreserve } = selectMessagesToCompact(mapped.messages, cfg.tailTurns);
  if (toCompact.length === 0) return mapped;

  const prompt = buildSummarizationPrompt(toCompact);
  const compactionModel = cfg.model || model;

  try {
    const providerIds = config.providerPriority;
    // Use router's execute to get a non-streaming summary
    let summary = '';
    const gen = router.execute(
      providerIds,
      compactionModel,
      [{ role: 'user', content: prompt }],
      undefined,
      { maxTokens: 2048, temperature: 0.3 },
      signal,
    );

    for await (const chunk of gen) {
      if (chunk.type === 'text') summary += chunk.content || '';
      if (chunk.type === 'error') throw new Error(chunk.content || 'compaction LLM error');
    }

    if (!summary.trim()) {
      throw new Error('Empty summary from LLM');
    }

    logger.info(`[compaction] LLM summary obtained (${summary.length} chars)`);

    const compactedMessages: OpenAIMessage[] = [
      { role: 'user', content: `[Context compacted]\n${summary}` },
      ...toPreserve,
    ];

    return { ...mapped, messages: compactedMessages };
  } catch (err: any) {
    if (signal?.aborted) throw err;
    logger.warn(`[compaction] LLM summarization failed, falling back to truncation: ${err.message}`);
    const fallbackMessages: OpenAIMessage[] = [
      { role: 'user', content: '[Context compacted - earlier conversation truncated]' },
      ...toPreserve,
    ];
    return { ...mapped, messages: fallbackMessages };
  }
}

export function getCompactionConfig() {
  return {
    enabled: process.env.COMPACTION_ENABLED !== 'false' && modelResolver.compactionEnabled,
    threshold: parseFloat(process.env.COMPACTION_THRESHOLD || String(modelResolver.compactionThreshold)),
    tailTurns: parseInt(process.env.COMPACTION_TAIL_TURNS || String(modelResolver.compactionTailTurns), 10),
    model: process.env.COMPACTION_MODEL || modelResolver.compactionModel,
  };
}
