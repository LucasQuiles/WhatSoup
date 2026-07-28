import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  extractSignalId,
  parseSignalEnvelopeValue,
  type ConditionObservedEnvelope,
  type ConditionRecoveredEnvelope,
  type SignalEnvelope,
  type SignalKind,
} from './envelope.ts';
import type { Disposition } from './schema.ts';

export type { Disposition } from './schema.ts';

export interface ProducerContext {
  producerId: string;
  producerDomainId: string;
}

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
  | { outcome: 'invalid'; malformedJson: boolean; errors: string[] };

const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_LIST_LIMIT = 200;

interface StoredEventRow {
  event_id: number;
  signal_id: string;
  payload_digest: string;
  received_at: string;
  disposition: string;
  incident_id: number | null;
  transition_id: number | null;
}

interface EpisodeRow {
  incident_id: number;
  condition_state: string;
  last_occurrence_seq: number;
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
    let parsedBody: unknown;
    let malformedJson = false;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = undefined;
      malformedJson = true;
    }

    // Replays and conflicts are answered before validation: a stored signal's
    // receipt stays retrievable even if the schema tightens later, and a
    // conflicting resend must surface as a conflict, not as invalid. A single
    // SELECT is atomic, so no transaction is needed on this path. Bodies
    // without extractable identity can never be replays (signalId min length
    // is 1), so they skip the lookup entirely.
    const signalId = extractSignalId(parsedBody);
    if (signalId !== null) {
      const existing = this.findStoredEvent(producer.producerId, signalId);
      if (existing) {
        if (existing.payload_digest === sha256Digest(rawBody)) {
          return { outcome: 'idempotent_replay', receipt: this.receiptFromRow(existing, producer) };
        }
        return { outcome: 'identity_conflict', existingDigest: existing.payload_digest };
      }
    }

    if (malformedJson) {
      return { outcome: 'invalid', malformedJson: true, errors: ['body is not valid JSON'] };
    }
    const parsed = parseSignalEnvelopeValue(parsedBody);
    if (!parsed.ok) {
      return { outcome: 'invalid', malformedJson: false, errors: parsed.errors };
    }
    const envelope = parsed.envelope;

    const payloadDigest = sha256Digest(rawBody);
    const receivedAt = now.toISOString();
    const quarantined = Date.parse(envelope.observedAt) > now.getTime() + this.maxFutureSkewMs;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Another connection may have stored this identity between the
      // unlocked pre-check and the write lock; the re-check converts that
      // race into replay/conflict instead of a UNIQUE-constraint throw.
      const raced = this.findStoredEvent(producer.producerId, envelope.signalId);
      if (raced) {
        this.db.exec('ROLLBACK');
        if (raced.payload_digest === payloadDigest) {
          return { outcome: 'idempotent_replay', receipt: this.receiptFromRow(raced, producer) };
        }
        return { outcome: 'identity_conflict', existingDigest: raced.payload_digest };
      }

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
          'conditionClass' in envelope ? envelope.conditionClass : null,
          'occurrenceId' in envelope ? envelope.occurrenceId : null,
          'occurrenceSeq' in envelope ? envelope.occurrenceSeq : null,
          envelope.observedAt,
          receivedAt,
        );
      const eventId = Number(inserted.lastInsertRowid);

      const effect = this.applyLifecycle(envelope, producer, eventId, receivedAt, quarantined);

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

  listIncidents(filter?: {
    subject?: string;
    conditionState?: IncidentProjection['conditionState'];
    conditionClass?: string;
    producerDomainId?: string;
    afterIncidentId?: number;
    limit?: number;
  }): IncidentProjection[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.subject) { clauses.push('subject = ?'); params.push(filter.subject); }
    if (filter?.conditionState) { clauses.push('condition_state = ?'); params.push(filter.conditionState); }
    if (filter?.conditionClass) { clauses.push('condition_class = ?'); params.push(filter.conditionClass); }
    if (filter?.producerDomainId) { clauses.push('producer_domain_id = ?'); params.push(filter.producerDomainId); }
    if (filter?.afterIncidentId !== undefined) { clauses.push('incident_id > ?'); params.push(filter.afterIncidentId); }

    const limit = Math.min(Math.max(filter?.limit ?? MAX_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM incidents ${where} ORDER BY incident_id LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(projectIncident);
  }

  getEvent(eventId: number): StoredEvent | null {
    const row = this.db
      .prepare(
        `SELECT event_id, producer_id, producer_domain_id, signal_id, payload_digest,
                kind, subject, condition_class, occurrence_id, occurrence_seq,
                observed_at, received_at, disposition, incident_id, transition_id
           FROM events WHERE event_id = ?`,
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      eventId: row.event_id as number,
      producerId: row.producer_id as string,
      producerDomainId: row.producer_domain_id as string,
      signalId: row.signal_id as string,
      payloadDigest: row.payload_digest as string,
      kind: row.kind as SignalKind,
      subject: row.subject as string,
      conditionClass: (row.condition_class as string | null) ?? null,
      occurrenceId: (row.occurrence_id as string | null) ?? null,
      occurrenceSeq: (row.occurrence_seq as number | null) ?? null,
      observedAt: row.observed_at as string,
      receivedAt: row.received_at as string,
      disposition: row.disposition as Disposition,
      incidentId: (row.incident_id as number | null) ?? null,
      transitionId: (row.transition_id as number | null) ?? null,
    };
  }

  private findStoredEvent(producerId: string, signalId: string): StoredEventRow | undefined {
    return this.db
      .prepare(
        `SELECT event_id, signal_id, payload_digest, received_at, disposition,
                incident_id, transition_id
           FROM events WHERE producer_id = ? AND signal_id = ?`,
      )
      .get(producerId, signalId) as StoredEventRow | undefined;
  }

  private receiptFromRow(row: StoredEventRow, producer: ProducerContext): SignalReceipt {
    return {
      schemaVersion: 1,
      eventId: row.event_id,
      producerId: producer.producerId,
      signalId: row.signal_id,
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
    quarantined: boolean,
  ): LifecycleEffect {
    if (quarantined) {
      // Out-of-skew observations are stored state-inert for every kind (spec
      // §2/§3); the Plan-3 evaluator hooks its clock-skew incident in here.
      return { disposition: 'stored_quarantined_observation', incidentId: null, transitionId: null };
    }
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

  private applyConditionObserved(
    envelope: ConditionObservedEnvelope,
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    const episode = this.findEpisode(producer, envelope);

    if (episode) {
      if (episode.condition_state !== 'open') {
        // The episode already concluded; like an unmatched recovery, the
        // observation is retained but cannot change concluded state.
        return { disposition: 'stored_no_state_change', incidentId: null, transitionId: null };
      }
      if (envelope.occurrenceSeq <= episode.last_occurrence_seq) {
        return { disposition: 'stored_stale_observation', incidentId: episode.incident_id, transitionId: null };
      }
      this.db
        .prepare(
          `UPDATE incidents
              SET last_observed_at = ?, last_occurrence_seq = ?, projection_version = projection_version + 1
            WHERE incident_id = ?`,
        )
        .run(envelope.observedAt, envelope.occurrenceSeq, episode.incident_id);
      return { disposition: 'incident_updated', incidentId: episode.incident_id, transitionId: null };
    }

    const openOnKey = this.db
      .prepare(
        `SELECT incident_id FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ?
            AND condition_state = 'open' AND occurrence_id != ?`,
      )
      .all(
        producer.producerDomainId,
        envelope.subject,
        envelope.conditionClass,
        envelope.occurrenceId,
      ) as Array<{ incident_id: number }>;

    for (const stale of openOnKey) {
      this.db
        .prepare(
          `UPDATE incidents
              SET condition_state = 'superseded', projection_version = projection_version + 1
            WHERE incident_id = ?`,
        )
        .run(stale.incident_id);
      this.insertTransition(stale.incident_id, 'open', 'superseded', eventId, 'newer_occurrence', receivedAt);
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
        envelope.conditionClass,
        envelope.occurrenceId,
        eventId,
        envelope.observedAt,
        envelope.occurrenceSeq,
      );
    const incidentId = Number(openedIncident.lastInsertRowid);
    const transitionId = this.insertTransition(incidentId, null, 'open', eventId, 'condition_observed', receivedAt);

    return { disposition: 'incident_opened', incidentId, transitionId };
  }

  private applyConditionRecovered(
    envelope: ConditionRecoveredEnvelope,
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    const episode = this.findEpisode(producer, envelope);

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
    const transitionId = this.insertTransition(episode.incident_id, 'open', 'resolved', eventId, 'verified_recovery', receivedAt);

    return { disposition: 'incident_resolved', incidentId: episode.incident_id, transitionId };
  }

  private findEpisode(
    producer: ProducerContext,
    envelope: ConditionObservedEnvelope | ConditionRecoveredEnvelope,
  ): EpisodeRow | undefined {
    return this.db
      .prepare(
        `SELECT incident_id, condition_state, last_occurrence_seq
           FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ? AND occurrence_id = ?`,
      )
      .get(
        producer.producerDomainId,
        envelope.subject,
        envelope.conditionClass,
        envelope.occurrenceId,
      ) as EpisodeRow | undefined;
  }

  private insertTransition(
    incidentId: number,
    fromState: string | null,
    toState: string,
    causeEventId: number,
    reasonCode: string,
    createdAt: string,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO transitions (
           incident_id, from_state, to_state, actor_type, cause_event_id, reason_code, created_at)
         VALUES (?, ?, ?, 'evaluator', ?, ?, ?)`,
      )
      .run(incidentId, fromState, toState, causeEventId, reasonCode, createdAt);
    return Number(result.lastInsertRowid);
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

export interface StoredEvent {
  eventId: number;
  producerId: string;
  producerDomainId: string;
  signalId: string;
  payloadDigest: string;
  kind: SignalKind;
  subject: string;
  conditionClass: string | null;
  occurrenceId: string | null;
  occurrenceSeq: number | null;
  observedAt: string;
  receivedAt: string;
  disposition: Disposition;
  incidentId: number | null;
  transitionId: number | null;
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

function sha256Digest(rawBody: string): string {
  return `sha256:${createHash('sha256').update(rawBody, 'utf-8').digest('hex')}`;
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
