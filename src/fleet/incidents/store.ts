import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseSignalEnvelope, type SignalEnvelope } from './envelope.ts';

export interface ProducerContext {
  producerId: string;
  producerDomainId: string;
}

export type Disposition =
  | 'incident_opened'
  | 'incident_updated'
  | 'incident_resolved'
  | 'heartbeat_recorded'
  | 'notice_recorded'
  | 'stored_no_state_change'
  | 'stored_stale_observation'
  | 'stored_quarantined_observation';

export interface SignalReceipt {
  schemaVersion: 1;
  eventId: number;
  producerId: string;
  signalId: string;
  payloadDigest: string;
  receivedAt: string;
  disposition: Disposition;
  incidentId: number | null;
  transitionId: number | null;
}

export type AcceptResult =
  | { outcome: 'accepted'; receipt: SignalReceipt }
  | { outcome: 'idempotent_replay'; receipt: SignalReceipt }
  | { outcome: 'identity_conflict'; existingDigest: string }
  | { outcome: 'invalid'; errors: string[] };

const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

interface StoredEventRow {
  event_id: number;
  payload_digest: string;
  received_at: string;
  disposition: string;
  incident_id: number | null;
  transition_id: number | null;
}

interface LifecycleEffect {
  disposition: Disposition;
  incidentId: number | null;
  transitionId: number | null;
}

export class IncidentStore {
  private readonly db: DatabaseSync;
  private readonly maxFutureSkewMs: number;

  constructor(db: DatabaseSync, options?: { maxFutureSkewMs?: number }) {
    this.db = db;
    this.maxFutureSkewMs = options?.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  }

  close(): void {
    this.db.close();
  }

  acceptSignal(rawBody: string, producer: ProducerContext, now: Date): AcceptResult {
    const payloadDigest = `sha256:${createHash('sha256').update(rawBody, 'utf-8').digest('hex')}`;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare(
          `SELECT event_id, payload_digest, received_at, disposition, incident_id, transition_id
             FROM events WHERE producer_id = ? AND signal_id = ?`,
        )
        .get(producer.producerId, extractSignalId(rawBody) ?? '') as StoredEventRow | undefined;

      if (existing) {
        this.db.exec('ROLLBACK');
        if (existing.payload_digest === payloadDigest) {
          return {
            outcome: 'idempotent_replay',
            receipt: this.receiptFromRow(existing, producer, rawBody),
          };
        }
        return { outcome: 'identity_conflict', existingDigest: existing.payload_digest };
      }

      const parsed = parseSignalEnvelope(rawBody);
      if (!parsed.ok) {
        this.db.exec('ROLLBACK');
        return { outcome: 'invalid', errors: parsed.errors };
      }
      const envelope = parsed.envelope;

      const receivedAt = now.toISOString();
      const quarantined =
        Date.parse(envelope.observedAt) > now.getTime() + this.maxFutureSkewMs;

      const inserted = this.db
        .prepare(
          `INSERT INTO events (
             producer_id, producer_domain_id, signal_id, payload_digest, payload_json,
             kind, subject, condition_class, occurrence_id, occurrence_seq,
             observed_at, received_at, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored_no_state_change')`,
        )
        .run(
          producer.producerId,
          producer.producerDomainId,
          envelope.signalId,
          payloadDigest,
          rawBody,
          envelope.kind,
          envelope.subject,
          envelope.conditionClass ?? null,
          envelope.occurrenceId ?? null,
          envelope.occurrenceSeq ?? null,
          envelope.observedAt,
          receivedAt,
        );
      const eventId = Number(inserted.lastInsertRowid);

      const effect: LifecycleEffect = quarantined
        ? { disposition: 'stored_quarantined_observation', incidentId: null, transitionId: null }
        : this.applyLifecycle(envelope, producer, eventId, receivedAt);

      this.db
        .prepare(
          `UPDATE events SET disposition = ?, incident_id = ?, transition_id = ?
             WHERE event_id = ?`,
        )
        .run(effect.disposition, effect.incidentId, effect.transitionId, eventId);

      this.db.exec('COMMIT');
      return {
        outcome: 'accepted',
        receipt: {
          schemaVersion: 1,
          eventId,
          producerId: producer.producerId,
          signalId: envelope.signalId,
          payloadDigest,
          receivedAt,
          disposition: effect.disposition,
          incidentId: effect.incidentId,
          transitionId: effect.transitionId,
        },
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private receiptFromRow(
    row: StoredEventRow,
    producer: ProducerContext,
    rawBody: string,
  ): SignalReceipt {
    return {
      schemaVersion: 1,
      eventId: row.event_id,
      producerId: producer.producerId,
      signalId: extractSignalId(rawBody) ?? '',
      payloadDigest: row.payload_digest,
      receivedAt: row.received_at,
      disposition: row.disposition as Disposition,
      incidentId: row.incident_id,
      transitionId: row.transition_id,
    };
  }

  private applyLifecycle(
    envelope: SignalEnvelope,
    _producer: ProducerContext,
    _eventId: number,
    _receivedAt: string,
  ): LifecycleEffect {
    switch (envelope.kind) {
      case 'heartbeat_observed':
        return { disposition: 'heartbeat_recorded', incidentId: null, transitionId: null };
      case 'notice_recorded':
        return { disposition: 'notice_recorded', incidentId: null, transitionId: null };
      case 'condition_observed':
      case 'condition_recovered':
        // Episode lifecycle lands in the next increments (plan Tasks 4-6).
        return { disposition: 'stored_no_state_change', incidentId: null, transitionId: null };
    }
  }
}

function extractSignalId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as { signalId?: unknown }).signalId;
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  } catch {
    // invalid JSON has no identity; envelope validation reports it
  }
  return null;
}
