import type { AlertPayload, DeliveryResult, Sink } from '../types.ts';

export interface PushoverSinkOptions {
  apiUrl: string;
  token: string;
  user: string;
  title?: string;
  timeoutMs?: number;
}

export class PushoverSink implements Sink {
  readonly name = 'meta-pushover';
  readonly isDurableLog = false;
  private readonly opts: PushoverSinkOptions;

  constructor(opts: PushoverSinkOptions) {
    this.opts = opts;
  }

  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    const missingSecret = missingConfiguredSecret('token', this.opts.token) ?? missingConfiguredSecret('user', this.opts.user);
    if (missingSecret) {
      return { ok: false, channel: this.name, error: missingSecret };
    }

    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = new URLSearchParams({
        token: this.opts.token,
        user: this.opts.user,
        ...(this.opts.title ? { title: this.opts.title } : {}),
        message: payload.body,
      });

      const response = await fetch(this.opts.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        return { ok: true, channel: this.name };
      }

      return { ok: false, channel: this.name, error: `http ${response.status}` };
    } catch (error) {
      const message = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : errorMessage(error);
      return { ok: false, channel: this.name, error: redact(message, [this.opts.token, this.opts.user]) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function missingConfiguredSecret(label: string, value: string): string | undefined {
  if (value.trim() === '') {
    return `missing ${label}`;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => {
    if (!secret) {
      return current;
    }
    return current.split(secret).join('<redacted>');
  }, value);
}
