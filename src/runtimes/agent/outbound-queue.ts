// src/runtimes/agent/outbound-queue.ts
// Serialized outbound queue for WhatsApp messages with batching and pacing.

import { createHash } from 'node:crypto';
import type { Messenger } from '../../core/types.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';
import { jitteredDelay } from '../../core/retry.ts';
import { canSendToGroup, recordGroupOutbound } from '../../core/echo-guard.ts';
import { config } from '../../config.ts';
import { markdownToWhatsApp, repairChunkFormatting } from './whatsapp-format.ts';
import type { ToolCategory } from './providers/tool-mapping.ts';
export type { ToolCategory } from './providers/tool-mapping.ts';
import type { ProgressEvent } from './operation-tracker.ts';

const log = createChildLogger('outbound-queue');

export interface ToolUpdate {
  category: ToolCategory;
  detail: string;
}

const TOOL_CATEGORY_META: Record<ToolCategory, { label: string; emoji: string }> = {
  reading:   { label: 'Reading',   emoji: '📖' },
  searching: { label: 'Searching', emoji: '🔎' },
  modifying: { label: 'Modifying', emoji: '✏️' },
  running:   { label: 'Running',   emoji: '🔧' },
  agent:     { label: 'Agent',     emoji: '🤖' },
  fetching:  { label: 'Fetching',  emoji: '🌐' },
  planning:  { label: 'Planning',  emoji: '📝' },
  skill:     { label: 'Skill',     emoji: '🧠' },
  other:     { label: 'Using',     emoji: '🛠️' },
  error:     { label: 'Error',     emoji: '⚠️' },
  blocked:   { label: 'Blocked',  emoji: '🚫' },
  cancelled: { label: 'Cancelled', emoji: '⏭️' },
};

/** User-friendly labels for 'friendly' mode — plain language, no jargon. */
const FRIENDLY_CATEGORY_META: Record<ToolCategory, { label: string; emoji: string }> = {
  reading:   { label: 'Looking at',       emoji: '👀' },
  searching: { label: 'Searching',        emoji: '🔍' },
  modifying: { label: 'Updating',         emoji: '✏️' },
  running:   { label: 'Working on',       emoji: '⚙️' },
  agent:     { label: 'Getting help from', emoji: '🤝' },
  fetching:  { label: 'Looking up',       emoji: '🌐' },
  planning:  { label: 'Planning',         emoji: '📋' },
  skill:     { label: 'Loading',          emoji: '📦' },
  other:     { label: 'Working on',       emoji: '⚙️' },
  error:     { label: 'Ran into an issue', emoji: '⚠️' },
  blocked:   { label: 'Paused',           emoji: '⏸️' },
  cancelled: { label: 'Skipped',          emoji: '⏭️' },
};

const MAX_MESSAGE_LENGTH = 4000;
// Exported so tests can import the exact values rather than hardcoding them.
// Changing a constant here will automatically break tests that rely on it.
export const TOOL_BATCH_DELAY_MS = 5000;
export const TOOL_BATCH_MAX_AGE_MS = 30_000;
export const MIN_SEND_GAP_MS = 500;
/** Re-assert composing every N ms — WA auto-clears the indicator on the recipient side after ~10-15s. */
export const TYPING_REFRESH_MS = 8_000;
export const SEND_TIMEOUT_MS = 15_000;
/** Delay before flushing aggregated text — batches streaming provider fragments. */
export const TEXT_AGGREGATE_DELAY_MS = 2_000;
/** Suppress repeated terminal/error text from respawn loops without affecting normal repeated assistant output. */
export const TERMINAL_TEXT_DEDUPE_WINDOW_MS = 5 * 60_000;
/**
 * Coalesce identical progress placeholders ("_Still working..._", etc.) within this window.
 * A parallel tool batch arms one slow/stall timer per tool, so several operations cross
 * their thresholds within seconds of each other and each renders the same placeholder text.
 * Without coalescing the user receives N identical messages back-to-back. The window is
 * wide enough to span a staggered batch yet short enough that a genuinely later nudge —
 * after real continued silence — still reaches the user.
 */
export const PROGRESS_TEXT_DEDUPE_WINDOW_MS = 30_000;
/**
 * Default persistent per-chat minimum spacing between progress placeholders.
 * Unlike PROGRESS_TEXT_DEDUPE_WINDOW_MS (a 30s per-TEXT window cleared every turn),
 * this floor is keyed on the conversation, survives flush()/abortTurn(), and is
 * checked BEFORE the text window — so it caps the total placeholder rate on long
 * turns regardless of text uniqueness or turn boundaries. Mirrors the proven
 * ReplyGuaranteeManager per-chat fallback floor. Per-instance override via
 * config.operationTracker.progressPlaceholderRateLimitMs (0 disables).
 */
export const PROGRESS_PLACEHOLDER_RATE_FLOOR_MS = 180_000;
/** Hard cap on the terminal-text dedup map so it can't grow unbounded between window prunes. */
const MAX_TERMINAL_TEXT_DEDUPE_KEYS = 1_000;

interface TerminalTextDedupeEntry {
  lastSeenAt: number;
  suppressedCount: number;
}

/**
 * Pre-process text for WhatsApp delivery:
 * 1. Convert markdown task-list syntax to checkbox characters
 * 2. Convert GitHub-flavored markdown to WhatsApp formatting
 */
function preprocessText(text: string): string {
  let out = text
    .replace(/^- \[x\] /gim, '▪︎ ')
    .replace(/^- \[X\] /gim, '▪︎ ')
    .replace(/^- \[ \] /gim, '▫︎ ');
  out = markdownToWhatsApp(out);
  return out;
}

/** Split a string into chunks that fit within maxLen characters. */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt <= 0) {
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/** Format milliseconds as human-readable elapsed: "30s", "1m", "2m 15s". */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Public interface of OutboundQueue. Imported by tests to enforce that mocks
 * stay in sync with the real implementation — if a new public method is added
 * here, TypeScript will reject any mock that doesn't include it.
 */
export interface IOutboundQueue {
  lastActivity?: number;
  enqueueText(text: string): void;
  /** Enqueue streaming text delta — aggregated with debounce to prevent per-token message spam from streaming providers. */
  enqueueStreamingText(text: string): void;
  /** Enqueue result/summary text. In minimal mode, suppressed if the turn already sent visible output. */
  enqueueResultText(text: string): void;
  enqueueToolUpdate(update: ToolUpdate): void;
  enqueueProgressUpdate(event: ProgressEvent, instanceName: string): void;
  /** Set the tool update display mode. 'minimal' hides technical details, 'friendly' shows all in plain language. */
  setToolUpdateMode(mode: 'full' | 'minimal' | 'friendly'): void;
  /** Set an optional redirect JID for tool-status batches. */
  setToolUpdateRedirectJid(jid: string | null): void;
  /** Override the streaming-text aggregation window in milliseconds. */
  setTextAggregateDelayMs(ms: number): void;
  /** Start the composing indicator immediately without adding any content to the queue. */
  indicateTyping(): void;
  enqueuePoll(sendFn: () => Promise<void>): Promise<void>;
  hasPendingPoll?(): boolean;
  setPollPending(pending: boolean): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  abortTurn(): void;
  /** The chat JID this queue is currently targeting. */
  readonly targetChatJid: string;
  /** Retarget all subsequent sends to a different JID variant. */
  updateDeliveryJid(jid: string): void;
  /** Set the current inbound seq so outbound ops can link back to inbound events. */
  setInboundSeq(seq: number | undefined): void;
  /** Return the id of the most recently created outbound op, or undefined if none. */
  getLastOpId(): number | undefined;
  /** Clear the tracked last outbound op id without touching durability. */
  clearLastOpId(): void;
  /** Mark the last outbound op created by this queue as terminal. */
  markLastTerminal(options?: { dedupeText?: boolean; skipDurabilityMark?: boolean }): void;
  /** Propagate durability engine after late initialization. */
  setDurability(engine: DurabilityEngine): void;
  /** Whether the queue still has buffered, in-flight, or typing work that should block eviction. */
  hasPendingWork?(): boolean;
  /**
   * Turn-end choke point. Called unconditionally when a `result` event is
   * received, so the typing indicator is cleared even on early-return branches
   * of the runtime result handler that never reach flush(). Idempotent.
   */
  endTurn(): void;
}

export class OutboundQueue implements IOutboundQueue {
  private static readonly MAX_SEND_ATTEMPTS = 3;
  private static readonly SEND_RETRY_BASE_MS = 1_000;
  private static readonly SEND_RETRY_MAX_MS = 8_000;

  private readonly messenger: Messenger;
  private chatJid: string;
  private cachedConversationKey: string;
  private durability: DurabilityEngine | undefined;
  /** inbound_events.seq for the current turn — threaded to outbound ops as sourceInboundSeq */
  private currentInboundSeq: number | undefined;
  /** The outbound_ops.id of the most recently created op (for markLastTerminal). */
  private lastOpId: number | undefined;
  /** Dedupe key for the most recently submitted text op, promoted only if markLastTerminal follows. */
  private lastSubmittedTextDedupeKey: string | undefined;
  /** Recent terminal text sends. Only terminalized text can suppress a later duplicate. */
  private readonly recentTerminalTextKeys = new Map<string, TerminalTextDedupeEntry>();
  /** Rendered progress-placeholder text → timestamp of last enqueue, for short-window coalescing. */
  private readonly recentProgressTextAt = new Map<string, number>();
  /**
   * Timestamp of the last ACTUALLY-EMITTED progress placeholder. Powers the
   * persistent per-chat rate floor. Deliberately NOT cleared by flush()/abortTurn()
   * so the floor spans turns; only reset when the conversation itself changes.
   */
  private lastProgressEmittedAt: number | undefined;
  /** Per-chat progress-placeholder rate floor (ms). 0 disables. Override via config/test setter. */
  private progressFloorMs: number =
    config.operationTracker?.progressPlaceholderRateLimitMs ?? PROGRESS_PLACEHOLDER_RATE_FLOOR_MS;

  /** Queue of text chunks ready to send. */
  private sendQueue: string[] = [];
  /** Whether a send is currently in-flight. */
  private sending = false;
  /** Timestamp (ms) of the last completed send. */
  private lastSentAt = 0;

  /** Buffered tool update objects, waiting to be flushed as a batch. */
  private toolBuffer: ToolUpdate[] = [];
  /** Timer handle for the idle batch window (resets on each new tool call). */
  private toolTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timer handle for the max-age flush (set once when the buffer first fills, never reset). */
  private toolMaxAgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether a composing presence update is currently active. */
  private isTyping = false;
  /** Interval that periodically re-asserts composing while a turn is in progress. */
  private typingRefreshInterval: ReturnType<typeof setInterval> | null = null;

  /** Promise chain used to serialize sends. */
  private chain: Promise<void> = Promise.resolve();

  /** Controls tool update verbosity. 'minimal' suppresses noise, 'friendly' shows all in plain language. */
  private toolUpdateMode: 'full' | 'minimal' | 'friendly' = 'full';
  /** Optional destination for tool-status batches; regular text still uses chatJid. */
  private toolUpdateRedirectJid: string | null = null;
  /** Debounce window for streaming text fragments. */
  private textAggregateDelayMs = TEXT_AGGREGATE_DELAY_MS;

  /** In friendly mode: progress event tool IDs already reported (dedup — only first per tool). */
  private friendlyProgressSent = new Set<string>();
  public lastActivity = Date.now();
  private pollPending = false;

  /**
   * Opaque token identifying this queue instance for echo-guard exemption.
   * Sends from the same token are not subject to the cross-session cooldown.
   */
  private readonly senderToken: string;

  constructor(messenger: Messenger, chatJid: string) {
    this.messenger = messenger;
    this.chatJid = chatJid;
    this.cachedConversationKey = toConversationKey(chatJid);
    this.senderToken = crypto.randomUUID();
  }

  /** Set the tool update display mode. 'minimal' hides technical details, 'friendly' shows all in plain language. */
  setToolUpdateMode(mode: 'full' | 'minimal' | 'friendly'): void {
    this.toolUpdateMode = mode;
  }

  setToolUpdateRedirectJid(jid: string | null): void {
    this.toolUpdateRedirectJid = jid;
  }

  setTextAggregateDelayMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) {
      this.textAggregateDelayMs = ms;
    }
  }

  /**
   * In minimal mode, decide whether a tool update should be shown to the user.
   * Only friendly, non-technical updates pass through. Everything else is suppressed
   * but the typing indicator stays active so the user knows work is happening.
   */
  private shouldShowMinimal(update: ToolUpdate): boolean {
    // Always suppress technical noise
    switch (update.category) {
      case 'skill':      // ToolSearch/Skill lookups — pure internal mechanics
      case 'planning':   // TaskCreate/TodoWrite — internal work tracking
      case 'blocked':    // Hook denials — internal safety system
      case 'cancelled':  // Cancelled tool calls
      case 'reading':    // File reads — internal
      case 'modifying':  // File writes — internal
        return false;

      case 'error':
        // Only show errors that are genuinely user-facing (not retries or hook blocks)
        return false;

      case 'searching':
        // Show if it's a friendly knowledge search or web search
        if (update.detail.startsWith('Checking my notes')) return true;
        return false;

      case 'fetching':
        // Web searches/fetches get a friendly label
        return true;

      case 'agent':
        // Subagent dispatches — suppress
        return false;

      case 'running':
        // Bash commands — suppress
        return false;

      case 'other':
        // MCP tools — suppress raw tool names
        return false;
    }

    return false;
  }

  /** Attach an optional DurabilityEngine to track outbound ops. */
  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
  }

  setInboundSeq(seq: number | undefined): void {
    this.currentInboundSeq = seq;
  }

  /** Return the id of the most recently created outbound op, or undefined if none. */
  getLastOpId(): number | undefined {
    return this.lastOpId;
  }

  clearLastOpId(): void {
    this.lastOpId = undefined;
  }

  /** Mark the last outbound op created by this queue as terminal (defense-in-depth echo fallback). */
  markLastTerminal(options: { dedupeText?: boolean; skipDurabilityMark?: boolean } = {}): void {
    if (this.lastOpId !== undefined && this.durability && options.skipDurabilityMark !== true) {
      this.durability.markTerminal(this.lastOpId);
    }
    if (options.dedupeText === true && this.lastSubmittedTextDedupeKey !== undefined) {
      const now = Date.now();
      this.pruneTerminalTextDedupe(now);
      this.recentTerminalTextKeys.set(this.lastSubmittedTextDedupeKey, {
        lastSeenAt: now,
        suppressedCount: 0,
      });
      while (this.recentTerminalTextKeys.size > MAX_TERMINAL_TEXT_DEDUPE_KEYS) {
        const oldest = this.recentTerminalTextKeys.keys().next().value;
        if (oldest === undefined) break;
        this.recentTerminalTextKeys.delete(oldest);
      }
    }
    this.lastSubmittedTextDedupeKey = undefined;
    this.clearLastOpId();
  }

  /** Track whether the current turn has already sent visible text to the user. */
  private turnHasVisibleText = false;

  /** Aggregation buffer for streaming text deltas — prevents per-token messages from streaming providers. */
  private streamBufferParts: string[] = [];
  /** Timer for flushing aggregated streaming text after a pause. */
  private streamTimer: ReturnType<typeof setTimeout> | null = null;

  /** Enqueue a text message for immediate sending (after pacing). */
  enqueueText(text: string): void {
    if (!text || text.trim() === '') return;
    // Flush any pending streaming buffer first to maintain ordering
    this.flushStreamBuffer();
    this.turnHasVisibleText = true;
    const chunks = repairChunkFormatting(splitMessage(preprocessText(text)));
    for (const chunk of chunks) {
      this.enqueue(chunk);
    }
  }

  /**
   * Enqueue streaming text delta — aggregates fragments with a debounce timer.
   * Use this for `assistant_text` events from streaming providers (codex-cli, gemini-cli)
   * that emit per-token or per-line deltas. Text is buffered and flushed after
   * TEXT_AGGREGATE_DELAY_MS of silence, producing batched messages instead of spam.
   */
  enqueueStreamingText(text: string): void {
    if (!text) return;
    this.turnHasVisibleText = true;
    this.streamBufferParts.push(text);
    this.startTyping();
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => {
      this.flushStreamBuffer();
    }, this.textAggregateDelayMs);
  }

  /** Flush the streaming text buffer into the send queue. */
  private flushStreamBuffer(): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    const text = this.streamBufferParts.join('');
    this.streamBufferParts = [];
    if (!text || text.trim() === '') return;
    const chunks = repairChunkFormatting(splitMessage(preprocessText(text)));
    for (const chunk of chunks) {
      this.enqueue(chunk);
    }
  }

  /**
   * Enqueue the result/summary text from a completed turn.
   * In minimal mode, suppresses the text if the turn already produced visible
   * output — Claude Code often appends an internal task summary ("Done — I sent
   * the message and asked for...") that shouldn't reach non-technical users.
   */
  enqueueResultText(text: string): void {
    if (!text || text.trim() === '') return;
    if (this.toolUpdateMode === 'minimal' && this.turnHasVisibleText) {
      // Suppress — the user already got the real response during the turn
      return;
    }
    this.enqueueText(text);
  }

  /**
   * Buffer a tool progress update. Updates are sent either when there is a
   * 3-second idle gap between tool calls, or after 30 seconds maximum —
   * whichever comes first. This prevents silent gaps during long tool chains.
   *
   * In minimal mode, most updates are suppressed to keep the user experience
   * clean for non-technical users. Only curated friendly updates pass through.
   */
  enqueueToolUpdate(update: ToolUpdate): void {
    if (this.toolUpdateMode === 'minimal') {
      // Only pass through updates that are meaningful to a non-technical user
      const pass = this.shouldShowMinimal(update);
      if (!pass) {
        this.startTyping();
        return;
      }
    }
    // Friendly mode: let everything through (no filtering), but skip internal noise
    // that adds no user value (skill lookups, cancelled ops).
    if (this.toolUpdateMode === 'friendly') {
      if (update.category === 'skill' || update.category === 'cancelled') {
        this.startTyping();
        return;
      }
    }
    this.toolBuffer.push(update);
    this.startTyping();

    // Idle timer: reset on each new tool call, fires after a pause in tool activity.
    // Minimal mode uses a shorter delay (1.5s) so the first status reaches the user
    // before the answer — avoids status arriving after/alongside the answer text.
    const delay = this.toolUpdateMode === 'minimal' ? 1_500 : TOOL_BATCH_DELAY_MS;
    if (this.toolTimer !== null) clearTimeout(this.toolTimer);
    this.toolTimer = setTimeout(() => this.flushToolBuffer(), delay);

    // Max-age timer: set once when the buffer first fills, never reset
    if (this.toolMaxAgeTimer === null) {
      this.toolMaxAgeTimer = setTimeout(() => {
        this.toolMaxAgeTimer = null;
        this.flushToolBuffer();
      }, TOOL_BATCH_MAX_AGE_MS);
    }
  }

  enqueueProgressUpdate(event: ProgressEvent, instanceName: string): void {
    const name = instanceName;

    switch (event.type) {
      case 'thinking_long': {
        if (this.toolUpdateMode === 'minimal') {
          this.startTyping();
          return;
        }
        this.enqueueProgress(`_${name} is thinking..._`);
        return;
      }

      case 'thinking_stalled': {
        if (this.toolUpdateMode === 'minimal') {
          this.enqueueProgress(`_${name} may be stuck..._`);
        } else {
          this.enqueueProgress(`_${name} has gone silent \u2014 checking..._`);
        }
        return;
      }

      case 'operation_progress': {
        if (this.pollPending) {
          this.startTyping();
          return;
        }
        if (this.toolUpdateMode === 'minimal') {
          this.startTyping();
          return;
        }
        if (this.toolUpdateMode === 'friendly') {
          if (this.friendlyProgressSent.has(event.toolId)) {
            this.startTyping();
            return;
          }
          this.friendlyProgressSent.add(event.toolId);
          this.enqueueProgress(`_${name} is working on something, this might take a moment..._`);
          return;
        }
        // full mode
        const elapsed = formatElapsed(event.elapsedMs);
        const desc = event.toolName === 'Agent' ? 'running a subagent' : `running ${event.toolName}`;
        this.enqueueProgress(`_${name} has been ${desc} for ${elapsed}..._`);
        return;
      }

      case 'operation_slow': {
        if (this.pollPending) {
          this.startTyping();
          return;
        }
        if (this.toolUpdateMode === 'minimal') {
          this.enqueueProgress('_Still working..._');
        } else if (this.toolUpdateMode === 'friendly') {
          this.enqueueProgress(`_${name} is still working on it..._`);
        } else {
          const elapsed = formatElapsed(event.elapsedMs);
          this.enqueueProgress(`_\u23f3 ${name} is taking longer than expected (${elapsed})..._`);
        }
        return;
      }

      case 'operation_stalled': {
        if (this.pollPending) {
          this.startTyping();
          return;
        }
        const elapsed = formatElapsed(event.elapsedMs);
        if (this.toolUpdateMode === 'minimal') {
          this.enqueueProgress(`_Still working (${elapsed})..._`);
        } else if (this.toolUpdateMode === 'friendly') {
          this.enqueueProgress(`_${name}: Still working (${elapsed})..._`);
        } else {
          this.enqueueProgress(`_\u23f3 ${name}: Still working (${elapsed})..._`);
        }
        return;
      }
    }
  }

  /**
   * Enqueue an ephemeral progress placeholder, coalescing identical text seen within
   * PROGRESS_TEXT_DEDUPE_WINDOW_MS. A parallel tool batch makes several operations cross
   * their slow/stall thresholds within seconds of each other, each rendering the same
   * placeholder; without this the user would receive N identical "_Still working..._"
   * messages back-to-back. Suppressed placeholders still re-assert the typing indicator
   * so the user knows work is ongoing. Reset per-turn via flush()/abortTurn().
   */
  private enqueueProgress(text: string): void {
    const now = Date.now();

    // Persistent per-chat rate FLOOR \u2014 checked BEFORE the text-dedupe window.
    // The text window (recentProgressTextAt) is a 30s per-TEXT collapser cleared
    // every turn; it cannot cap elapsed-bearing stall text (unique each fire),
    // does not survive flush()/abortTurn(), and lets slow\u2192stall escalation emit
    // two distinct texts. This floor is keyed on the conversation, survives turn
    // boundaries, and bounds the total placeholder rate. A floor-suppressed nudge
    // re-arms the typing indicator (no-op while the refresh interval is already
    // running; re-asserts it if typing had stopped), so suppression never causes
    // dead-air — the alive signal is preserved across the suppressed window.
    if (
      this.progressFloorMs > 0 &&
      this.lastProgressEmittedAt !== undefined &&
      now - this.lastProgressEmittedAt < this.progressFloorMs
    ) {
      this.startTyping();
      log.info(
        { chatJid: this.chatJid, floorMs: this.progressFloorMs },
        'progress placeholder suppressed by per-chat rate floor',
      );
      return;
    }

    this.pruneProgressTextDedupe(now);
    const lastAt = this.recentProgressTextAt.get(text);
    if (lastAt !== undefined && now - lastAt < PROGRESS_TEXT_DEDUPE_WINDOW_MS) {
      // Identical placeholder already shown recently \u2014 keep the indicator alive, drop the duplicate.
      this.startTyping();
      log.info({ chatJid: this.chatJid, windowMs: PROGRESS_TEXT_DEDUPE_WINDOW_MS }, 'coalesced duplicate progress placeholder');
      return;
    }
    this.recentProgressTextAt.set(text, now);
    // Record the floor slot only on an ACTUAL emit (passed both floor and text window).
    this.lastProgressEmittedAt = now;
    this.enqueue(text);
  }

  /**
   * Override the per-chat progress-placeholder rate floor (ms). 0 disables.
   * Production value comes from config; this setter supports per-instance runtime
   * tuning and deterministic tests.
   */
  setProgressFloorMs(ms: number): void {
    this.progressFloorMs = Math.max(0, ms);
  }

  private pruneProgressTextDedupe(now: number): void {
    for (const [key, ts] of this.recentProgressTextAt) {
      if (now - ts >= PROGRESS_TEXT_DEDUPE_WINDOW_MS) {
        this.recentProgressTextAt.delete(key);
      }
    }
  }

  /** Start the composing indicator immediately without queuing any content. */
  indicateTyping(): void {
    this.startTyping();
  }

  /**
   * Flush all buffered text, then execute the poll send function.
   * Ensures any in-progress text messages are delivered before the poll arrives.
   */
  async enqueuePoll(sendFn: () => Promise<void>): Promise<void> {
    this.flushStreamBuffer();
    this.flushToolBuffer();
    await this.chain;
    await sendFn();
  }

  hasPendingPoll(): boolean {
    return this.pollPending;
  }

  setPollPending(pending: boolean): void {
    this.pollPending = pending;
  }

  /** Flush all pending messages (tool buffer + send queue) immediately. */
  async flush(): Promise<void> {
    this.lastActivity = Date.now();
    this.flushStreamBuffer();
    this.flushToolBuffer();
    // Wait for the current chain to drain
    await this.chain;
    // All messages delivered — clear typing indicator and per-turn state
    this.stopTyping();
    this.friendlyProgressSent.clear();
    this.recentProgressTextAt.clear();
    this.turnHasVisibleText = false;
  }

  /** Flush pending messages and clear all timers. */
  async shutdown(): Promise<void> {
    await this.flush();
    if (this.toolTimer !== null) {
      clearTimeout(this.toolTimer);
      this.toolTimer = null;
    }
  }

  /**
   * Called on session crash — cancels tool timers and the typing heartbeat
   * without sending a 'paused' update. The composing indicator will time out
   * naturally on the recipient's side (~10-15s), acting as a soft signal that
   * the session is in trouble.
   */
  abortTurn(): void {
    if (this.toolTimer !== null) { clearTimeout(this.toolTimer); this.toolTimer = null; }
    if (this.toolMaxAgeTimer !== null) { clearTimeout(this.toolMaxAgeTimer); this.toolMaxAgeTimer = null; }
    if (this.streamTimer !== null) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.streamBufferParts = [];
    this.toolBuffer = [];
    this.friendlyProgressSent.clear();
    this.recentProgressTextAt.clear();
    this.turnHasVisibleText = false;
    this.stopTyping(false);
  }

  get targetChatJid(): string { return this.chatJid; }

  hasPendingWork(): boolean {
    return this.sending
      || this.sendQueue.length > 0
      || this.toolBuffer.length > 0
      || this.streamBufferParts.length > 0
      || this.isTyping
      || this.toolTimer !== null
      || this.toolMaxAgeTimer !== null
      || this.streamTimer !== null;
  }

  /** Retarget all subsequent sends to a different JID variant. */
  updateDeliveryJid(jid: string): void {
    this.chatJid = jid;
    this.cachedConversationKey = toConversationKey(jid);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Start composing indicator and keep it alive with a periodic refresh. Idempotent. */
  private startTyping(): void {
    if (this.isTyping) return;
    this.isTyping = true;
    this.messenger.setTyping?.(this.chatJid, true).catch(() => {});
    // Re-assert composing every 8s — WA auto-clears it on the recipient side after ~10-15s.
    // This keeps the indicator alive during long tool chains with no intermediate messages.
    this.typingRefreshInterval = setInterval(() => {
      this.messenger.setTyping?.(this.chatJid, true).catch(() => {});
    }, TYPING_REFRESH_MS);
  }

  /**
   * Stop the composing indicator and clear the refresh interval.
   * When `notify` is true (default), sends a 'paused' presence update.
   * When `notify` is false, clears silently (used on session crash).
   */
  private stopTyping(notify = true): void {
    if (!this.isTyping) return;
    this.isTyping = false;
    if (this.typingRefreshInterval !== null) {
      clearInterval(this.typingRefreshInterval);
      this.typingRefreshInterval = null;
    }
    if (notify) {
      this.messenger.setTyping?.(this.chatJid, false).catch(() => {});
    }
  }

  /**
   * Turn-end choke point. Called unconditionally when a `result` event is
   * received, so the typing indicator is cleared even on early-return branches
   * of the runtime result handler that never reach flush(). Idempotent.
   */
  endTurn(): void {
    this.stopTyping();
  }

  private flushToolBuffer(): void {
    if (this.toolTimer !== null) { clearTimeout(this.toolTimer); this.toolTimer = null; }
    if (this.toolMaxAgeTimer !== null) { clearTimeout(this.toolMaxAgeTimer); this.toolMaxAgeTimer = null; }
    if (this.toolBuffer.length === 0) return;

    // Group updates by category, preserving first-appearance order of categories.
    // Deduplicate detail strings within each category to avoid "Checking my notes on X" x2.
    const categoryOrder: ToolCategory[] = [];
    const groups = new Map<ToolCategory, string[]>();
    for (const { category, detail } of this.toolBuffer) {
      if (!groups.has(category)) {
        categoryOrder.push(category);
        groups.set(category, []);
      }
      const existing = groups.get(category)!;
      if (!existing.includes(detail)) {
        existing.push(detail);
      }
    }

    // Render each group as "{emoji} {Label}:\n  • detail\n  • detail"
    const meta = this.toolUpdateMode === 'friendly' ? FRIENDLY_CATEGORY_META : TOOL_CATEGORY_META;
    const sections: string[] = [];
    for (const category of categoryOrder) {
      const { emoji, label } = meta[category];
      const details = groups.get(category)!;
      const bullets = details.map((d) => `  • ${d}`).join('\n');
      sections.push(`${emoji} ${label}:\n${bullets}`);
    }

    this.toolBuffer = [];
    const statusText = sections.join('\n\n');
    if (this.toolUpdateRedirectJid !== null) {
      this.messenger.sendMessage(this.toolUpdateRedirectJid, statusText).catch((err) => {
        log.warn({ err, target: this.toolUpdateRedirectJid, textLength: statusText.length }, 'tool-status redirect send failed');
      });
      return;
    }

    // Typing indicator stays active — the turn is still in progress.
    // WhatsApp clears the composing state on delivery, but the heartbeat
    // will re-assert it within TYPING_REFRESH_MS.
    this.enqueueText(statusText);
  }

  private enqueue(chunk: string): void {
    if (this.suppressDuplicateTerminalText(chunk)) {
      return;
    }
    this.lastActivity = Date.now();
    this.sendQueue.push(chunk);
    if (!this.sending) {
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    this.sending = true;
    this.chain = this.chain
      .then(async () => {
        while (this.sendQueue.length > 0) {
          const chunk = this.sendQueue.shift()!;
          await this.sendWithPacing(chunk);
          // WA clears the composing indicator on message delivery. Re-assert
          // it immediately so there's no visible gap between mid-turn messages
          // (e.g. compact_boundary notification followed by continued output).
          if (this.isTyping) {
            this.messenger.setTyping?.(this.chatJid, true).catch(() => {});
          }
        }
        this.sending = false;
      })
      .catch((err) => {
        // Reset sending flag so the next enqueue() re-triggers draining.
        // Any items remaining in sendQueue at the time of the error will be
        // re-drained once a new message arrives and calls enqueue().
        // (sendWithRetry never throws, so this branch requires a future bug
        // in sendWithPacing — keeping it here as a safety net.)
        log.error({ err }, 'drain queue error — resetting');
        this.sending = false;
      });
  }

  private async sendWithPacing(text: string): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed < MIN_SEND_GAP_MS && this.lastSentAt !== 0) {
      const wait = MIN_SEND_GAP_MS - elapsed;
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    // AE4: Echo guard — suppress cross-session group echo loops.
    // Passes senderToken so intra-session rapid sends (tool status + text) are exempt.
    if (!canSendToGroup(this.chatJid, config.echoGuard, this.senderToken)) {
      return; // silently drop
    }
    await this.sendWithRetry(text);
    this.lastSentAt = Date.now();
    recordGroupOutbound(this.chatJid, this.senderToken);
  }

  private async sendWithRetry(text: string): Promise<void> {
    const textDedupeKey = this.terminalTextDedupeKey('text', this.chatJid, text);
    // Create an outbound op before first attempt (if durability is wired)
    let opId: number | undefined;
    if (this.durability) {
      opId = this.durability.createOutboundOp({
        conversationKey: this.cachedConversationKey,
        chatJid: this.chatJid,
        opType: 'text',
        payload: JSON.stringify({ text }),
        replayPolicy: 'unsafe',
        sourceInboundSeq: this.currentInboundSeq,
      });
      this.lastOpId = opId;
      this.durability.markSending(opId);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < OutboundQueue.MAX_SEND_ATTEMPTS; attempt++) {
      try {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let receipt;
        try {
          receipt = await Promise.race([
            this.messenger.sendMessage(this.chatJid, text),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error('SEND_TIMEOUT')),
                SEND_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeoutHandle);
        }
        if (opId !== undefined && this.durability) {
          this.durability.markSubmitted(opId, receipt.waMessageId);
        }
        this.lastSubmittedTextDedupeKey = textDedupeKey;
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < OutboundQueue.MAX_SEND_ATTEMPTS - 1) {
          const truncated = text.length > 80 ? text.slice(0, 80) + '…' : text;
          const isTimeout = (err as Error).message === 'SEND_TIMEOUT';
          const retryAfterMs = OutboundQueue.retryAfterMs(err);
          const delayMs = retryAfterMs ?? jitteredDelay(OutboundQueue.SEND_RETRY_BASE_MS, attempt, OutboundQueue.SEND_RETRY_MAX_MS);
          log.warn({ chatJid: this.chatJid, attempt: attempt + 1, maxAttempts: OutboundQueue.MAX_SEND_ATTEMPTS, textPreview: truncated, ...(isTimeout && { timeout: true }), ...(retryAfterMs !== undefined && { retryAfterMs }) }, 'outbound send failed — retrying');
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    // All attempts exhausted — log and give up (do NOT re-throw, queue must keep draining)
    const truncated = text.length > 80 ? text.slice(0, 80) + '…' : text;
    log.error({ chatJid: this.chatJid, attempts: OutboundQueue.MAX_SEND_ATTEMPTS, textPreview: truncated, err: lastErr, textLength: text.length }, 'outbound send failed after all retries');

    if (opId !== undefined && this.durability) {
      this.durability.markMaybeSent(opId, (lastErr as Error)?.message ?? 'send_failed');
    }

    // Best-effort: notify the user that part of the response was lost.
    // Send directly (not through queue) to avoid re-entry loops.
    Promise.race([
      this.messenger.sendMessage(this.chatJid, '⚠️ A response could not be delivered after 3 attempts.'),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), SEND_TIMEOUT_MS)),
    ]).catch(() => { /* best effort only */ });
  }

  private static retryAfterMs(err: unknown): number | undefined {
    const retryAfterMs = (err as { payload?: { retryAfterMs?: unknown } })?.payload?.retryAfterMs;
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return undefined;
    return Math.min(retryAfterMs, OutboundQueue.SEND_RETRY_MAX_MS);
  }

  private suppressDuplicateTerminalText(text: string): boolean {
    const now = Date.now();
    this.pruneTerminalTextDedupe(now);
    const key = this.terminalTextDedupeKey('text', this.chatJid, text);
    const entry = this.recentTerminalTextKeys.get(key);
    if (!entry) return false;

    entry.lastSeenAt = now;
    entry.suppressedCount += 1;
    log.info({
      chatJid: this.chatJid,
      opType: 'text',
      terminal: true,
      payloadHash: this.terminalTextPayloadHash(text),
      suppressedCount: entry.suppressedCount,
      windowMs: TERMINAL_TEXT_DEDUPE_WINDOW_MS,
    }, 'suppressed duplicate outbound terminal text');
    return true;
  }

  private pruneTerminalTextDedupe(now: number): void {
    for (const [key, entry] of this.recentTerminalTextKeys) {
      if (now - entry.lastSeenAt > TERMINAL_TEXT_DEDUPE_WINDOW_MS) {
        this.recentTerminalTextKeys.delete(key);
      }
    }
  }

  private terminalTextDedupeKey(opType: 'text', chatJid: string, text: string): string {
    return `${opType}:${chatJid}:${this.terminalTextPayloadHash(text)}`;
  }

  private terminalTextPayloadHash(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }
}
