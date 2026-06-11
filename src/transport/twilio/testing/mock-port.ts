// src/transport/twilio/testing/mock-port.ts
import type { InboundSms, SendSmsArgs, TwilioSmsPort } from '../port.ts';

/**
 * In-memory test double for TwilioSmsPort.
 * Records outbound sends, supports inbound injection, and allows deterministic
 * one-shot failure injection for every method so adapter tests can exercise
 * every typed error path without network access.
 */
export class MockTwilioSmsPort implements TwilioSmsPort {
  /** Captured outbound send arguments, in call order. */
  readonly sent: SendSmsArgs[] = [];

  private readonly inbound: InboundSms[] = [];
  private counter = 0;

  // One-shot failure injection: set to a non-null Error to throw it once, then reset.
  private pendingVerifyError: Error | null = null;
  private pendingSendError: Error | null = null;
  private pendingListError: Error | null = null;

  // ─── TwilioSmsPort implementation ─────────────────────────────────────────

  async verifyCredentials(): Promise<void> {
    if (this.pendingVerifyError !== null) {
      const err = this.pendingVerifyError;
      this.pendingVerifyError = null;
      throw err;
    }
  }

  async sendSms(args: SendSmsArgs): Promise<{ sid: string }> {
    if (this.pendingSendError !== null) {
      const err = this.pendingSendError;
      this.pendingSendError = null;
      throw err;
    }
    this.sent.push(args);
    const sid = 'SM' + String(++this.counter).padStart(6, '0');
    return { sid };
  }

  async listInboundSince(since: Date, pageSize?: number): Promise<readonly InboundSms[]> {
    if (this.pendingListError !== null) {
      const err = this.pendingListError;
      this.pendingListError = null;
      throw err;
    }
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
      throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
    }
    // Inclusive boundary + ascending sentAt order — see the port contract.
    const filtered = this.inbound
      .filter((m) => m.sentAt >= since)
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    return pageSize !== undefined ? filtered.slice(0, pageSize) : filtered;
  }

  // ─── Test helpers ──────────────────────────────────────────────────────────

  /** Queue an inbound record to be returned by listInboundSince. */
  injectInbound(record: InboundSms): void {
    this.inbound.push(record);
  }

  /**
   * Cause the next verifyCredentials call to throw `err`, then reset.
   * Arming again before the failure is consumed overwrites the previous error
   * (same for the other fail-next helpers).
   */
  failNextVerify(err: Error): void {
    this.pendingVerifyError = err;
  }

  /** Cause the next sendSms call to throw `err`, then reset. */
  failNextSend(err: Error): void {
    this.pendingSendError = err;
  }

  /** Cause the next listInboundSince call to throw `err`, then reset. */
  failNextList(err: Error): void {
    this.pendingListError = err;
  }
}
