/**
 * Status reaction progress controller.
 *
 * Cycles emoji reactions on a user's inbound message to show turn progress:
 * queued (👀) → thinking (🤔) → tool-running (🔧) → done (✅) / error (❌).
 *
 * All three major chat platforms (WhatsApp, Signal, Telegram, Discord) support
 * reactions. This controller is platform-agnostic — it drives an adapter with
 * two methods: setReaction(emoji) and clearReaction(). The adapter translates
 * to platform-specific API calls.
 *
 * Key constraints modeled:
 * - Single-reaction-slot platforms (WhatsApp, Signal): only one reaction per
 *   message per user. Setting a new reaction implicitly replaces the old one.
 * - removeAckAfterReply: optionally clear the reaction after the final state.
 * - restoreInitial: optionally restore the initial emoji after clearing.
 * - Transition coalescing: rapid state changes don't fire redundant API calls.
 * - Error isolation: adapter failures don't propagate; they're reported via a
 *   callback so the main reply pipeline isn't blocked.
 */

export interface StatusReactionAdapter {
  /** Set the reaction to the given emoji (replaces any previous). */
  setReaction: (emoji: string) => Promise<void>;
  /** Clear the current reaction (set to empty / remove). */
  clearReaction: () => Promise<void>;
}

export type StatusReactionState =
  | 'queued'
  | 'thinking'
  | 'tool'
  | 'compacting'
  | 'done'
  | 'error'
  | 'stall-soft'
  | 'stall-hard';

export interface StatusReactionEmojis {
  queued: string;
  thinking: string;
  tool: string;
  compacting?: string;
  done: string;
  error: string;
  stallSoft?: string;
  stallHard?: string;
}

export interface StatusReactionControllerOptions {
  /** Emoji set for each state. */
  emojis: StatusReactionEmojis;
  /** If true, clear the reaction after the final state is set and optional delay. Default: true. */
  removeAfterFinalize?: boolean;
  /** Delay (ms) before clearing after finalize. Default: 3000. */
  removeDelayMs?: number;
  /** If true and removeAfterFinalize is false, restore the initial emoji after finalize. Default: false. */
  restoreInitialAfterFinalize?: boolean;
  /** Called when an adapter operation fails. The controller swallows the error internally. */
  onError?: (error: Error, context: string) => void;
  /** Injectable timers for testing. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface StatusReactionController {
  /** Set the current state and update the reaction emoji accordingly. */
  setState: (state: StatusReactionState) => void;
  /** Shorthand for setState('queued'). */
  setQueued: () => void;
  /** Shorthand for setState('thinking'). */
  setThinking: () => void;
  /** Shorthand for setState('tool'). */
  setTool: (toolName?: string) => void;
  /** Shorthand for setState('compacting'). */
  setCompacting: () => void;
  /** Shorthand for setState('stall-soft'). */
  setStallSoft: () => void;
  /** Shorthand for setState('stall-hard'). */
  setStallHard: () => void;
  /** Mark the turn as done (success). Triggers optional delayed clear. */
  setDone: () => void;
  /** Mark the turn as failed. Triggers optional delayed clear. */
  setError: () => void;
  /** Force-clear the reaction immediately, cancelling any pending timers. */
  clear: () => void;
  /** Get the current state. */
  getState: () => StatusReactionState | null;
  /** Get the current emoji. */
  getCurrentEmoji: () => string | null;
  /** Whether the controller has been finalized (done or error). */
  isFinalized: () => boolean;
}

export function createStatusReactionController(
  adapter: StatusReactionAdapter,
  options: StatusReactionControllerOptions,
): StatusReactionController {
  const removeAfterFinalize = options.removeAfterFinalize ?? true;
  const removeDelayMs = options.removeDelayMs ?? 3000;
  const restoreInitialAfterFinalize = options.restoreInitialAfterFinalize ?? false;
  const onError = options.onError ?? (() => {});
  const _setTimeout = options.setTimeout ?? setTimeout;
  const _clearTimeout = options.clearTimeout ?? clearTimeout;

  let currentState: StatusReactionState | null = null;
  let currentEmoji: string | null = null;
  let finalized = false;
  let cleared = false;
  let removeTimer: ReturnType<typeof setTimeout> | null = null;

  const resolveEmoji = (state: StatusReactionState): string => {
    const e = options.emojis;
    switch (state) {
      case 'queued': return e.queued;
      case 'thinking': return e.thinking;
      case 'tool': return e.tool;
      case 'compacting': return e.compacting ?? e.thinking;
      case 'done': return e.done;
      case 'error': return e.error;
      case 'stall-soft': return e.stallSoft ?? e.thinking;
      case 'stall-hard': return e.stallHard ?? e.stallSoft ?? e.error;
    }
  };

  const applyEmoji = async (emoji: string) => {
    if (currentEmoji === emoji) return; // coalesce redundant transitions
    currentEmoji = emoji;
    try {
      await adapter.setReaction(emoji);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)), `setReaction(${emoji})`);
    }
  };

  const doClear = async () => {
    currentEmoji = null;
    try {
      await adapter.clearReaction();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)), 'clearReaction');
    }
  };

  const scheduleRemoval = () => {
    if (removeTimer !== null) _clearTimeout(removeTimer);
    removeTimer = _setTimeout(() => {
      removeTimer = null;
      if (cleared) return; // clear() was called while this schedule was pending
      if (restoreInitialAfterFinalize) {
        void applyEmoji(options.emojis.queued);
      } else {
        void doClear();
      }
    }, removeDelayMs);
  };

  const setState = (state: StatusReactionState) => {
    // After finalize, only allow clear()
    if (finalized) return;
    currentState = state;

    // Terminal states
    if (state === 'done' || state === 'error') {
      finalized = true;
      void applyEmoji(resolveEmoji(state)).then(() => {
        if (removeAfterFinalize || restoreInitialAfterFinalize) {
          scheduleRemoval();
        }
      });
      return;
    }

    void applyEmoji(resolveEmoji(state));
  };

  const clear = () => {
    if (removeTimer !== null) {
      _clearTimeout(removeTimer);
      removeTimer = null;
    }
    cleared = true; // prevent any in-flight scheduleRemoval from firing
    finalized = true; // prevent further updates
    void doClear();
  };

  return {
    setState,
    setQueued: () => setState('queued'),
    setThinking: () => setState('thinking'),
    setTool: () => setState('tool'),
    setCompacting: () => setState('compacting'),
    setStallSoft: () => setState('stall-soft'),
    setStallHard: () => setState('stall-hard'),
    setDone: () => setState('done'),
    setError: () => setState('error'),
    clear,
    getState: () => currentState,
    getCurrentEmoji: () => currentEmoji,
    isFinalized: () => finalized,
  };
}

// ─── Presets ─────────────────────────────────────────────────────────────

export const DEFAULT_STATUS_REACTION_EMOJIS: StatusReactionEmojis = {
  queued: '👀',
  thinking: '🤔',
  tool: '🔧',
  compacting: '📦',
  done: '✅',
  error: '❌',
  stallSoft: '⏳',
  stallHard: '⏰',
};

export const MINIMAL_STATUS_REACTION_EMOJIS: StatusReactionEmojis = {
  queued: '👍',
  thinking: '👍',
  tool: '👍',
  done: '✅',
  error: '❌',
};

/**
 * Single-slot platforms (WhatsApp, Signal) allow only ONE reaction per message
 * per user. This means stallHard must equal stallSoft so a long-running turn
 * doesn't look like a hard failure.
 */
export function adaptEmojisForSingleSlot(emojis: StatusReactionEmojis): StatusReactionEmojis {
  return {
    ...emojis,
    stallHard: emojis.stallSoft ?? emojis.thinking,
  };
}
