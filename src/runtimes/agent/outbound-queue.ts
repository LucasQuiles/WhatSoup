// src/runtimes/agent/outbound-queue.ts
// Serialized outbound queue for WhatsApp messages with batching and pacing.

import { createHash } from 'node:crypto';
import type { Messenger } from '../../core/types.ts';
import {
  persistOutboundFailureDisposition,
  type DurabilityEngine,
} from '../../core/durability.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';
import { jitteredDelay, MAX_TIMER_DELAY_MS } from '../../core/retry.ts';
import { canSendToGroup, recordGroupOutbound } from '../../core/echo-guard.ts';
import {
  classifyOutboundFailure,
  createInternalOutboundFailureEvidence,
  outboundFailureWarrantsUserNotice,
  type OutboundFailureEvidenceV1,
} from '../../core/outbound-failure-disposition.ts';
import { redactInternalArtifacts, resolveOutboundAudience } from '../../core/outbound-message-safety.ts';
import { formatProviderErrorForUser } from '../../lib/provider-errors.ts';
import { isGroupJid } from '../../core/jid-constants.ts';
import { config } from '../../config.ts';
import { hasVisibleToolText } from './tool-update.ts';
import { markdownToWhatsApp, repairChunkFormatting } from './whatsapp-format.ts';
import type { ToolCategory } from './providers/tool-mapping.ts';
export type { ToolCategory } from './providers/tool-mapping.ts';
import type { ProgressEvent } from './operation-tracker.ts';

const log = createChildLogger('outbound-queue');

export interface ToolUpdate {
  category: ToolCategory;
  detail: string;
}

export type OutboundMessageRole = 'answer' | 'lifecycle' | 'status';

export interface TurnDeliveryEvidence {
  readonly turnId: string;
  readonly answerOpIds: readonly number[];
  readonly lifecycleOpIds: readonly number[];
  readonly statusOpIds: readonly number[];
}

export interface OutboundQueueOptions {
  /** Immutable durable attribution for every outbound operation owned by this queue. */
  readonly conversationKey: string;
  /** Echo-guard token inherited by a replacement queue. */
  readonly senderToken?: string;
  /**
   * T8-F2: query whether the runtime is currently in a fallback-provider
   * window. Injected — the queue owns no fallback state itself (the runtime
   * does, via its private `isFallbackWindowActive` getter). Omitted only when
   * genuinely unavailable; the queue then fails closed (treats as active —
   * full scrub), per resolveOutboundAudience's fail-closed contract.
   */
  readonly fallbackActive?: () => boolean;
  /**
   * T8-F1: resolve whether a chatJid's peer is a config admin (lid-aware —
   * `isOperatorDmPeer`). Injected so the queue stays decoupled from
   * `Database`/access-list internals (SoC) — the runtime, which already owns
   * `db` and `config.adminPhones`, computes this.
   */
  readonly peerIsAdmin?: (chatJid: string) => boolean;
  /** Exact authenticated internal-DM predicate injected by the runtime. */
  readonly peerIsTrustedInternal?: (chatJid: string) => boolean;
}

interface MutableTurnDeliveryEvidence {
  readonly turnId: string;
  readonly epoch: number;
  readonly opIds: Record<OutboundMessageRole, number[]>;
}

interface TurnEvidenceFlush {
  readonly evidence: MutableTurnDeliveryEvidence;
  readonly completion: Promise<TurnDeliveryEvidence>;
}

interface QueuedOutboundChunk {
  readonly text: string;
  readonly role: OutboundMessageRole;
  readonly turnId: string | undefined;
  readonly turnEvidenceEpoch: number | undefined;
  readonly chatJid: string;
  readonly conversationKey: string;
  readonly sourceInboundSeq: number | undefined;
}

interface BufferedStreamPart {
  readonly text: string;
  readonly role: OutboundMessageRole;
  readonly turnId: string | undefined;
  readonly turnEvidenceEpoch: number | undefined;
  readonly chatJid: string;
  readonly conversationKey: string;
  readonly sourceInboundSeq: number | undefined;
}

interface BufferedToolUpdate {
  readonly update: ToolUpdate;
  readonly role: OutboundMessageRole;
  readonly turnId: string | undefined;
  readonly turnEvidenceEpoch: number | undefined;
  readonly chatJid: string;
  readonly conversationKey: string;
  readonly sourceInboundSeq: number | undefined;
}

type OutboundAttribution = Omit<QueuedOutboundChunk, 'text'>;

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
// QR-126: hard cap on how many chunks a single reply may fan out into. Without it,
// splitMessage emits ceil(len / MAX_MESSAGE_LENGTH) messages, so a prompt-injected
// max-length agent reply becomes single-turn message amplification — group spam plus a
// WhatsApp anti-spam / bot-ban availability risk (a crafted reply reaches ~64 chunks).
// At the cap the bot delivers MAX_CHUNKS-1 full content chunks (~44 KB) followed by a
// visible truncation notice; the tail is dropped rather than flooding the chat.
export const MAX_CHUNKS = 12;
const CHUNK_TRUNCATION_NOTICE = '… [reply truncated]';
// Exported so tests can import the exact values rather than hardcoding them.
// Changing a constant here will automatically break tests that rely on it.
export const TOOL_BATCH_DELAY_MS = 5000;
export const TOOL_BATCH_MAX_AGE_MS = 30_000;
export const MIN_SEND_GAP_MS = 500;
/** Re-assert composing every N ms — WA auto-clears the indicator on the recipient side after ~10-15s. */
export const TYPING_REFRESH_MS = 8_000;
/**
 * Hard upper bound on how long a single composing indicator may be re-asserted
 * without fresh turn activity. Safety net: if a future code path ever leaks a
 * turn end, the indicator self-clears within this window instead of forever.
 * Set well above the longest legitimate single tool chain; streaming text
 * re-arms typing and resets this clock.
 */
export const TYPING_MAX_MS = 300_000; // 5 min
export const SEND_TIMEOUT_MS = 15_000;
const OUTBOUND_SHUTDOWN_DEADLINE = Symbol('outbound_shutdown_deadline');
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
/**
 * PR-E: hard per-turn cap on STATUS NARRATION messages (the `⚙️ Working on: • …`
 * tool batches and the `_… Still working …_` progress placeholders). Bounds the
 * dominant chat-flood source (52/83 status on 07-09) without ever touching the
 * user's actual content/answer/media — content paths are never gated. Tunable
 * via config.operationTracker.maxStatusMessagesPerTurn; per-instance/test
 * override via setMaxStatusMessagesPerTurn(). Conservative default; existing
 * batching tests emit < 10 so there is no regression.
 */
export const MAX_STATUS_MESSAGES_PER_TURN = 10;
/**
 * Cross-turn status budget aligned with the transport flood detector window.
 * A burst of related inbound messages can create several logical turns in one
 * chat; the per-turn cap alone resets between them and can therefore exceed the
 * transport's 20-send threshold even when every individual turn is bounded.
 */
export const MAX_STATUS_MESSAGES_PER_WINDOW = 10;
export const STATUS_MESSAGE_WINDOW_MS = 5 * 60_000;
/**
 * PR-E: the single friendly note sent the first time a turn trips the status cap.
 * Classified as status delivery evidence, but emitted outside the counter gate so
 * it cannot recursively consume the exhausted budget or suppress itself.
 */
export const STATUS_CAP_NOTICE =
  "_(still working — I'll stop the step-by-step and send the result when it's ready)_";
/**
 * PR-E telemetry: log `high-volume turn` ONCE when a turn's total enqueued
 * message count crosses this watermark. Observability for PR-G only — it NEVER
 * gates or suppresses a send.
 */
export const HIGH_VOLUME_TURN_WATERMARK = 40;
/** Hard cap on the terminal-text dedup map so it can't grow unbounded between window prunes. */
const MAX_TERMINAL_TEXT_DEDUPE_KEYS = 1_000;

interface TerminalTextDedupeEntry {
  lastSeenAt: number;
  suppressedCount: number;
}

interface StatusMessageWindowState {
  emittedAt: number[];
  noticeSentAt: number | undefined;
  guardLoggedAt: number | undefined;
  lastTouchedAt: number;
}

const MAX_STATUS_WINDOW_STATES = 1_000;
const statusMessageWindows = new Map<string, StatusMessageWindowState>();

function statusMessageWindowState(senderToken: string, now: number): StatusMessageWindowState {
  const existing = statusMessageWindows.get(senderToken);
  if (existing) {
    existing.lastTouchedAt = now;
    return existing;
  }

  if (statusMessageWindows.size >= MAX_STATUS_WINDOW_STATES) {
    let oldestToken: string | undefined;
    let oldestTouchedAt = Number.POSITIVE_INFINITY;
    for (const [token, state] of statusMessageWindows) {
      if (state.lastTouchedAt < oldestTouchedAt) {
        oldestToken = token;
        oldestTouchedAt = state.lastTouchedAt;
      }
    }
    if (oldestToken !== undefined) statusMessageWindows.delete(oldestToken);
  }

  const created: StatusMessageWindowState = {
    emittedAt: [],
    noticeSentAt: undefined,
    guardLoggedAt: undefined,
    lastTouchedAt: now,
  };
  statusMessageWindows.set(senderToken, created);
  return created;
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

  // QR-126: bound the fan-out. repairChunkFormatting (the sole downstream transform in
  // both send paths) only rewrites existing chunks in place — it never adds chunks — so
  // capping here bounds the number of WhatsApp messages actually sent. Keep the first
  // MAX_CHUNKS-1 content chunks and replace the tail with a single visible notice.
  if (chunks.length > MAX_CHUNKS) {
    return [...chunks.slice(0, MAX_CHUNKS - 1), CHUNK_TRUNCATION_NOTICE];
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
  enqueueText(text: string, role?: OutboundMessageRole): void;
  /** Enqueue streaming text delta — aggregated with debounce to prevent per-token message spam from streaming providers. */
  enqueueStreamingText(text: string, role?: OutboundMessageRole): void;
  /** Enqueue result/summary text. In minimal mode, suppressed if the turn already sent visible output. */
  enqueueResultText(text: string, role?: OutboundMessageRole): void;
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
  /** Stop waiting on transport so durable finalization owns the shutdown budget. */
  preemptForShutdown?(deadlineAt: number): void;
  abortTurn(options?: { preserveEvidence?: boolean }): void;
  /** The chat JID this queue is currently targeting. */
  readonly targetChatJid: string;
  /** Opaque echo-guard token. Exposed so a replacement queue can INHERIT the
   *  prior queue's token (QR-069) — without this, a queue replaced within the
   *  group cooldown window gets a fresh random token and its legitimate reply is
   *  silently flood-suppressed. */
  getSenderToken(): string;
  /** Retarget subsequent sends without changing durable conversation attribution. */
  updateDeliveryJid(jid: string): void;
  /** Set the current inbound seq so outbound ops can link back to inbound events. */
  setInboundSeq(seq: number | undefined): void;
  /** Return the id of the most recently created outbound op, or undefined if none. */
  getLastOpId(): number | undefined;
  /** Clear the tracked last outbound op id without touching durability. */
  clearLastOpId(): void;
  /** Start collecting durability op ids for one logical turn. */
  beginTurnEvidence(turnId: string): void;
  /** Flush all sends and consume an immutable durability evidence snapshot for the turn. */
  flushTurnEvidence(turnId: string): Promise<TurnDeliveryEvidence>;
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
  private deliveryJid: string;
  private readonly conversationKey: string;
  private durability: DurabilityEngine | undefined;
  /** inbound_events.seq for the current turn — threaded to outbound ops as sourceInboundSeq */
  private currentInboundSeq: number | undefined;
  /** The outbound_ops.id of the most recently created op (for markLastTerminal). */
  private lastOpId: number | undefined;
  /** Mutable evidence for the sole turn currently owned by this queue. */
  private activeTurnEvidence: MutableTurnDeliveryEvidence | undefined;
  private nextTurnEvidenceEpoch = 0;
  /** Last consumed snapshot, retained only to make a repeated flush idempotent. */
  private completedTurnEvidence: TurnDeliveryEvidence | undefined;
  /** Single-flight completion for the active evidence epoch. */
  private turnEvidenceFlush: TurnEvidenceFlush | undefined;
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

  /** PR-E: status-narration messages emitted this turn. Gates status ONLY, never content. */
  private turnStatusCount = 0;
  /** PR-E: whether the one-time STATUS_CAP_NOTICE has already been sent this turn. */
  private statusCapNoticeSent = false;
  /** PR-E: total messages enqueued this turn — telemetry only, NEVER gates a send. */
  private turnTotalCount = 0;
  /** PR-E: per-turn status-narration budget (ms n/a — a message count). Override via config/test setter. */
  private maxStatusMessagesPerTurn: number =
    config.operationTracker?.maxStatusMessagesPerTurn ?? MAX_STATUS_MESSAGES_PER_TURN;
  /** Status-narration budget shared across turns and inherited queue replacements. */
  private maxStatusMessagesPerWindow: number =
    config.operationTracker?.maxStatusMessagesPerWindow ?? MAX_STATUS_MESSAGES_PER_WINDOW;
  private statusMessageWindowMs: number =
    config.operationTracker?.statusMessageWindowMs ?? STATUS_MESSAGE_WINDOW_MS;

  /** Queue of text chunks ready to send with enqueue-time attribution. */
  private sendQueue: QueuedOutboundChunk[] = [];
  /** Whether a send is currently in-flight. */
  private sending = false;
  /** Timestamp (ms) of the last completed send. */
  private lastSentAt = 0;

  /** Buffered tool update objects, waiting to be flushed as a batch. */
  private toolBuffer: BufferedToolUpdate[] = [];
  /** Timer handle for the idle batch window (resets on each new tool call). */
  private toolTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timer handle for the max-age flush (set once when the buffer first fills, never reset). */
  private toolMaxAgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether a composing presence update is currently active. */
  private isTyping = false;
  /** Interval that periodically re-asserts composing while a turn is in progress. */
  private typingRefreshInterval: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock (ms) when the current composing indicator was (re)started. */
  private typingStartedAt = 0;

  /** Promise chain used to serialize sends. */
  private chain: Promise<void> = Promise.resolve();
  /** Sticky drain failure. A poisoned queue is never retried in-place. */
  private drainFailure: { readonly error: unknown } | undefined;
  /** One shared signal that can preempt an already-running send attempt at shutdown. */
  private readonly shutdownDeadlineSignal: Promise<typeof OUTBOUND_SHUTDOWN_DEADLINE>;
  private resolveShutdownDeadlineSignal: (() => void) | null = null;
  private shutdownDeadlineReached = false;

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

  /** T8-F2: injected fallback-window query (see OutboundQueueOptions). */
  private readonly fallbackActiveFn: (() => boolean) | undefined;
  /** T8-F1: injected admin-peer resolver (see OutboundQueueOptions). */
  private readonly peerIsAdminFn: ((chatJid: string) => boolean) | undefined;
  private readonly peerIsTrustedInternalFn: ((chatJid: string) => boolean) | undefined;

  constructor(
    messenger: Messenger,
    deliveryJid: string,
    options?: OutboundQueueOptions,
  ) {
    this.messenger = messenger;
    this.deliveryJid = deliveryJid;
    this.conversationKey = options?.conversationKey ?? toConversationKey(deliveryJid);
    this.shutdownDeadlineSignal = new Promise((resolve) => {
      this.resolveShutdownDeadlineSignal = () => resolve(OUTBOUND_SHUTDOWN_DEADLINE);
    });
    // QR-069: a replacement queue (provider fallback/respawn, /new, resume) for
    // the same chat INHERITS the prior queue's token so its first reply is NOT
    // flood-suppressed by the predecessor's still-active group cooldown. Falls
    // back to a fresh token for a genuinely new queue.
    this.senderToken = options?.senderToken ?? crypto.randomUUID();
    this.fallbackActiveFn = options?.fallbackActive;
    this.peerIsAdminFn = options?.peerIsAdmin;
    this.peerIsTrustedInternalFn = options?.peerIsTrustedInternal;
  }

  /** The echo-guard token for this queue (QR-069: inherited by a replacement). */
  getSenderToken(): string {
    return this.senderToken;
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

  /** Attach an optional DurabilityEngine to track outbound ops. */
  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
  }

  setInboundSeq(seq: number | undefined): void {
    this.currentInboundSeq = seq;
  }

  beginTurnEvidence(turnId: string): void {
    if (turnId.trim() === '') {
      throw new Error('Turn evidence requires a non-empty turn id');
    }
    if (this.activeTurnEvidence) {
      if (this.activeTurnEvidence.turnId === turnId) return;
      throw new Error(
        `Turn evidence already belongs to ${this.activeTurnEvidence.turnId}; cannot begin ${turnId}`,
      );
    }
    if (this.completedTurnEvidence?.turnId === turnId) {
      throw new Error(`Turn evidence for ${turnId} was already completed`);
    }
    this.completedTurnEvidence = undefined;
    this.activeTurnEvidence = {
      turnId,
      epoch: ++this.nextTurnEvidenceEpoch,
      opIds: {
        answer: [],
        lifecycle: [],
        status: [],
      },
    };
  }

  async flushTurnEvidence(turnId: string): Promise<TurnDeliveryEvidence> {
    const inFlight = this.turnEvidenceFlush;
    if (inFlight) {
      if (inFlight.evidence.turnId !== turnId) {
        throw new Error(`Turn evidence belongs to ${inFlight.evidence.turnId}; cannot flush ${turnId}`);
      }
      return OutboundQueue.copyTurnEvidence(await inFlight.completion);
    }

    const active = this.activeTurnEvidence;
    if (!active) {
      if (this.completedTurnEvidence?.turnId === turnId) {
        return OutboundQueue.copyTurnEvidence(this.completedTurnEvidence);
      }
      throw new Error(`No active turn evidence belongs to ${turnId}`);
    }
    if (active.turnId !== turnId) {
      throw new Error(`Turn evidence belongs to ${active.turnId}; cannot flush ${turnId}`);
    }

    const completion = this.completeTurnEvidence(active);
    this.turnEvidenceFlush = { evidence: active, completion };
    return OutboundQueue.copyTurnEvidence(await completion);
  }

  private async completeTurnEvidence(
    active: MutableTurnDeliveryEvidence,
  ): Promise<TurnDeliveryEvidence> {
    try {
      await this.flush();
      this.assertEvidenceComplete();
      if (this.activeTurnEvidence !== active) {
        throw new Error(`Turn evidence for ${active.turnId} was invalidated before flush completed`);
      }

      const completed = OutboundQueue.freezeTurnEvidence(active);
      this.activeTurnEvidence = undefined;
      this.completedTurnEvidence = completed;
      return completed;
    } finally {
      if (this.turnEvidenceFlush?.evidence === active) {
        this.turnEvidenceFlush = undefined;
      }
    }
  }

  private static freezeTurnEvidence(evidence: MutableTurnDeliveryEvidence): TurnDeliveryEvidence {
    return Object.freeze({
      turnId: evidence.turnId,
      answerOpIds: Object.freeze([...evidence.opIds.answer]),
      lifecycleOpIds: Object.freeze([...evidence.opIds.lifecycle]),
      statusOpIds: Object.freeze([...evidence.opIds.status]),
    });
  }

  private static copyTurnEvidence(evidence: TurnDeliveryEvidence): TurnDeliveryEvidence {
    return Object.freeze({
      turnId: evidence.turnId,
      answerOpIds: Object.freeze([...evidence.answerOpIds]),
      lifecycleOpIds: Object.freeze([...evidence.lifecycleOpIds]),
      statusOpIds: Object.freeze([...evidence.statusOpIds]),
    });
  }

  private recordTurnOp(chunk: QueuedOutboundChunk, opId: number): void {
    if (
      chunk.turnId === undefined
      || this.activeTurnEvidence?.turnId !== chunk.turnId
      || this.activeTurnEvidence.epoch !== chunk.turnEvidenceEpoch
    ) return;
    this.activeTurnEvidence.opIds[chunk.role].push(opId);
  }

  private snapshotAttribution(role: OutboundMessageRole): OutboundAttribution {
    return {
      role,
      turnId: this.activeTurnEvidence?.turnId,
      turnEvidenceEpoch: this.activeTurnEvidence?.epoch,
      chatJid: this.deliveryJid,
      conversationKey: this.conversationKey,
      sourceInboundSeq: this.currentInboundSeq,
    };
  }

  private static sameAttribution(
    left: OutboundAttribution,
    right: OutboundAttribution,
  ): boolean {
    return left.role === right.role
      && left.turnId === right.turnId
      && left.turnEvidenceEpoch === right.turnEvidenceEpoch
      && left.chatJid === right.chatJid
      && left.conversationKey === right.conversationKey
      && left.sourceInboundSeq === right.sourceInboundSeq;
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
  private streamBufferParts: BufferedStreamPart[] = [];
  /** Timer for flushing aggregated streaming text after a pause. */
  private streamTimer: ReturnType<typeof setTimeout> | null = null;

  /** Enqueue a text message for immediate sending (after pacing). */
  enqueueText(text: string, role: OutboundMessageRole = 'answer'): void {
    if (!text || text.trim() === '') return;
    const attribution = this.snapshotAttribution(role);
    // Flush any pending streaming buffer first to maintain ordering
    this.flushStreamBuffer();
    this.turnHasVisibleText = true;
    this.enqueuePreparedText(text, attribution);
  }

  private enqueuePreparedText(
    text: string,
    attribution: OutboundAttribution,
  ): void {
    // QR-114: scrub operator-local internal artifacts (home/tilde/whatsoup paths,
    // provider secrets/tokens, tailnet IPs) before the reply reaches the user —
    // mirrors the chat runtime's redactInternalArtifacts on the response. Applied
    // to the assembled text BEFORE splitMessage so a secret is never split across
    // chunks (boundary-safe). Audience-scoped: operator-owned internal groups keep
    // the fleet's coordination vocabulary (paths, hook names, bead `Files:` lists)
    // and only have secrets/emails masked — client chats get the full scrub.
    //
    // T8-F1+F2: an admin's 1:1 DM chat on the trusted primary (no fallback
    // window) is ALSO an operator channel — ctx is optional and only present
    // when the runtime injected both callbacks at construction (see
    // OutboundQueueOptions). fallbackActive fails CLOSED (missing callback ⇒
    // treated as active ⇒ full scrub) so an un-injected queue never silently
    // elevates.
    const isGroup = isGroupJid(attribution.chatJid);
    const ctx = this.peerIsAdminFn || this.peerIsTrustedInternalFn
      ? {
          isGroup,
          peerIsAdmin: this.peerIsAdminFn?.(attribution.chatJid) ?? false,
          peerIsTrustedInternal:
            this.peerIsTrustedInternalFn?.(attribution.chatJid) ?? false,
          fallbackActive: this.fallbackActiveFn ? this.fallbackActiveFn() : true,
        }
      : undefined;
    const safe = redactInternalArtifacts(text, resolveOutboundAudience(attribution.chatJid, ctx)).text;
    const chunks = repairChunkFormatting(splitMessage(preprocessText(safe)));
    for (const chunk of chunks) {
      this.enqueue(chunk, attribution);
    }
  }

  /**
   * Enqueue streaming text delta — aggregates fragments with a debounce timer.
   * Use this for `assistant_text` events from streaming providers (codex-cli, gemini-cli)
   * that emit per-token or per-line deltas. Text is buffered and flushed after
   * TEXT_AGGREGATE_DELAY_MS of silence, producing batched messages instead of spam.
   */
  enqueueStreamingText(text: string, role: OutboundMessageRole = 'answer'): void {
    if (!text) return;
    this.turnHasVisibleText = true;
    this.streamBufferParts.push({ text, ...this.snapshotAttribution(role) });
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
    const parts = this.streamBufferParts;
    this.streamBufferParts = [];
    let group: BufferedStreamPart[] = [];
    const flushGroup = (): void => {
      if (group.length === 0) return;
      const { text: _firstText, ...attribution } = group[0];
      const text = group.map((part) => part.text).join('');
      if (text.trim() !== '') {
        this.enqueuePreparedText(text, attribution);
      }
      group = [];
    };
    for (const part of parts) {
      const prior = group[0];
      if (prior && !OutboundQueue.sameAttribution(prior, part)) {
        flushGroup();
      }
      group.push(part);
    }
    flushGroup();
  }

  /**
   * Enqueue the result/summary text from a completed turn.
   * In minimal mode, suppresses the text if the turn already produced visible
   * output — Claude Code often appends an internal task summary ("Done — I sent
   * the message and asked for...") that shouldn't reach non-technical users.
   */
  enqueueResultText(text: string, role: OutboundMessageRole = 'answer'): void {
    if (!text || text.trim() === '') return;
    if (this.toolUpdateMode === 'minimal' && this.turnHasVisibleText) {
      // Suppress — the user already got the real response during the turn
      return;
    }
    this.enqueueText(text, role);
  }

  /**
   * Buffer a tool progress update. Updates are sent either when there is a
   * 3-second idle gap between tool calls, or after 30 seconds maximum —
   * whichever comes first. This prevents silent gaps during long tool chains.
   *
   * In minimal mode, updates are suppressed to keep the user experience clean.
   * The typing indicator remains active while work is in progress.
   */
  enqueueToolUpdate(update: ToolUpdate): void {
    if (this.toolUpdateMode === 'minimal') {
      this.startTyping();
      return;
    }
    // Friendly mode: let everything through (no filtering), but skip internal noise
    // that adds no user value (skill lookups, cancelled ops).
    if (this.toolUpdateMode === 'friendly') {
      if (update.category === 'skill' || update.category === 'cancelled') {
        this.startTyping();
        return;
      }
    }
    this.toolBuffer.push({ update, ...this.snapshotAttribution('status') });
    this.startTyping();

    // Idle timer: reset on each new tool call, fires after a pause in tool activity.
    if (this.toolTimer !== null) clearTimeout(this.toolTimer);
    this.toolTimer = setTimeout(() => this.flushToolBuffer(), TOOL_BATCH_DELAY_MS);

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
          this.startTyping();
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
        // One-shot slow timer fires once at the fixed threshold, so elapsed is constant \u2014 a threshold, not a live clock (#1843; mirrors #1777).
        if (this.toolUpdateMode === 'minimal') {
          this.startTyping();
        } else if (this.toolUpdateMode === 'friendly') {
          this.enqueueProgress(`_${name} is still working on it..._`);
        } else {
          this.enqueueProgress(`_\u23f3 ${name} is taking longer than expected..._`);
        }
        return;
      }

      case 'operation_stalled': {
        if (this.pollPending) {
          this.startTyping();
          return;
        }
        // One-shot stall timer fires once at the fixed threshold, so elapsed is constant \u2014 a threshold, not a live clock (#1777).
        if (this.toolUpdateMode === 'minimal') {
          this.startTyping();
        } else if (this.toolUpdateMode === 'friendly') {
          this.enqueueProgress(`_${name}: still working \u2014 this is taking a while..._`);
        } else {
          this.enqueueProgress(`_\u23f3 ${name}: still working \u2014 this is taking a while..._`);
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
    const attribution = this.snapshotAttribution('status');

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
        { chatJid: this.deliveryJid, floorMs: this.progressFloorMs },
        'progress placeholder suppressed by per-chat rate floor',
      );
      return;
    }

    this.pruneProgressTextDedupe(now);
    const lastAt = this.recentProgressTextAt.get(text);
    if (lastAt !== undefined && now - lastAt < PROGRESS_TEXT_DEDUPE_WINDOW_MS) {
      // Identical placeholder already shown recently \u2014 keep the indicator alive, drop the duplicate.
      this.startTyping();
      log.info({ chatJid: this.deliveryJid, windowMs: PROGRESS_TEXT_DEDUPE_WINDOW_MS }, 'coalesced duplicate progress placeholder');
      return;
    }
    // PR-E: hard per-turn status-narration cap. The floor + text window above
    // already decided this placeholder WOULD emit; enforce the per-turn count
    // now so a single turn can't flood the chat with narration. Past the cap,
    // keep the liveness signal and drop the placeholder — content is never gated.
    if (this.statusBudgetExhausted(attribution)) {
      return;
    }
    this.recentProgressTextAt.set(text, now);
    // Record the floor slot only on an ACTUAL emit (passed both floor and text window).
    this.lastProgressEmittedAt = now;
    this.enqueue(text, attribution);
  }

  /**
   * Override the per-chat progress-placeholder rate floor (ms). 0 disables.
   * Production value comes from config; this setter supports per-instance runtime
   * tuning and deterministic tests.
   */
  setProgressFloorMs(ms: number): void {
    this.progressFloorMs = Math.max(0, ms);
  }

  /**
   * Override the per-turn status-narration cap (message count). Production value
   * comes from config.operationTracker.maxStatusMessagesPerTurn; this setter
   * supports per-instance runtime tuning and deterministic tests.
   */
  setMaxStatusMessagesPerTurn(n: number): void {
    this.maxStatusMessagesPerTurn = Math.max(0, Math.floor(n));
  }

  /** Override the persistent cross-turn status budget for tests or instance policy. */
  setStatusMessageWindow(maxMessages: number, windowMs: number): void {
    this.maxStatusMessagesPerWindow = Math.max(0, Math.floor(maxMessages));
    this.statusMessageWindowMs = Math.max(1, Math.floor(windowMs));
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
    this.assertDrainComplete();
    await sendFn();
  }

  hasPendingPoll(): boolean {
    return this.pollPending;
  }

  setPollPending(pending: boolean): void {
    this.pollPending = pending;
  }

  preemptForShutdown(deadlineAt: number): void {
    if (!Number.isFinite(deadlineAt)) {
      throw new Error('Outbound shutdown deadline must be finite');
    }
    if (this.shutdownDeadlineReached) return;
    this.shutdownDeadlineReached = true;
    const resolve = this.resolveShutdownDeadlineSignal;
    this.resolveShutdownDeadlineSignal = null;
    resolve?.();
  }

  /** Flush all pending messages (tool buffer + send queue) immediately. */
  async flush(): Promise<void> {
    this.lastActivity = Date.now();
    this.flushStreamBuffer();
    this.flushToolBuffer();
    this.throwDrainFailure();
    // Wait for the current chain to drain
    await this.chain;
    this.assertDrainComplete();
    // All messages delivered — clear typing indicator and per-turn state
    this.stopTyping();
    this.friendlyProgressSent.clear();
    this.recentProgressTextAt.clear();
    this.turnHasVisibleText = false;
  }

  /** Flush pending messages and clear all timers. */
  async shutdown(): Promise<void> {
    await this.flush();
    this.activeTurnEvidence = undefined;
    this.completedTurnEvidence = undefined;
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
  abortTurn(options: { preserveEvidence?: boolean } = {}): void {
    if (this.toolTimer !== null) { clearTimeout(this.toolTimer); this.toolTimer = null; }
    if (this.toolMaxAgeTimer !== null) { clearTimeout(this.toolMaxAgeTimer); this.toolMaxAgeTimer = null; }
    if (this.streamTimer !== null) { clearTimeout(this.streamTimer); this.streamTimer = null; }
    this.streamBufferParts = [];
    this.toolBuffer = [];
    this.friendlyProgressSent.clear();
    this.recentProgressTextAt.clear();
    this.turnHasVisibleText = false;
    this.stopTyping(false);
    // PR-E: crash path — reset per-turn status-cap state so the replacement/next
    // turn starts with a full budget (same reset as endTurn()).
    this.turnStatusCount = 0;
    this.turnTotalCount = 0;
    this.statusCapNoticeSent = false;
    if (!options.preserveEvidence) {
      this.activeTurnEvidence = undefined;
      this.completedTurnEvidence = undefined;
    }
    // Deliberately retain sendQueue and drainFailure. A failed durability write
    // leaves op identity unknown; only queue replacement may recover safely.
  }

  get targetChatJid(): string { return this.deliveryJid; }

  hasPendingWork(): boolean {
    return this.drainFailure !== undefined
      || this.sending
      || this.sendQueue.length > 0
      || this.toolBuffer.length > 0
      || this.streamBufferParts.length > 0
      || this.isTyping
      || this.toolTimer !== null
      || this.toolMaxAgeTimer !== null
      || this.streamTimer !== null;
  }

  /** Retarget subsequent sends without changing durable conversation attribution. */
  updateDeliveryJid(jid: string): void {
    this.deliveryJid = jid;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Start composing indicator and keep it alive with a periodic refresh. Idempotent. */
  private startTyping(): void {
    // Always refresh the self-bound clock so ongoing turn activity keeps the
    // indicator alive; only arm a new interval when not already typing.
    this.typingStartedAt = Date.now();
    if (this.isTyping) return;
    this.isTyping = true;
    this.messenger.setTyping?.(this.deliveryJid, true).catch((err) => log.warn({ err }, 'outbound-queue: setTyping(true) rejected'));
    // Re-assert composing every 8s — WA auto-clears it on the recipient side after ~10-15s.
    // This keeps the indicator alive during long tool chains with no intermediate messages.
    // The self-bound check caps the total lifetime to TYPING_MAX_MS so any future leak
    // self-heals instead of persisting indefinitely.
    this.typingRefreshInterval = setInterval(() => {
      if (Date.now() - this.typingStartedAt > TYPING_MAX_MS) {
        // Self-bound tripped — stop re-asserting. WA clears composing on the
        // recipient side after ~10-15s. Do NOT send 'paused' (avoid masking a
        // genuine crash signal); just stop the heartbeat.
        this.stopTyping(false);
        return;
      }
      this.messenger.setTyping?.(this.deliveryJid, true).catch((err) => log.warn({ err }, 'outbound-queue: setTyping(true) refresh rejected'));
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
      this.messenger.setTyping?.(this.deliveryJid, false).catch((err) => log.warn({ err }, 'outbound-queue: setTyping(false) rejected'));
    }
  }

  /**
   * Turn-end choke point. Called unconditionally when a `result` event is
   * received, so any buffered streaming fragments are delivered and the typing
   * indicator is cleared, even on early-return branches of the runtime result
   * handler that never reach flush(). Idempotent.
   *
   * Ordering: flush stream buffer first so buffered text is delivered as part of
   * this turn rather than firing 2s later into an idle persistent session.
   * Then stop typing. The subsequent queue.flush() on the normal path is a no-op
   * for both (buffer already empty, typing already stopped).
   */
  endTurn(): void {
    this.flushStreamBuffer();
    this.stopTyping();
    // PR-E: reset the per-turn status-cap state on the UNCONDITIONAL turn-end
    // choke (incl. early-break provider-failure branches that never reach
    // flush()). Resetting HERE — not in flush(), which the poll loop calls
    // mid-turn — prevents a prior turn's exhausted budget from silently
    // silencing the next turn (adversarial E1) and prevents a mid-turn refill
    // (adversarial E3).
    this.turnStatusCount = 0;
    this.turnTotalCount = 0;
    this.statusCapNoticeSent = false;
  }

  /**
   * PR-E status-narration budget gate. Returns true if the caller should SKIP
   * emitting this status narration (per-turn budget exhausted), false if it may
   * proceed (consuming one unit of budget). ONLY the two status-narration
   * sources — flushToolBuffer() and enqueueProgress() — call this; content
   * paths (enqueueText/enqueueStreamingText/flushStreamBuffer/enqueueResultText)
   * never do, so content is never gated. Past the cap the liveness signal is
   * preserved (startTyping) so the user still sees "typing…" without the flood.
   */
  private statusBudgetExhausted(attribution: OutboundAttribution): boolean {
    const now = Date.now();
    const windowState = statusMessageWindowState(this.senderToken, now);
    const cutoff = now - this.statusMessageWindowMs;
    windowState.emittedAt = windowState.emittedAt.filter((emittedAt) => emittedAt > cutoff);
    if (windowState.noticeSentAt !== undefined && windowState.noticeSentAt <= cutoff) {
      windowState.noticeSentAt = undefined;
    }
    if (windowState.guardLoggedAt !== undefined && windowState.guardLoggedAt <= cutoff) {
      windowState.guardLoggedAt = undefined;
    }

    if (windowState.emittedAt.length >= this.maxStatusMessagesPerWindow) {
      this.startTyping();
      if (windowState.guardLoggedAt === undefined) {
        windowState.guardLoggedAt = now;
        log.warn(
          {
            chatJid: attribution.chatJid,
            count: windowState.emittedAt.length,
            maxMessages: this.maxStatusMessagesPerWindow,
            windowMs: this.statusMessageWindowMs,
            outcome: 'status-suppressed',
          },
          'outbound flood-guard tripped',
        );
      }
      if (windowState.noticeSentAt === undefined) {
        windowState.noticeSentAt = now;
        this.flushStreamBuffer();
        this.turnHasVisibleText = true;
        this.enqueuePreparedText(STATUS_CAP_NOTICE, attribution);
      }
      return true;
    }

    if (this.turnStatusCount >= this.maxStatusMessagesPerTurn) {
      this.startTyping(); // keep the liveness signal, drop the narration
      if (!this.statusCapNoticeSent) {
        this.statusCapNoticeSent = true;
        windowState.noticeSentAt ??= now;
        this.flushStreamBuffer();
        this.turnHasVisibleText = true;
        this.enqueuePreparedText(STATUS_CAP_NOTICE, attribution);
      }
      return true;
    }
    windowState.emittedAt.push(now);
    this.turnStatusCount++;
    return false;
  }

  private flushToolBuffer(): void {
    if (this.toolTimer !== null) { clearTimeout(this.toolTimer); this.toolTimer = null; }
    if (this.toolMaxAgeTimer !== null) { clearTimeout(this.toolMaxAgeTimer); this.toolMaxAgeTimer = null; }
    if (this.toolBuffer.length === 0) return;

    const buffered = this.toolBuffer;
    this.toolBuffer = [];
    if (this.toolUpdateRedirectJid !== null) {
      const redirectJid = this.toolUpdateRedirectJid;
      const statusText = this.renderToolUpdates(buffered.map(({ update }) => update));
      const safeStatusText = redactInternalArtifacts(
        statusText,
        resolveOutboundAudience(redirectJid),
      ).text;
      this.messenger.sendMessage(redirectJid, safeStatusText).catch((err) => {
        log.warn({ err, target: redirectJid, textLength: safeStatusText.length }, 'tool-status redirect send failed');
      });
      return;
    }

    const batches: Array<{ attribution: OutboundAttribution; updates: ToolUpdate[] }> = [];
    for (const item of buffered) {
      const batch = batches.at(-1);
      if (!batch || !OutboundQueue.sameAttribution(batch.attribution, item)) {
        const { update: _update, ...attribution } = item;
        batches.push({ attribution, updates: [item.update] });
      } else {
        batch.updates.push(item.update);
      }
    }

    for (const batch of batches) {
      if (this.statusBudgetExhausted(batch.attribution)) continue;
      this.flushStreamBuffer();
      this.turnHasVisibleText = true;
      this.enqueuePreparedText(this.renderToolUpdates(batch.updates), batch.attribution);
    }
  }

  private renderToolUpdates(updates: readonly ToolUpdate[]): string {
    // Group updates by category, preserving first-appearance order of categories.
    // Deduplicate detail strings within each category to avoid "Checking my notes on X" x2.
    const categoryOrder: ToolCategory[] = [];
    const groups = new Map<ToolCategory, string[]>();
    for (const { category, detail } of updates) {
      const safeDetail = hasVisibleToolText(detail) ? detail : formatProviderErrorForUser(undefined);
      if (!groups.has(category)) {
        categoryOrder.push(category);
        groups.set(category, []);
      }
      const existing = groups.get(category)!;
      if (!existing.includes(safeDetail)) {
        existing.push(safeDetail);
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

    return sections.join('\n\n');
  }

  private enqueue(
    chunk: string,
    attribution: OutboundAttribution,
  ): void {
    if (this.suppressDuplicateTerminalText(chunk, attribution.chatJid)) {
      return;
    }
    // PR-E telemetry: count every message actually enqueued this turn (content
    // AND status). NEVER gates a send — crossing the high-volume watermark logs
    // ONCE for PR-G/observability so a pure-content runaway is visible even
    // though E deliberately never drops content.
    this.turnTotalCount++;
    if (this.turnTotalCount === HIGH_VOLUME_TURN_WATERMARK) {
      log.warn({ chatJid: attribution.chatJid, count: this.turnTotalCount }, 'high-volume turn');
    }
    this.lastActivity = Date.now();
    this.sendQueue.push({ text: chunk, ...attribution });
    if (!this.sending) {
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    if (this.drainFailure) return;
    this.sending = true;
    this.chain = this.chain
      .then(async () => {
        while (this.sendQueue.length > 0) {
          const chunk = this.sendQueue[0]!;
          await this.sendWithPacing(chunk);
          this.sendQueue.shift();
          // WA clears the composing indicator on message delivery. Re-assert
          // it immediately so there's no visible gap between mid-turn messages
          // (e.g. compact_boundary notification followed by continued output).
          if (this.isTyping) {
            this.messenger.setTyping?.(chunk.chatJid, true).catch((err) => log.warn({ err }, 'outbound-queue: setTyping(chunk) rejected'));
          }
        }
        this.sending = false;
      })
      .catch((err) => {
        // Keep the failed head chunk and all following work in place. A
        // durability exception can leave op identity unknown, so retrying it
        // in-place could duplicate delivery or attach it to a later turn.
        this.drainFailure ??= { error: err };
        log.error({ err }, 'drain queue failed — queue poisoned');
        this.sending = false;
      });
  }

  private throwDrainFailure(): void {
    if (this.drainFailure) throw this.drainFailure.error;
  }

  private assertDrainComplete(): void {
    this.throwDrainFailure();
    if (this.sending || this.sendQueue.length > 0) {
      const error = new Error('Outbound queue flush completed with pending send work');
      this.drainFailure = { error };
      throw error;
    }
  }

  private assertEvidenceComplete(): void {
    this.assertDrainComplete();
    if (
      this.toolBuffer.length > 0
      || this.streamBufferParts.length > 0
      || this.toolTimer !== null
      || this.toolMaxAgeTimer !== null
      || this.streamTimer !== null
    ) {
      const error = new Error('Turn evidence flush completed with pending buffered work');
      this.drainFailure = { error };
      throw error;
    }
  }

  private async sendWithPacing(chunk: QueuedOutboundChunk): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed < MIN_SEND_GAP_MS && this.lastSentAt !== 0) {
      const wait = MIN_SEND_GAP_MS - elapsed;
      await this.waitForDelayOrShutdown(wait);
    }
    // AE4: Echo guard — suppress cross-session group echo loops.
    // Passes senderToken so intra-session rapid sends (tool status + text) are exempt.
    if (!canSendToGroup(chunk.chatJid, config.echoGuard, this.senderToken)) {
      return; // silently drop
    }
    await this.sendWithRetry(chunk);
    this.lastSentAt = Date.now();
    recordGroupOutbound(chunk.chatJid, this.senderToken);
  }

  private async sendWithRetry(chunk: QueuedOutboundChunk): Promise<void> {
    const { text } = chunk;
    const textDedupeKey = this.terminalTextDedupeKey('text', chunk.chatJid, text);
    // Create an outbound op before first attempt (if durability is wired)
    let opId: number | undefined;
    if (this.durability) {
      opId = this.durability.createOutboundOp({
        conversationKey: chunk.conversationKey,
        chatJid: chunk.chatJid,
        opType: 'text',
        payload: JSON.stringify({ text }),
        replayPolicy: 'unsafe',
        sourceInboundSeq: chunk.sourceInboundSeq,
      });
      this.lastOpId = opId;
      this.recordTurnOp(chunk, opId);
      this.durability.markSending(opId);
    }

    // QR-028: one stable WhatsApp-shaped message id for this logical send,
    // REUSED across every retry attempt. A send that times out (SEND_TIMEOUT_MS)
    // may already be on the wire; retrying with the SAME id lets the server
    // dedupe it instead of delivering the reply twice. 32 uppercase-hex chars
    // (a dashless UUID) is a valid, unique key.id.
    const stableMessageId = crypto.randomUUID().replace(/-/g, '').toUpperCase();

    let lastEvidence: OutboundFailureEvidenceV1 | undefined;
    let shutdownDeadlineExpired = false;
    for (let attempt = 0; attempt < OutboundQueue.MAX_SEND_ATTEMPTS; attempt++) {
      if (this.shutdownDeadlineReached) {
        shutdownDeadlineExpired = true;
        break;
      }
      try {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let receiptOrDeadline;
        try {
          receiptOrDeadline = await Promise.race([
            this.messenger.sendMessage(chunk.chatJid, text, { messageId: stableMessageId }),
            this.shutdownDeadlineSignal,
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
        if (receiptOrDeadline === OUTBOUND_SHUTDOWN_DEADLINE) {
          shutdownDeadlineExpired = true;
          lastEvidence = createInternalOutboundFailureEvidence({
            failureCode: 'outbound.shutdown_deadline',
            stage: 'provider_request',
            mutationState: 'ambiguous',
            logicalAttemptCount: (lastEvidence?.logical_attempt_count ?? 0) + 1,
            providerSubmissionCount: (lastEvidence?.provider_submission_count ?? 0) + 1,
            previousEvidence: lastEvidence,
            evidenceCoverage: 'partial',
          });
          break;
        }
        if (opId !== undefined && this.durability) {
          this.durability.markSubmitted(
            opId,
            receiptOrDeadline.waMessageId,
            (lastEvidence?.logical_attempt_count ?? 0) + 1,
          );
        }
        this.lastSubmittedTextDedupeKey = textDedupeKey;
        return;
      } catch (err) {
        lastEvidence = classifyOutboundFailure(err, {
          retryOwner: 'agent_queue',
          attemptsRemaining: OutboundQueue.MAX_SEND_ATTEMPTS - attempt - 1,
          previousEvidence: lastEvidence,
        });
        if (
          lastEvidence.retry_decision === 'retry_now'
          || (
            lastEvidence.retry_decision === 'retry_not_before'
            && !this.durability
            && lastEvidence.retry_not_before !== null
            && attempt < OutboundQueue.MAX_SEND_ATTEMPTS - 1
          )
        ) {
          const retryNotBefore = lastEvidence.retry_not_before;
          const delayMs = lastEvidence.retry_decision === 'retry_not_before'
            ? Math.max(1, Date.parse(retryNotBefore!) - Date.now())
            : jitteredDelay(
              OutboundQueue.SEND_RETRY_BASE_MS,
              attempt,
              OutboundQueue.SEND_RETRY_MAX_MS,
            );
          log.warn({
            opId,
            attempt: attempt + 1,
            maxAttempts: OutboundQueue.MAX_SEND_ATTEMPTS,
            failureCode: lastEvidence.failure_code,
            stage: lastEvidence.stage,
            mutationState: lastEvidence.mutation_state,
            delayMs,
          }, 'outbound send failed — retrying');
          if (await this.waitForDelayOrShutdown(delayMs)) {
            shutdownDeadlineExpired = true;
            break;
          }
        } else {
          break;
        }
      }
    }
    if (shutdownDeadlineExpired) {
      lastEvidence = lastEvidence === undefined
        ? createInternalOutboundFailureEvidence({
          failureCode: 'outbound.shutdown_before_send',
          stage: 'admission',
          mutationState: 'not_started',
          logicalAttemptCount: 0,
          providerSubmissionCount: 0,
        })
        : createInternalOutboundFailureEvidence({
          failureCode: 'outbound.shutdown_deadline',
          stage: 'runtime',
          mutationState: lastEvidence.mutation_state,
          logicalAttemptCount: lastEvidence.logical_attempt_count,
          providerSubmissionCount: lastEvidence.provider_submission_count,
          previousEvidence: lastEvidence,
          evidenceCoverage: lastEvidence.evidence_coverage,
        });
      log.warn({
        opId,
        failureCode: lastEvidence.failure_code,
        stage: lastEvidence.stage,
        mutationState: lastEvidence.mutation_state,
      }, 'outbound send stopped at runtime shutdown deadline');
      if (opId !== undefined && this.durability) {
        persistOutboundFailureDisposition(
          this.durability,
          opId,
          lastEvidence,
          lastEvidence.mutation_state === 'ambiguous' ? stableMessageId : undefined,
        );
      }
      return;
    }
    if (!lastEvidence) return;
    log.error({
      opId,
      attempts: lastEvidence.logical_attempt_count,
      providerSubmissions: lastEvidence.provider_submission_count,
      failureCode: lastEvidence.failure_code,
      stage: lastEvidence.stage,
      mutationState: lastEvidence.mutation_state,
      retryDecision: lastEvidence.retry_decision,
    }, 'outbound send stopped with bounded failure disposition');

    if (opId !== undefined && this.durability) {
      persistOutboundFailureDisposition(this.durability, opId, lastEvidence);
    }

    if (outboundFailureWarrantsUserNotice(lastEvidence)) {
      // Best-effort: notify the user that part of the response was lost.
      // Send directly (not through queue) to avoid re-entry loops. Not
      // conditional on durability — the user still needs to know.
      Promise.race([
        this.messenger.sendMessage(chunk.chatJid, '⚠️ A response could not be delivered after 3 attempts.'),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), SEND_TIMEOUT_MS)),
      ]).catch((err) => { log.warn({ err }, 'outbound-queue: delivery failure notification send failed'); });
    }
  }

  private async waitForDelayOrShutdown(delayMs: number): Promise<boolean> {
    if (this.shutdownDeadlineReached) return true;
    if (!Number.isFinite(delayMs)) {
      throw new RangeError('Outbound retry delay must be finite');
    }
    let remainingMs = Math.max(0, delayMs);
    while (remainingMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunkMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
      try {
        const shutdown = await Promise.race([
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), chunkMs);
          }),
          this.shutdownDeadlineSignal.then(() => true as const),
        ]);
        if (shutdown) return true;
      } finally {
        clearTimeout(timer);
      }
      remainingMs -= chunkMs;
    }
    return false;
  }

  private suppressDuplicateTerminalText(text: string, chatJid: string): boolean {
    const now = Date.now();
    this.pruneTerminalTextDedupe(now);
    const key = this.terminalTextDedupeKey('text', chatJid, text);
    const entry = this.recentTerminalTextKeys.get(key);
    if (!entry) return false;

    entry.lastSeenAt = now;
    entry.suppressedCount += 1;
    log.info({
      chatJid,
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
