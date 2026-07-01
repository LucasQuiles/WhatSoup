import type { DatabaseSync } from 'node:sqlite';

export const AUTH_LOSS_SIGNAL_CLASSIFIERS = [
  'logged_out',
  'weak_logged_out_signal',
] as const;

export const AUTH_LOSS_SIGNAL_REASONS = [
  'explicit_auth_loss',
  'weak_signal_persisted',
  'whatsapp_auth_loss_with_disconnect_corroboration',
] as const;

export const AUTH_LOSS_SIGNAL_CONFIDENCES = [
  'confirmed',
  'inferred',
  'ambiguous',
] as const;

export const AUTH_LOSS_SIGNAL_RESOLUTION_REASONS = [
  'stable_authenticated_open',
] as const;

export type AuthLossSignalClassifier = typeof AUTH_LOSS_SIGNAL_CLASSIFIERS[number];
export type AuthLossSignalReason = typeof AUTH_LOSS_SIGNAL_REASONS[number];
export type AuthLossSignalConfidence = typeof AUTH_LOSS_SIGNAL_CONFIDENCES[number];
export type AuthLossSignalResolutionReason = typeof AUTH_LOSS_SIGNAL_RESOLUTION_REASONS[number];

export interface AuthLossSignalInput {
  instance: string;
  host: string;
  classifier: AuthLossSignalClassifier;
  reason: AuthLossSignalReason;
  confidence: AuthLossSignalConfidence;
  observedAt?: string;
}

export interface AuthLossSignalResolutionInput {
  instance: string;
  classifier: AuthLossSignalClassifier;
  reason: AuthLossSignalResolutionReason;
  resolvedAt?: string;
}

export type AuthLossSignalRecordResult =
  | { inserted: true; id: number; reason: 'inserted' }
  | { inserted: false; id: number; reason: 'duplicate_active_signal' };

export type AuthLossSignalResolutionResult =
  | { resolved: true; id: number; reason: 'resolved' }
  | { resolved: false; id: null; reason: 'no_open_signal' };

const CLASSIFIERS = new Set<string>(AUTH_LOSS_SIGNAL_CLASSIFIERS);
const REASONS = new Set<string>(AUTH_LOSS_SIGNAL_REASONS);
const CONFIDENCES = new Set<string>(AUTH_LOSS_SIGNAL_CONFIDENCES);
const RESOLUTION_REASONS = new Set<string>(AUTH_LOSS_SIGNAL_RESOLUTION_REASONS);
const SAFE_LABEL_RE = /^[A-Za-z0-9_.-]{1,80}$/;

export class AuthLossSignalStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(input: AuthLossSignalInput): AuthLossSignalRecordResult {
    const instance = safeLabel(input.instance, 'instance');
    const host = safeLabel(input.host, 'host');
    const classifier = enumValue(input.classifier, CLASSIFIERS, 'auth-loss classifier') as AuthLossSignalClassifier;
    const reason = enumValue(input.reason, REASONS, 'auth-loss reason') as AuthLossSignalReason;
    const confidence = enumValue(input.confidence, CONFIDENCES, 'auth-loss confidence') as AuthLossSignalConfidence;
    const observedAt = isoTimestamp(input.observedAt ?? new Date().toISOString());

    const last = this.db
      .prepare(`
        SELECT id, classifier
        FROM auth_loss_signal
        WHERE instance = ?
          AND classifier = ?
          AND resolved_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(instance, classifier) as { id: number; classifier: string } | undefined;

    if (last) {
      return { inserted: false, id: last.id, reason: 'duplicate_active_signal' };
    }

    const result = this.db
      .prepare(`
        INSERT INTO auth_loss_signal (
          instance,
          host,
          classifier,
          reason,
          confidence,
          observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(instance, host, classifier, reason, confidence, observedAt);

    return { inserted: true, id: Number(result.lastInsertRowid), reason: 'inserted' };
  }

  resolve(input: AuthLossSignalResolutionInput): AuthLossSignalResolutionResult {
    const instance = safeLabel(input.instance, 'instance');
    const classifier = enumValue(input.classifier, CLASSIFIERS, 'auth-loss classifier') as AuthLossSignalClassifier;
    const reason = enumValue(input.reason, RESOLUTION_REASONS, 'auth-loss resolution reason') as AuthLossSignalResolutionReason;
    const resolvedAt = isoTimestamp(input.resolvedAt ?? new Date().toISOString());

    const row = this.db
      .prepare(`
        SELECT id
        FROM auth_loss_signal
        WHERE instance = ?
          AND classifier = ?
          AND resolved_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(instance, classifier) as { id: number } | undefined;

    if (!row) {
      return { resolved: false, id: null, reason: 'no_open_signal' };
    }

    this.db
      .prepare(`
        UPDATE auth_loss_signal
        SET resolved_at = ?,
            resolved_reason = ?
        WHERE id = ?
      `)
      .run(resolvedAt, reason, row.id);

    return { resolved: true, id: row.id, reason: 'resolved' };
  }
}

function safeLabel(value: unknown, field: 'instance' | 'host'): string {
  if (typeof value !== 'string' || !SAFE_LABEL_RE.test(value)) {
    throw new Error(`unsupported auth-loss ${field}`);
  }
  return value;
}

function enumValue(value: unknown, allowed: Set<string>, label: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`unsupported ${label}`);
  }
  return value;
}

function isoTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('unsupported auth-loss observedAt');
  }
  return value;
}
