import type { ChatMessage, GenerateRequest, LLMProvider } from './providers/types.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('conversation');

/**
 * Cap on the synthetic summary turn's own output so prepending it can never
 * re-blow the token budget the way an unbounded summary could.
 */
const SUMMARY_MAX_TOKENS = 300;

/**
 * Bound the summarization LLM call itself — a slow/hanging summarization
 * provider must never stall the user's turn. On timeout we fall back to the
 * deterministic marker exactly like any other summarization failure.
 */
const SUMMARY_TIMEOUT_MS = 8_000;

const SUMMARY_SYSTEM_PROMPT =
  'Summarize the following conversation turns concisely, preserving names, decisions, and facts. Keep the summary under 200 words.';

export interface WorkingMemoryTrimOptions {
  /** Token budget the returned window (plus system prompt + media) must fit under. */
  tokenBudget: number;
  /** Length (chars) of the system prompt already accounted for in the token estimate. */
  systemPromptLength: number;
  /** Extra token estimate contributed by attached media (e.g. images * 1000). */
  mediaTokenEstimate: number;
  /** Config gate (#1445 QR-010). When false, overflow is dropped with a deterministic marker — never summarized, never silently lost. */
  summarizationEnabled: boolean;
  /** Provider used for the (single) summarization call. Reuses the chat runtime's existing provider path. */
  provider: LLMProvider;
  /**
   * Lazily resolves the model to use for the summarization call. Only invoked
   * when a call will actually happen (over budget, enabled) — an under-budget
   * turn or a disabled gate never pays for model resolution.
   */
  resolveSummarizationModel: () => Promise<string> | string;
  traceId?: string;
}

export interface WorkingMemoryTrimResult {
  /** The (possibly trimmed + summarized/marked) window, ready to have the current turn appended. */
  window: ChatMessage[];
  /** Count of original turns removed from the front of the window. */
  trimmedMessages: number;
  /** True when an LLM summary was produced and prepended; false when nothing was trimmed, or the marker fallback was used. */
  summarized: boolean;
  /** Token estimate of the returned window (systemPrompt + media + window content), for logging. */
  estimatedTokens: number;
}

function estimateTokens(
  window: ChatMessage[],
  systemPromptLength: number,
  mediaTokenEstimate: number,
): number {
  const windowContentLength = window.reduce((sum, m) => sum + m.content.length, 0);
  return (systemPromptLength + windowContentLength) / 4 + mediaTokenEstimate;
}

/**
 * Providers (notably Anthropic's Messages API) require the message list to
 * strictly alternate user/assistant with no consecutive same-role turns.
 * `loadConversationWindow` already guarantees `remaining` alternates
 * internally, and the caller always appends a `user` turn after this
 * function returns (the current incoming message) — so the synthetic turn's
 * role must be the OPPOSITE of `remaining[0]` (or, if `remaining` is empty,
 * 'assistant', to alternate correctly with that trailing user turn).
 */
function syntheticTurnRole(remaining: ChatMessage[]): ChatMessage['role'] {
  return remaining[0]?.role === 'assistant' ? 'user' : 'assistant';
}

/** Deterministic, human-readable marker recording how many turns were dropped — never silent. */
function markerTurn(droppedCount: number, remaining: ChatMessage[]): ChatMessage {
  return { role: syntheticTurnRole(remaining), content: `[${droppedCount} earlier turns omitted]` };
}

/**
 * Summarize-before-trim (#1445 QR-010).
 *
 * Replaces the silent FIFO `window.shift()` token-budget trim: collects the
 * contiguous oldest turns that must be removed to fit `tokenBudget`, then —
 * unless disabled or the LLM call fails — summarizes them in ONE cheap call
 * and prepends the bounded summary as a synthetic turn, so context is
 * compressed rather than silently lost. On any failure (timeout, thrown
 * error, empty output, or a summary that itself doesn't fit) falls back to a
 * deterministic marker turn recording how many turns were dropped.
 *
 * Never loops forever: at most one summarization attempt is made per call,
 * and the fallback-marker path is a single deterministic step, not a retry
 * loop. The newest (non-overflow) turns are always preserved verbatim.
 */
export async function summarizeWindowBeforeTrim(
  window: ChatMessage[],
  options: WorkingMemoryTrimOptions,
): Promise<WorkingMemoryTrimResult> {
  const { tokenBudget, systemPromptLength, mediaTokenEstimate, traceId } = options;
  const estimate = (win: ChatMessage[]) => estimateTokens(win, systemPromptLength, mediaTokenEstimate);

  if (estimate(window) <= tokenBudget || window.length <= 1) {
    return { window, trimmedMessages: 0, summarized: false, estimatedTokens: estimate(window) };
  }

  const remaining = [...window];
  const overflow: ChatMessage[] = [];
  while (estimate(remaining) > tokenBudget && remaining.length > 1) {
    overflow.push(remaining.shift() as ChatMessage);
  }

  if (overflow.length === 0) {
    // Down to a single (oversized) turn — nothing left we can drop or summarize.
    return { window: remaining, trimmedMessages: 0, summarized: false, estimatedTokens: estimate(remaining) };
  }

  const fallbackToMarker = (reason: string, extra?: Record<string, unknown>): WorkingMemoryTrimResult => {
    const withMarker = [markerTurn(overflow.length, remaining), ...remaining];
    log.warn({ traceId, droppedTurns: overflow.length, ...extra }, reason);
    return {
      window: withMarker,
      trimmedMessages: overflow.length,
      summarized: false,
      estimatedTokens: estimate(withMarker),
    };
  };

  if (!options.summarizationEnabled) {
    return fallbackToMarker('working memory: summarization disabled — using deterministic marker fallback');
  }

  try {
    const model = await options.resolveSummarizationModel();
    const transcript = overflow.map((m) => `${m.role}: ${m.content}`).join('\n');
    const request: GenerateRequest = {
      model,
      maxTokens: SUMMARY_MAX_TOKENS,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WORKING_MEMORY_SUMMARY_TIMEOUT')), SUMMARY_TIMEOUT_MS);
    });

    let summaryText: string;
    try {
      const result = await Promise.race([options.provider.generate(request), timeout]);
      summaryText = result.content?.trim() ?? '';
    } finally {
      clearTimeout(timer);
    }

    if (!summaryText) {
      return fallbackToMarker('working memory: summarization returned empty content — using deterministic marker fallback');
    }

    const summaryTurn: ChatMessage = {
      role: syntheticTurnRole(remaining),
      content: `[earlier conversation summary] ${summaryText}`,
    };
    const withSummary = [summaryTurn, ...remaining];

    if (estimate(withSummary) > tokenBudget) {
      return fallbackToMarker('working memory: summary still over budget — falling back to deterministic marker');
    }

    log.info(
      { traceId, droppedTurns: overflow.length },
      'working memory: summarized overflow turns before trim',
    );
    return {
      window: withSummary,
      trimmedMessages: overflow.length,
      summarized: true,
      estimatedTokens: estimate(withSummary),
    };
  } catch (err) {
    return fallbackToMarker(
      'working memory: summarization failed — falling back to deterministic marker',
      { err },
    );
  }
}
