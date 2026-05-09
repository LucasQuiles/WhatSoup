import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '../policy/schema.ts';
import { LocalLogSink, LocalNotifySink } from './local-notify.ts';
import { NtfySink } from './meta-alert/ntfy.ts';
import { PushoverSink } from './meta-alert/pushover.ts';
import { WebhookSink } from './meta-alert/webhook.ts';
import type { AlertPayload, DeliveryResult, Sink } from './types.ts';
import { WhatSoupSink } from './whatsoup.ts';

export interface BuildChainOptions {
  stateDir?: string;
  now?: () => Date;
  notifier?: ((title: string, body: string) => Promise<void>) | undefined;
}

export function buildAlertChain(policy: Policy, options: BuildChainOptions = {}): Sink[] {
  return [
    buildWhatSoupSink(policy),
    new LocalNotifySink({
      notifier: options.notifier,
      fallbackLogPath: join(stateDir(options), 'local-notify-fallback.jsonl'),
      ...(options.now ? { now: options.now } : {}),
    }),
    new LocalLogSink(join(stateDir(options), 'alerts.jsonl'), {
      ...(options.now ? { now: options.now } : {}),
    }),
  ];
}

export function buildMetaAlertSinks(policy: Policy): Sink[] {
  const meta = policy.transport.meta_alert;
  if (!meta?.enabled) return [];

  const provider = meta.provider ?? 'ntfy';
  switch (provider) {
    case 'ntfy': {
      if (!meta.topic_or_destination) return [new DisabledSink('meta-ntfy', 'ntfy topic is not configured')];
      const secret = readOptionalSecret(meta.secret_file, 'meta_alert.secret_file');
      if (!secret.ok) return [new DisabledSink('meta-ntfy', secret.error)];

      return [new NtfySink({
        baseUrl: 'https://ntfy.sh',
        topic: meta.topic_or_destination,
        ...optional('token', secret.value),
      })];
    }
    case 'pushover': {
      if (!meta.secret_file || !meta.topic_or_destination) {
        return [new DisabledSink('meta-pushover', 'pushover token or user is not configured')];
      }
      const secret = readOptionalSecret(meta.secret_file, 'meta_alert.secret_file');
      if (!secret.ok) return [new DisabledSink('meta-pushover', secret.error)];

      return [new PushoverSink({
        apiUrl: 'https://api.pushover.net/1/messages.json',
        token: secret.value ?? '',
        user: meta.topic_or_destination,
      })];
    }
    case 'webhook': {
      if (!meta.topic_or_destination) return [new DisabledSink('meta-webhook', 'webhook URL is not configured')];
      const secret = readOptionalSecret(meta.secret_file, 'meta_alert.secret_file');
      if (!secret.ok) return [new DisabledSink('meta-webhook', secret.error)];

      return [new WebhookSink({
        url: meta.topic_or_destination,
        ...optional('bearer', secret.value),
      })];
    }
  }
}

class DisabledSink implements Sink {
  readonly isDurableLog = false;

  constructor(readonly name: string, private readonly reason: string) {}

  async deliver(_payload: AlertPayload): Promise<DeliveryResult> {
    return { ok: false, channel: this.name, error: this.reason };
  }
}

function buildWhatSoupSink(policy: Policy): Sink {
  const sink = policy.transport.alert_sink;
  const token = readOptionalSecret(sink.token_file, 'transport.alert_sink.token_file');
  if (!token.ok) {
    return new DisabledSink('whatsoup', token.error);
  }
  if (!sink.base_url || !sink.conversation_key || !token.value) {
    return new DisabledSink('whatsoup', 'whatsoup transport is not configured');
  }

  return new WhatSoupSink({
    baseUrl: sink.base_url,
    conversationKey: sink.conversation_key,
    ...optional('deliveryJid', sink.delivery_jid),
    token: token.value,
    timeoutMs: sink.timeout_s * 1000,
    retryCrit: sink.retry_crit.map((seconds) => seconds * 1000),
    retryOther: sink.retry_other.map((seconds) => seconds * 1000),
  });
}

type SecretReadResult =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

function readOptionalSecret(path: string | undefined, setting: string): SecretReadResult {
  if (!path) return { ok: true, value: undefined };

  try {
    return { ok: true, value: readFileSync(path, 'utf8').trim() };
  } catch (error) {
    return { ok: false, error: `${setting} cannot be read at ${path}: ${errorMessage(error)}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateDir(options: BuildChainOptions): string {
  return options.stateDir ?? tmpdir();
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}
