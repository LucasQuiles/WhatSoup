/**
 * Loop protection: sliding-window guards against message amplification loops.
 *
 * Two complementary primitives:
 *
 * 1. createConversationLoopLimiter: per-conversation fixed-window rate limiter.
 *    Detects rapid-fire identical or near-identical messages from the same
 *    conversation before they amplify into queue overflow. When the threshold
 *    is hit, further messages from that conversation are dropped for a cooldown
 *    period.
 *
 * 2. createBotLoopGuard: global sliding-window guard against bot-to-bot loops.
 *    Tracks all outbound messages across all conversations. When the bot
 *    sends more than maxEventsPerWindow messages in windowSeconds, all outbound
 *    is paused for cooldownSeconds. Essential if the bot ever interacts with
 *    other bots that auto-reply, creating an infinite reply chain.
 *
 * Both primitives are in-memory and synchronous — designed to be checked on
 * every inbound/outbound message with negligible overhead.
 */

export type LoopDecision = 'allow' | 'block';

// ─── Per-conversation loop limiter ─────────────────────────────────────────

export interface ConversationLoopLimiterOptions {
  /** Max hits per window before triggering the limiter. Default: 5. */
  maxHitsPerWindow?: number;
  /** Max identical messages before triggering. Default: same as maxHitsPerWindow. */
  maxIdenticalPerWindow?: number;
  /** Window size in milliseconds. Default: 60_000. */
  windowMs?: number;
  /** Cooldown duration after triggering, in milliseconds. Default: 60_000. */
  cooldownMs?: number;
  /** Cleanup interval in milliseconds. Default: 120_000. */
  cleanupIntervalMs?: number;
  /** Whether to compare message text (detect identical-message loops). Default: true. */
  compareText?: boolean;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable timers. */
  setTimeout?: typeof setTimeout;
  clearInterval?: typeof clearInterval;
}

export interface ConversationLoopResult {
  decision: LoopDecision;
  /** Current hit count in the window (if allowed). */
  hitCount?: number;
  /** Remaining cooldown in ms (if blocked). */
  cooldownRemainingMs?: number;
  /** Reason for the decision. */
  reason: string;
}

export interface ConversationLoopLimiter {
  /** Check and record an inbound message. Returns 'allow' or 'block'. */
  check: (conversationKey: string, text?: string) => ConversationLoopResult;
  /** Reset the limiter for a specific conversation. */
  reset: (conversationKey: string) => void;
  /** Reset all conversations. */
  resetAll: () => void;
  /** Stop the cleanup timer. */
  stop: () => void;
}

interface ConversationState {
  hits: number[];
  lastText?: string;
  identicalCount: number;
  cooldownUntil: number;
}

export function createConversationLoopLimiter(
  options: ConversationLoopLimiterOptions = {},
): ConversationLoopLimiter {
  const maxHits = options.maxHitsPerWindow ?? 5;
  const maxIdentical = options.maxIdenticalPerWindow ?? maxHits;
  const windowMs = options.windowMs ?? 60_000;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 120_000;
  const compareText = options.compareText ?? true;
  const now = options.now ?? (() => Date.now());
  const _setTimeout = options.setTimeout ?? setTimeout;
  const _clearInterval = options.clearInterval ?? clearInterval;

  const conversations = new Map<string, ConversationState>();
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  const pruneHits = (state: ConversationState, nowMs: number) => {
    const cutoff = nowMs - windowMs;
    state.hits = state.hits.filter((t) => t > cutoff);
  };

  const cleanup = () => {
    const nowMs = now();
    for (const [key, state] of conversations) {
      pruneHits(state, nowMs);
      if (state.hits.length === 0 && state.cooldownUntil <= nowMs) {
        conversations.delete(key);
      }
    }
  };

  cleanupTimer = _setTimeout(function tick() {
    cleanup();
    cleanupTimer = _setTimeout(tick, cleanupIntervalMs);
  }, cleanupIntervalMs);

  const check: ConversationLoopLimiter['check'] = (conversationKey, text) => {
    const nowMs = now();
    let state = conversations.get(conversationKey);
    if (!state) {
      state = { hits: [], identicalCount: 0, cooldownUntil: 0 };
      conversations.set(conversationKey, state);
    }

    // Check cooldown
    if (state.cooldownUntil > nowMs) {
      return {
        decision: 'block',
        cooldownRemainingMs: state.cooldownUntil - nowMs,
        reason: 'cooldown active',
      };
    }

    // If cooldown just expired, reset hits for a fresh start
    if (state.cooldownUntil > 0 && state.cooldownUntil <= nowMs) {
      state.hits = [];
      state.identicalCount = 0;
      state.cooldownUntil = 0;
    }

    // Prune old hits
    pruneHits(state, nowMs);

    // Track identical text
    if (compareText && text !== undefined) {
      if (state.lastText !== undefined && text === state.lastText) {
        state.identicalCount++;
      } else {
        state.identicalCount = 0;
      }
      state.lastText = text;
    }

    // Check thresholds independently
    const rateExceeded = state.hits.length >= maxHits;
    const identicalExceeded = compareText && state.identicalCount >= maxIdentical;

    if (rateExceeded || identicalExceeded) {
      state.cooldownUntil = nowMs + cooldownMs;
      return {
        decision: 'block',
        cooldownRemainingMs: cooldownMs,
        reason: identicalExceeded && !rateExceeded
          ? 'identical-message loop threshold exceeded'
          : 'loop threshold exceeded',
      };
    }

    state.hits.push(nowMs);
    return {
      decision: 'allow',
      hitCount: state.hits.length,
      reason: 'within threshold',
    };
  };

  const reset: ConversationLoopLimiter['reset'] = (conversationKey) => {
    conversations.delete(conversationKey);
  };

  const resetAll: ConversationLoopLimiter['resetAll'] = () => {
    conversations.clear();
  };

  const stop: ConversationLoopLimiter['stop'] = () => {
    if (cleanupTimer !== null) {
      _clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  };

  return { check, reset, resetAll, stop };
}

// ─── Global bot loop guard ─────────────────────────────────────────────────

export interface BotLoopGuardOptions {
  /** Max outbound events per window before pausing. Default: 20. */
  maxEventsPerWindow?: number;
  /** Sliding window size in seconds. Default: 60. */
  windowSeconds?: number;
  /** Cooldown after triggering, in seconds. Default: 60. */
  cooldownSeconds?: number;
  /** Injectable clock. */
  now?: () => number;
}

export interface BotLoopGuardResult {
  decision: LoopDecision;
  /** Events in the current window (if allowed). */
  eventsInWindow?: number;
  /** Remaining cooldown in ms (if blocked). */
  cooldownRemainingMs?: number;
  reason: string;
}

export interface BotLoopGuard {
  /** Check and record an outbound event. Call before every send. */
  check: () => BotLoopGuardResult;
  /** Check without recording — useful for pre-flight decisions. */
  peek: () => BotLoopGuardResult;
  /** Manually trigger the cooldown (e.g., from an external signal). */
  triggerCooldown: (reason?: string) => void;
  /** Reset the guard (clear all events and cooldowns). */
  reset: () => void;
}

export function createBotLoopGuard(options: BotLoopGuardOptions = {}): BotLoopGuard {
  const maxEvents = options.maxEventsPerWindow ?? 20;
  const windowMs = (options.windowSeconds ?? 60) * 1_000;
  const cooldownMs = (options.cooldownSeconds ?? 60) * 1_000;
  const now = options.now ?? (() => Date.now());

  let events: number[] = [];
  let cooldownUntil = 0;

  const prune = (nowMs: number) => {
    const cutoff = nowMs - windowMs;
    events = events.filter((t) => t > cutoff);
  };

  const evaluate = (nowMs: number, record: boolean): BotLoopGuardResult => {
    if (cooldownUntil > nowMs) {
      return {
        decision: 'block',
        cooldownRemainingMs: cooldownUntil - nowMs,
        reason: 'global cooldown active',
      };
    }

    // If cooldown just expired, reset events for a fresh start
    if (cooldownUntil > 0 && cooldownUntil <= nowMs) {
      events = [];
      cooldownUntil = 0;
    }

    prune(nowMs);

    if (events.length >= maxEvents) {
      cooldownUntil = nowMs + cooldownMs;
      return {
        decision: 'block',
        cooldownRemainingMs: cooldownMs,
        reason: 'global event threshold exceeded',
      };
    }

    if (record) {
      events.push(nowMs);
    }

    return {
      decision: 'allow',
      eventsInWindow: events.length,
      reason: 'within threshold',
    };
  };

  const check: BotLoopGuard['check'] = () => evaluate(now(), true);
  const peek: BotLoopGuard['peek'] = () => evaluate(now(), false);

  const triggerCooldown: BotLoopGuard['triggerCooldown'] = (reason) => {
    cooldownUntil = now() + cooldownMs;
    events = [];
  };

  const reset: BotLoopGuard['reset'] = () => {
    events = [];
    cooldownUntil = 0;
  };

  return { check, peek, triggerCooldown, reset };
}
