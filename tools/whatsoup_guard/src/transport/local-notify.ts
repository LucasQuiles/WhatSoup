import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AlertPayload, DeliveryResult, Sink } from './types.ts';

export interface LocalSinkOptions {
  now?: () => Date;
}

export class LocalLogSink implements Sink {
  readonly name = 'local-log';
  readonly isDurableLog = true;
  private readonly path: string;
  private readonly options: LocalSinkOptions;

  constructor(path: string, options: LocalSinkOptions = {}) {
    this.path = path;
    this.options = options;
    mkdirSync(dirname(path), { recursive: true });
  }

  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    appendJsonl(this.path, {
      ts: nowIso(this.options),
      channel: this.name,
      body: payload.body,
    });
    return { ok: true, channel: this.name };
  }
}

export interface LocalNotifySinkOptions extends LocalSinkOptions {
  notifier: ((title: string, body: string) => Promise<void>) | undefined;
  fallbackLogPath: string;
}

export class LocalNotifySink implements Sink {
  readonly name = 'local-notify';
  readonly isDurableLog = false;
  private readonly options: LocalNotifySinkOptions;

  constructor(options: LocalNotifySinkOptions) {
    this.options = options;
    mkdirSync(dirname(options.fallbackLogPath), { recursive: true });
  }

  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    if (!this.options.notifier) {
      this.writeFallback(payload, { fallback: 'notifier_unavailable' });
      return { ok: false, channel: this.name, error: 'notifier unavailable; wrote fallback log' };
    }

    try {
      await this.options.notifier('whatsoup-guard', payload.body);
      return { ok: true, channel: this.name };
    } catch (error) {
      this.writeFallback(payload, {
        fallback: 'notifier_failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        channel: this.name,
        error: `${error instanceof Error ? error.message : String(error)}; wrote fallback log`,
      };
    }
  }

  private writeFallback(payload: AlertPayload, extra: Record<string, unknown>): void {
    appendJsonl(this.options.fallbackLogPath, {
      ts: nowIso(this.options),
      channel: this.name,
      body: payload.body,
      ...extra,
    });
  }
}

function nowIso(options: LocalSinkOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

function appendJsonl(path: string, value: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
