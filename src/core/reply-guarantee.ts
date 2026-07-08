import { createChildLogger } from '../logger.ts';
import type { CompleteTurnParams } from './durability.ts';
import type { Messenger } from './types.ts';

const log = createChildLogger('reply-guarantee');

export const DEFAULT_REPLY_GUARANTEE_TEXT = "I'm still working on this and will follow up shortly.";
export const DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REPLY_GUARANTEE_RATE_LIMIT_MS = 15 * 60 * 1000;

export type InboundProcessingStatus = 'processing' | 'turn_done' | 'complete' | 'failed' | 'skipped';

export interface ReplyGuaranteeDurability {
  getInboundStatus(seq: number): InboundProcessingStatus | string | undefined;
  completeTurn(params: CompleteTurnParams): void;
}

export interface ReplyGuaranteeFallbackInput {
  inboundSeq: number;
  chatJid: string;
  text: string;
}

export interface ReplyGuaranteeFallbackResult {
  terminalReason?: string;
}

export type ReplyGuaranteeFallbackSender = (
  input: ReplyGuaranteeFallbackInput,
) => Promise<ReplyGuaranteeFallbackResult | unknown>;

export interface ReplyGuaranteeArmInput {
  inboundSeq: number | undefined;
  chatJid: string;
}

export interface ReplyGuaranteeManagerOptions {
  durability: ReplyGuaranteeDurability | undefined;
  sendFallback: ReplyGuaranteeFallbackSender;
  timeoutMs?: number;
  rateLimitMs?: number;
  fallbackText?: string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
}

interface ArmedTurn {
  inboundSeq: number;
  chatJid: string;
  timer: ReturnType<typeof setTimeout>;
}

export class ReplyGuaranteeManager {
  private readonly durability: ReplyGuaranteeDurability | undefined;
  private readonly sendFallback: ReplyGuaranteeFallbackSender;
  private readonly timeoutMs: number;
  private readonly rateLimitMs: number;
  private readonly fallbackText: string;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly now: () => number;
  private readonly armed = new Map<number, ArmedTurn>();
  private readonly lastFallbackByChat = new Map<string, number>();

  constructor(opts: ReplyGuaranteeManagerOptions) {
    this.durability = opts.durability;
    this.sendFallback = opts.sendFallback;
    this.timeoutMs = normalizePositiveMs(opts.timeoutMs, DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS);
    this.rateLimitMs = normalizePositiveMs(opts.rateLimitMs, DEFAULT_REPLY_GUARANTEE_RATE_LIMIT_MS);
    this.fallbackText = opts.fallbackText ?? DEFAULT_REPLY_GUARANTEE_TEXT;
    this.setTimer = opts.setTimer ?? setTimeout;
    this.clearTimer = opts.clearTimer ?? clearTimeout;
    this.now = opts.now ?? Date.now;
  }

  arm(input: ReplyGuaranteeArmInput): void {
    if (input.inboundSeq === undefined) return;
    if (this.armed.has(input.inboundSeq)) return;

    const timer = this.armTimer(input.inboundSeq, input.chatJid);
    this.armed.set(input.inboundSeq, {
      inboundSeq: input.inboundSeq,
      chatJid: input.chatJid,
      timer,
    });
  }

  /**
   * Reset the silence window for every armed turn on this chat. Called when
   * user-visible output is emitted, so the fallback only fires after a full
   * window of TRUE silence (no user-facing output) — not while a long turn is
   * actively streaming replies. Mode-agnostic: keyed by chat, not inbound seq.
   */
  notifyActivity(chatJid: string): void {
    for (const armed of this.armed.values()) {
      if (armed.chatJid !== chatJid) continue;
      this.clearTimer(armed.timer);
      armed.timer = this.armTimer(armed.inboundSeq, armed.chatJid);
    }
  }

  private armTimer(inboundSeq: number, chatJid: string): ReturnType<typeof setTimeout> {
    const timer = this.setTimer(() => {
      void this.onTimeout(inboundSeq, chatJid);
    }, this.timeoutMs);
    timer.unref?.();
    return timer;
  }

  disarm(inboundSeq: number | undefined): void {
    if (inboundSeq === undefined) return;
    const active = this.armed.get(inboundSeq);
    if (!active) return;
    this.clearTimer(active.timer);
    this.armed.delete(inboundSeq);
  }

  isArmed(inboundSeq: number | undefined): boolean {
    return inboundSeq !== undefined && this.armed.has(inboundSeq);
  }

  shutdown(): void {
    for (const { timer } of this.armed.values()) {
      this.clearTimer(timer);
    }
    this.armed.clear();
  }

  private async onTimeout(inboundSeq: number, chatJid: string): Promise<void> {
    this.armed.delete(inboundSeq);
    if (!this.durability) return;

    const status = this.durability.getInboundStatus(inboundSeq);
    if (!isOpenInboundStatus(status)) {
      return;
    }

    const now = this.now();
    const lastFallbackAt = this.lastFallbackByChat.get(chatJid);
    if (lastFallbackAt !== undefined && now - lastFallbackAt < this.rateLimitMs) {
      log.warn({ inboundSeq, chatJid, status }, 'reply guarantee fallback suppressed by rate limit');
      return;
    }

    // Reserve the rate-limit slot BEFORE awaiting the fallback. onTimeout does
    // a check-then-act across an await; concurrent same-chat timeouts would all
    // pass the guard above before any of them recorded success (TOCTOU), causing
    // duplicate liveness fallbacks. Reserving synchronously closes the race.
    this.lastFallbackByChat.set(chatJid, now);
    // QR-107: separate a FALLBACK failure from a FINALIZE failure. The single try
    // previously wrapped both sendFallback and completeTurn, and the catch
    // unconditionally released the rate-limit reservation. A completeTurn/DB
    // failure AFTER a successful fallback was thus conflated with a fallback
    // failure, releasing the slot and allowing a duplicate same-chat timeout.
    let fallbackSucceeded = false;
    try {
      const result = await this.sendFallback({ inboundSeq, chatJid, text: this.fallbackText });
      fallbackSucceeded = true;
      this.durability.completeTurn({
        inbound: {
          seq: inboundSeq,
          terminalReason: fallbackTerminalReason(result),
        },
      });
    } catch (err) {
      if (!fallbackSucceeded) {
        // TRUE fallback failure: no liveness signal was emitted. Release the reservation
        // (only if no other send claimed the slot meanwhile) so a future
        // legitimate fallback is not blocked — preserves retry-after-failure.
        if (this.lastFallbackByChat.get(chatJid) === now) {
          this.lastFallbackByChat.delete(chatJid);
        }
        log.warn({ err, inboundSeq, chatJid }, 'reply guarantee fallback failed');
      } else {
        // The fallback succeeded but completeTurn (durability write) failed.
        // Do NOT release the slot — releasing would allow a duplicate fallback
        // for a signal the user already received. The inbound is left
        // unfinalized for durability recovery to reconcile.
        log.error(
          { err, inboundSeq, chatJid },
          'reply guarantee fallback succeeded but completeTurn failed — inbound left for recovery',
        );
      }
    }
  }
}

export function createReplyGuaranteeLivenessSender({
  messenger,
}: {
  messenger: Messenger;
}): ReplyGuaranteeFallbackSender {
  return async ({ chatJid }) => {
    await messenger.setTyping?.(chatJid, 'composing').catch(() => undefined);
    return { terminalReason: 'rgp_liveness_nudged' };
  };
}

function fallbackTerminalReason(result: unknown): string {
  if (
    result !== null &&
    typeof result === 'object' &&
    'terminalReason' in result &&
    typeof result.terminalReason === 'string' &&
    result.terminalReason.trim().length > 0
  ) {
    return result.terminalReason;
  }
  return 'rgp_fallback_sent';
}

function isOpenInboundStatus(status: string | undefined): boolean {
  return status === 'processing' || status === 'turn_done';
}

function normalizePositiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
