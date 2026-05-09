import type { AlertPayload, DeliveryResult, Sink } from './types.ts';

export interface WhatSoupSinkOptions {
  baseUrl: string;
  conversationKey: string;
  deliveryJid?: string;
  token: string;
  timeoutMs?: number;
  retry?: number[];
  retryCrit?: number[];
  retryOther?: number[];
}

export class WhatSoupSink implements Sink {
  readonly name = 'whatsoup';
  readonly isDurableLog = false;

  private readonly opts: WhatSoupSinkOptions;
  private readonly baseUrl: string;

  constructor(opts: WhatSoupSinkOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/u, '');
  }

  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    const delays = [0, ...this.retryDelaysFor(payload)];
    let lastError = 'unknown';

    for (const [index, delayMs] of delays.entries()) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      const attempt = index + 1;
      const result = await this.tryDeliver(payload, attempt);
      if (result.ok) {
        return { ok: true, channel: this.name };
      }

      lastError = result.error;
      if (!result.retryable) {
        break;
      }
    }

    return { ok: false, channel: this.name, error: this.redactToken(lastError) };
  }

  private async tryDeliver(payload: AlertPayload, attempt: number): Promise<AttemptResult> {
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          conversation_key: this.opts.conversationKey,
          ...(this.opts.deliveryJid ? { delivery_jid: this.opts.deliveryJid } : {}),
          text: payload.body,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        return { ok: true };
      }

      return {
        ok: false,
        error: `http ${response.status} after ${formatAttempts(attempt)}`,
        retryable: isRetryableStatus(response.status),
      };
    } catch (error) {
      const message = controller.signal.aborted
        ? `timeout after ${timeoutMs}ms on attempt ${attempt}`
        : `request failed after ${formatAttempts(attempt)}: ${errorMessage(error)}`;

      return { ok: false, error: this.redactToken(message), retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private redactToken(value: string): string {
    if (!this.opts.token) {
      return value;
    }
    return value.split(this.opts.token).join('<redacted>');
  }

  private retryDelaysFor(payload: AlertPayload): number[] {
    if (payload.severity === 'crit') {
      return this.opts.retryCrit ?? this.opts.retry ?? [];
    }

    return this.opts.retryOther ?? this.opts.retry ?? [];
  }
}

type AttemptResult =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean };

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAttempts(attempts: number): string {
  return attempts === 1 ? '1 attempt' : `${attempts} attempts`;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
