// src/runtimes/agent/outbound-queue.ts
// Serialized outbound queue for WhatsApp messages with batching and pacing.

import type { Messenger } from '../../core/types.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';
import { jitteredDelay } from '../../core/retry.ts';
import { markdownToWhatsApp, repairChunkFormatting } from './whatsapp-format.ts';
import type { ToolCategory } from './providers/tool-mapping.ts';
export type { ToolCategory } from './providers/tool-mapping.ts';

const log = createChildLogger('outbound-queue');

export interface ToolUpdate {
  category: ToolCategory;
  detail: string;
}

export const TOOL_CATEGORY_META: Record<ToolCategory, { label: string; emoji: string }> = {
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

/**
 * Public interface of OutboundQueue. Imported by tests to enforce that mocks
 * stay in sync with the real implementation — if a new public method is added
 * here, TypeScript will reject any mock that doesn't include it.
 */
export interface IOutboundQueue {
  enqueueText(text: string): void;
  /** Enqueue streaming text delta — aggregated with debounce to prevent per-token message spam from streaming providers. */
  enqueueStreamingText(text: string): void;
  /** Enqueue result/summary text. In minimal mode, suppressed if the turn already sent visible output. */
  enqueueResultText(text: string): void;
  enqueueToolUpdate(update: ToolUpdate): void;
  /** Set the tool update display mode. 'minimal' hides technical details from non-technical users. */
  setToolUpdateMode(mode: 'full' | 'minimal'): void;
  /** Start the composing indicator immediately without adding any content to the queue. */
  indicateTyping(): void;
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
  /** Mark the last outbound op created by this queue as terminal. */
  markLastTerminal(): void;
  /** Propagate durability engine after late initialization. */
  setDurability(engine: DurabilityEngine): void;
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

  /** Controls tool update verbosity. 'minimal' suppresses technical noise. */
  private toolUpdateMode: 'full' | 'minimal' = 'full';

  /** In minimal mode: detail strings already sent this turn (dedup across batches). */
  private minimalSentDetails = new Set<string>();
  /** In minimal mode: timestamp of the last message (text or status) sent to user. Initialized to now to prevent premature heartbeat. */
  private minimalLastSentAt = Date.now();
  /** In minimal mode: timer for "still working" heartbeat when silence exceeds threshold. */
  private minimalHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(messenger: Messenger, chatJid: string) {
    this.messenger = messenger;
    this.chatJid = chatJid;
    this.cachedConversationKey = toConversationKey(chatJid);
  }

  /** Set the tool update display mode. 'minimal' hides technical details from non-technical users. */
  setToolUpdateMode(mode: 'full' | 'minimal'): void {
    this.toolUpdateMode = mode;
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

  /** Mark the last outbound op created by this queue as terminal (defense-in-depth echo fallback). */
  markLastTerminal(): void {
    if (this.lastOpId !== undefined && this.durability) {
      this.durability.markTerminal(this.lastOpId);
      this.lastOpId = undefined;
    }
  }

  /** Track whether the current turn has already sent visible text to the user. */
  private turnHasVisibleText = false;

  /** Aggregation buffer for streaming text deltas — prevents per-token messages from streaming providers. */
  private streamBuffer = '';
  /** Timer for flushing aggregated streaming text after a pause. */
  private streamTimer: ReturnType<typeof setTimeout> | null = null;

  /** Enqueue a text message for immediate sending (after pacing). */
  enqueueText(text: string): void {
    if (!text || text.trim() === '') return;
    // Flush any pending streaming buffer first to maintain ordering
    this.flushStreamBuffer();
    if (this.toolUpdateMode === 'minimal') {
      this.minimalLastSentAt = Date.now();
      this.clearMinimalHeartbeat();
    }
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
    if (this.toolUpdateMode === 'minimal') {
      this.minimalLastSentAt = Date.now();
      this.clearMinimalHeartbeat();
    }
    this.turnHasVisibleText = true;
    this.streamBuffer += text;
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => {
      this.flushStreamBuffer();
    }, TEXT_AGGREGATE_DELAY_MS);
  }

  /** Flush the streaming text buffer into the send queue. */
  private flushStreamBuffer(): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    const text = this.streamBuffer;
    this.streamBuffer = '';
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
        this.scheduleMinimalHeartbeat();
        return;
      }
      // Deduplicate: if we've already sent this exact detail string, suppress
      if (this.minimalSentDetails.has(update.detail)) {
        this.startTyping();
        this.scheduleMinimalHeartbeat();
        return;
      }
      // If we've sent any status this turn, only allow through if it's been >15s
      // since the last message (avoid rapid-fire status spam, but prevent dead silence)
      if (this.minimalSentDetails.size > 0) {
        const elapsed = Date.now() - this.minimalLastSentAt;
        if (elapsed < 15_000) {
          this.startTyping();
          this.scheduleMinimalHeartbeat();
          return;
        }
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

  /** Start the composing indicator immediately without queuing any content. */
  indicateTyping(): void {
    this.startTyping();
  }

  /** Flush all pending messages (tool buffer + send queue) immediately. */
  async flush(): Promise<void> {
    this.flushStreamBuffer();
    this.flushToolBuffer();
    // Wait for the current chain to drain
    await this.chain;
    // All messages delivered — clear typing indicator
    this.stopTyping();
  }

  /** Flush pending messages and clear all timers. */
  async shutdown(): Promise<void> {
    await this.flush();
    this.clearMinimalHeartbeat();
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
    this.streamBuffer = '';
    this.toolBuffer = [];
    this.minimalSentDetails.clear();
    this.minimalLastSentAt = Date.now();
    this.turnHasVisibleText = false;
    this.clearMinimalHeartbeat();
    this.stopTyping(false);
  }

  get targetChatJid(): string { return this.chatJid; }

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
   * In minimal mode, schedule a heartbeat message if the user has been in silence
   * for too long. Fires 20s after the last message sent. Keeps the user aware
   * that work is happening without spamming tool-level detail.
   */
  /**
   * In minimal mode, schedule a heartbeat if the user has been in silence too long.
   * Fires once, 20s after the last message. Does not reschedule — subsequent tool
   * calls just maintain the typing indicator without additional text.
   */
  private scheduleMinimalHeartbeat(): void {
    if (this.toolUpdateMode !== 'minimal') return;
    if (this.minimalHeartbeatTimer !== null) return; // already scheduled

    // Only schedule if we've already sent at least one status — the first status
    // message is the primary feedback; heartbeat is for extended silence after that.
    if (this.minimalSentDetails.size === 0) return;

    const sinceLastSent = Date.now() - this.minimalLastSentAt;
    const delay = Math.max(0, 20_000 - sinceLastSent);

    this.minimalHeartbeatTimer = setTimeout(() => {
      this.minimalHeartbeatTimer = null;
      const elapsed = Date.now() - this.minimalLastSentAt;
      if (elapsed >= 18_000 && this.isTyping) {
        this.minimalLastSentAt = Date.now();
        this.enqueue('_still working on it..._');
      }
    }, delay);
  }

  private clearMinimalHeartbeat(): void {
    if (this.minimalHeartbeatTimer !== null) {
      clearTimeout(this.minimalHeartbeatTimer);
      this.minimalHeartbeatTimer = null;
    }
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

    // Track sent details for minimal mode dedup and update sent timestamp
    if (this.toolUpdateMode === 'minimal') {
      for (const details of groups.values()) {
        for (const d of details) {
          this.minimalSentDetails.add(d);
        }
      }
      this.minimalLastSentAt = Date.now();
      this.clearMinimalHeartbeat();
    }

    // Render each group as "{emoji} {Label}:\n  • detail\n  • detail"
    const sections: string[] = [];
    for (const category of categoryOrder) {
      const { emoji, label } = TOOL_CATEGORY_META[category];
      const details = groups.get(category)!;
      const bullets = details.map((d) => `  • ${d}`).join('\n');
      sections.push(`${emoji} ${label}:\n${bullets}`);
    }

    this.toolBuffer = [];
    // Typing indicator stays active — the turn is still in progress.
    // WhatsApp clears the composing state on delivery, but the heartbeat
    // will re-assert it within TYPING_REFRESH_MS.
    this.enqueueText(sections.join('\n\n'));
  }

  private enqueue(chunk: string): void {
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
    await this.sendWithRetry(text);
    this.lastSentAt = Date.now();
  }

  private async sendWithRetry(text: string): Promise<void> {
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
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < OutboundQueue.MAX_SEND_ATTEMPTS - 1) {
          const truncated = text.length > 80 ? text.slice(0, 80) + '…' : text;
          const isTimeout = (err as Error).message === 'SEND_TIMEOUT';
          log.warn({ chatJid: this.chatJid, attempt: attempt + 1, maxAttempts: OutboundQueue.MAX_SEND_ATTEMPTS, textPreview: truncated, ...(isTimeout && { timeout: true }) }, 'outbound send failed — retrying');
          await new Promise<void>((resolve) => setTimeout(resolve, jitteredDelay(OutboundQueue.SEND_RETRY_BASE_MS, attempt, OutboundQueue.SEND_RETRY_MAX_MS)));
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
}
