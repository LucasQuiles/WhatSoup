import type { AlertPayload, DeliveryResult, Sink } from '../types.ts';

export interface WebhookSinkOptions {
  url: string;
  bearer?: string;
  timeoutMs?: number;
}

export class WebhookSink implements Sink {
  readonly name = 'meta-webhook';
  readonly isDurableLog = false;
  private readonly opts: WebhookSinkOptions;

  constructor(opts: WebhookSinkOptions) {
    this.opts = opts;
  }

  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    const missingSecret = missingConfiguredSecret('bearer', this.opts.bearer);
    if (missingSecret) {
      return { ok: false, channel: this.name, error: missingSecret };
    }

    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.bearer ? { authorization: `Bearer ${this.opts.bearer}` } : {}),
        },
        body: JSON.stringify({ body: payload.body }),
        signal: controller.signal,
      });

      if (response.ok) {
        return { ok: true, channel: this.name };
      }

      return { ok: false, channel: this.name, error: `http ${response.status}` };
    } catch (error) {
      const message = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : errorMessage(error);
      return { ok: false, channel: this.name, error: redact(message, [this.opts.bearer]) };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
