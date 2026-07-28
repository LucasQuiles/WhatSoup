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

  getIncident(incidentId: number): IncidentProjection | null {
    const row = this.db
      .prepare(`SELECT * FROM incidents WHERE incident_id = ?`)
      .get(incidentId) as Record<string, unknown> | undefined;
    return row ? projectIncident(row) : null;
  }

  listTransitions(incidentId: number): TransitionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM transitions WHERE incident_id = ? ORDER BY transition_id`)
      .all(incidentId) as Array<Record<string, unknown>>;
    return rows.map(projectTransition);
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
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    switch (envelope.kind) {
      case 'heartbeat_observed':
        return { disposition: 'heartbeat_recorded', incidentId: null, transitionId: null };
      case 'notice_recorded':
        return { disposition: 'notice_recorded', incidentId: null, transitionId: null };
      case 'condition_observed':
        return this.applyConditionObserved(envelope, producer, eventId, receivedAt);
      case 'condition_recovered':
        return this.applyConditionRecovered(envelope, producer, eventId, receivedAt);
    }
  }

  private applyConditionRecovered(
    envelope: SignalEnvelope,
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    const episode = this.db
      .prepare(
        `SELECT incident_id, condition_state FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ? AND occurrence_id = ?`,
      )
      .get(
        producer.producerDomainId,
        envelope.subject,
        envelope.conditionClass as string,
        envelope.occurrenceId as string,
      ) as { incident_id: number; condition_state: string } | undefined;

    if (!episode || episode.condition_state !== 'open') {
      return { disposition: 'stored_no_state_change', incidentId: null, transitionId: null };
    }

    this.db
      .prepare(
        `UPDATE incidents
            SET condition_state = 'resolved', projection_version = projection_version + 1
          WHERE incident_id = ?`,
      )
      .run(episode.incident_id);
    const transition = this.db
      .prepare(
        `INSERT INTO transitions (
           incident_id, from_state, to_state, actor_type, cause_event_id, reason_code, created_at)
         VALUES (?, 'open', 'resolved', 'evaluator', ?, 'verified_recovery', ?)`,
      )
      .run(episode.incident_id, eventId, receivedAt);

    return {
      disposition: 'incident_resolved',
      incidentId: episode.incident_id,
      transitionId: Number(transition.lastInsertRowid),
    };
  }

  private applyConditionObserved(
    envelope: SignalEnvelope,
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    const conditionClass = envelope.conditionClass as string;
    const occurrenceId = envelope.occurrenceId as string;
    const occurrenceSeq = envelope.occurrenceSeq as number;

    const episode = this.db
      .prepare(
        `SELECT incident_id, condition_state, last_occurrence_seq, projection_version
           FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ? AND occurrence_id = ?`,
      )
      .get(producer.producerDomainId, envelope.subject, conditionClass, occurrenceId) as
      | { incident_id: number; condition_state: string; last_occurrence_seq: number; projection_version: number }
      | undefined;

    if (episode) {
      if (episode.condition_state !== 'open' || occurrenceSeq <= episode.last_occurrence_seq) {
        return { disposition: 'stored_stale_observation', incidentId: episode.incident_id, transitionId: null };
      }
      this.db
        .prepare(
          `UPDATE incidents
              SET last_observed_at = ?, last_occurrence_seq = ?, projection_version = projection_version + 1
            WHERE incident_id = ?`,
        )
        .run(envelope.observedAt, occurrenceSeq, episode.incident_id);
      return { disposition: 'incident_updated', incidentId: episode.incident_id, transitionId: null };
    }

    const openOnKey = this.db
      .prepare(
        `SELECT incident_id FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ?
            AND condition_state = 'open' AND occurrence_id != ?`,
      )
      .all(producer.producerDomainId, envelope.subject, conditionClass, occurrenceId) as Array<{
      incident_id: number;
    }>;

    for (const stale of openOnKey) {
      this.db
        .prepare(
          `UPDATE incidents
              SET condition_state = 'superseded', projection_version = projection_version + 1
            WHERE incident_id = ?`,
        )
        .run(stale.incident_id);
      this.db
        .prepare(
          `INSERT INTO transitions (
             incident_id, from_state, to_state, actor_type, cause_event_id, reason_code, created_at)
           VALUES (?, 'open', 'superseded', 'evaluator', ?, 'newer_occurrence', ?)`,
        )
        .run(stale.incident_id, eventId, receivedAt);
    }

    const openedIncident = this.db
      .prepare(
        `INSERT INTO incidents (
           producer_domain_id, subject, condition_class, occurrence_id,
           condition_state, severity, opened_event_id, last_observed_at,
           last_occurrence_seq, projection_version)
         VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, ?, 1)`,
      )
      .run(
        producer.producerDomainId,
        envelope.subject,
        conditionClass,
        occurrenceId,
        eventId,
        envelope.observedAt,
        occurrenceSeq,
      );
    const incidentId = Number(openedIncident.lastInsertRowid);

    const transition = this.db
      .prepare(
        `INSERT INTO transitions (
           incident_id, from_state, to_state, actor_type, cause_event_id, reason_code, created_at)
         VALUES (?, NULL, 'open', 'evaluator', ?, 'condition_observed', ?)`,
      )
      .run(incidentId, eventId, receivedAt);

    return {
      disposition: 'incident_opened',
      incidentId,
      transitionId: Number(transition.lastInsertRowid),
    };
  }
}

export interface IncidentProjection {
  incidentId: number;
  producerDomainId: string;
  subject: string;
  conditionClass: string;
  occurrenceId: string;
  conditionState: 'open' | 'resolved' | 'superseded' | 'orphaned' | 'closed_by_override';
  severity: string | null;
  openedEventId: number;
  lastObservedAt: string;
  lastOccurrenceSeq: number;
  projectionVersion: number;
}

export interface TransitionRecord {
  transitionId: number;
  incidentId: number;
  fromState: string | null;
  toState: string;
  actorType: 'evaluator' | 'operator' | 'override';
  causeEventId: number | null;
  reasonCode: string;
  createdAt: string;
}

function projectIncident(row: Record<string, unknown>): IncidentProjection {
  return {
    incidentId: row.incident_id as number,
    producerDomainId: row.producer_domain_id as string,
    subject: row.subject as string,
    conditionClass: row.condition_class as string,
    occurrenceId: row.occurrence_id as string,
    conditionState: row.condition_state as IncidentProjection['conditionState'],
    severity: (row.severity as string | null) ?? null,
    openedEventId: row.opened_event_id as number,
    lastObservedAt: row.last_observed_at as string,
    lastOccurrenceSeq: row.last_occurrence_seq as number,
    projectionVersion: row.projection_version as number,
  };
}

function projectTransition(row: Record<string, unknown>): TransitionRecord {
  return {
    transitionId: row.transition_id as number,
    incidentId: row.incident_id as number,
    fromState: (row.from_state as string | null) ?? null,
    toState: row.to_state as string,
    actorType: row.actor_type as TransitionRecord['actorType'],
    causeEventId: (row.cause_event_id as number | null) ?? null,
    reasonCode: row.reason_code as string,
    createdAt: row.created_at as string,
  };
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
