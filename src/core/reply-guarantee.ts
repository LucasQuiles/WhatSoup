import { createChildLogger } from '../logger.ts';
import type { InboundStatus } from './durability.ts';
import type { Messenger } from './types.ts';
import { MS_PER_MINUTE } from '../lib/time-units.ts';

const log = createChildLogger('reply-guarantee');

export const DEFAULT_REPLY_GUARANTEE_TEXT = "I'm still working on this and will follow up shortly.";
export const DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS = 10 * MS_PER_MINUTE;
const DEFAULT_REPLY_GUARANTEE_RATE_LIMIT_MS = 15 * MS_PER_MINUTE;

export type InboundProcessingStatus = 'processing' | 'turn_done' | 'complete' | 'failed' | 'skipped';

export interface ReplyGuaranteeDurability {
  getInboundStatus(seq: number): InboundStatus | undefined;
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
    let timer: ReturnType<typeof setTimeout>;
    timer = this.setTimer(() => {
      void this.onTimeout(inboundSeq, chatJid, timer);
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

  private rearmIfStillOpen(active: ArmedTurn, firedTimer: ReturnType<typeof setTimeout>): void {
    if (this.armed.get(active.inboundSeq) !== active || active.timer !== firedTimer) return;
    if (!isOpenInboundStatus(this.durability?.getInboundStatus(active.inboundSeq))) {
      this.armed.delete(active.inboundSeq);
      return;
    }
    active.timer = this.armTimer(active.inboundSeq, active.chatJid);
  }

  private async onTimeout(
    inboundSeq: number,
    chatJid: string,
    firedTimer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    const active = this.armed.get(inboundSeq);
    if (!active || active.chatJid !== chatJid || active.timer !== firedTimer) return;
    if (!this.durability) {
      this.armed.delete(inboundSeq);
      return;
    }

    const status = this.durability.getInboundStatus(inboundSeq);
    if (!isOpenInboundStatus(status)) {
      this.armed.delete(inboundSeq);
      return;
    }

    const now = this.now();
    const lastFallbackAt = this.lastFallbackByChat.get(chatJid);
    if (lastFallbackAt !== undefined && now - lastFallbackAt < this.rateLimitMs) {
      log.warn({ inboundSeq, chatJid, status }, 'reply guarantee fallback suppressed by rate limit');
      this.rearmIfStillOpen(active, firedTimer);
      return;
    }

    // Reserve the rate-limit slot BEFORE awaiting the fallback. onTimeout does
    // a check-then-act across an await; concurrent same-chat timeouts would all
    // pass the guard above before any of them recorded success (TOCTOU), causing
    // duplicate liveness fallbacks. Reserving synchronously closes the race.
    this.lastFallbackByChat.set(chatJid, now);
    try {
      await this.sendFallback({ inboundSeq, chatJid, text: this.fallbackText });
    } catch (err) {
      // No liveness signal was emitted. Release the reservation only if no
      // other send claimed the slot meanwhile so a later turn can retry.
      if (this.lastFallbackByChat.get(chatJid) === now) {
        this.lastFallbackByChat.delete(chatJid);
      }
      log.warn({ err, inboundSeq, chatJid }, 'reply guarantee fallback failed');
    }
    this.rearmIfStillOpen(active, firedTimer);
  }
}

export function createReplyGuaranteeLivenessSender({
  messenger,
}: {
  messenger: Messenger;
}): ReplyGuaranteeFallbackSender {
  return async ({ chatJid }) => {
    if (!messenger.setTyping) {
      throw new Error('Reply guarantee typing adapter is unavailable');
    }
    await messenger.setTyping(chatJid, 'composing');
    return { terminalReason: 'rgp_liveness_nudged' };
  };
}

function isOpenInboundStatus(status: string | undefined): boolean {
  return status === 'processing' || status === 'turn_done';
}

function normalizePositiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
