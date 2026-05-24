import { errorMessage } from '../../lib/error-utils.ts';
import type { AlertPayload, DeliveryResult, Sink } from '../types.ts';

export interface NtfySinkOptions {
  baseUrl: string;
  topic: string;
  token?: string;
  timeoutMs?: number;
}

export class NtfySink implements Sink {
  readonly name = 'meta-ntfy';
  readonly isDurableLog = false;

  private readonly opts: NtfySinkOptions;
  private readonly baseUrl: string;

  constructor(opts: NtfySinkOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/u, '');
  }

  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    const missingSecret = missingConfiguredSecret('token', this.opts.token);
    if (missingSecret) {
      return { ok: false, channel: this.name, error: missingSecret };
    }

    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/${encodeURIComponent(this.opts.topic)}`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: payload.body,
        signal: controller.signal,
      });

      if (response.ok) {
        return { ok: true, channel: this.name };
      }

      return { ok: false, channel: this.name, error: `http ${response.status}` };
    } catch (error) {
      const message = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : errorMessage(error);
      return { ok: false, channel: this.name, error: redact(message, [this.opts.token]) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function missingConfiguredSecret(label: string, value: string | undefined): string | undefined {
  if (value !== undefined && value.trim() === '') {
    return `missing ${label}`;
  }
  return undefined;
}

function redact(value: string, secrets: Array<string | undefined>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    redacted = redacted.split(secret).join('<redacted>');
  }
  return redacted;
}
