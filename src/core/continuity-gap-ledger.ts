import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readContinuityGapClosureLedger } from './continuity-gap-closure-schema.ts';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ACTOR = 'continuity_manifest_recorder';
const SUMMARY = 'Continuity receipt requires reconciliation';
const CLASSIFICATIONS = new Set([
  'absent',
  'observed_not_admitted',
  'ambiguous',
] as const);

export type PersistedContinuityGapClassification =
  | 'absent'
  | 'observed_not_admitted'
  | 'ambiguous';

export interface ContinuityGapObservation {
  ordinal: number;
  classification: PersistedContinuityGapClassification;
  receiptFingerprint: string;
  destinationFingerprint: string;
  manifestFingerprint: string;
  evidenceFingerprint: string;
}

export interface RecordContinuityGapsResult {
  created: number;
  existing: number;
  unresolved: number;
  ambiguous: number;
}

/**
 * Content-free continuity counts. Identities that hold whenever
 * `closure_ledger` is `present`: total = open + closed,
 * open = unresolved + ambiguous, closed = addressed + declined.
 * `ambiguous` counts only open, originally ambiguous gaps; `ambiguous_total`
 * counts every originally ambiguous gap, closed or not. A database that never
 * ran migration 65 reports `closure_ledger: 'absent'` with the closure buckets
 * and total null: its open counts are real, its closure history is unknown.
 */
export type ContinuityGapHealth = {
  readable: true;
  open: number;
  unresolved: number;
  ambiguous: number;
  ambiguous_total: number;
} & (
  | {
    closure_ledger: 'present';
    total: number;
    closed: number;
    addressed: number;
    declined: number;
  }
  | {
    closure_ledger: 'absent';
    total: null;
    closed: null;
    addressed: null;
    declined: null;
  }
);

/** Health fallback when the ledger cannot be read exactly: no count is claimed. */
export interface ContinuityGapHealthUnreadable {
  readable: false;
  closure_ledger: null;
  total: null;
  open: null;
  unresolved: null;
  ambiguous: null;
  ambiguous_total: null;
  closed: null;
  addressed: null;
  declined: null;
}

export const CONTINUITY_GAP_HEALTH_UNREADABLE: ContinuityGapHealthUnreadable = Object.freeze({
  readable: false,
  closure_ledger: null,
  total: null,
  open: null,
  unresolved: null,
  ambiguous: null,
  ambiguous_total: null,
  closed: null,
  addressed: null,
  declined: null,
});

export interface ContinuityGapLedgerEntry {
  planId: string;
  observation: ContinuityGapObservation;
}

interface StoredPlanRow {
  plan_id: string;
  origin: string;
  actor: string;
  summary: string;
  evidence_ref: string | null;
}

interface HealthRow {
  plan_id: string;
  origin: string;
  actor: string;
  summary: string;
  trigger: string | null;
  status: string | null;
  completed_at: string | null;
  evidence_ref: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireFingerprint(value: string, label: string): string {
  if (!HASH_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function requireOrdinal(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Continuity gap ordinal must be a positive safe integer');
  }
  return value;
}

function requireClassification(
  value: string,
): PersistedContinuityGapClassification {
  if (!CLASSIFICATIONS.has(value as PersistedContinuityGapClassification)) {
    throw new Error('Unsupported continuity gap classification');
  }
  return value as PersistedContinuityGapClassification;
}

function normalizedObservation(value: ContinuityGapObservation): ContinuityGapObservation {
  return {
    ordinal: requireOrdinal(value.ordinal),
    classification: requireClassification(value.classification),
    receiptFingerprint: requireFingerprint(value.receiptFingerprint, 'Receipt fingerprint'),
    destinationFingerprint: requireFingerprint(
      value.destinationFingerprint,
      'Destination fingerprint',
    ),
    manifestFingerprint: requireFingerprint(value.manifestFingerprint, 'Manifest fingerprint'),
    evidenceFingerprint: requireFingerprint(value.evidenceFingerprint, 'Evidence fingerprint'),
  };
}

function evidenceRef(observation: ContinuityGapObservation): string {
  return [
    'continuity-gap:v1',
    `receipt=${observation.receiptFingerprint}`,
    `destination=${observation.destinationFingerprint}`,
    `manifest=${observation.manifestFingerprint}`,
    `evidence=${observation.evidenceFingerprint}`,
    `ordinal=${observation.ordinal}`,
    `classification=${observation.classification}`,
  ].join(';');
}

function planId(observation: ContinuityGapObservation): string {
  return `continuity-gap:v1:${sha256(evidenceRef(observation))}`;
}

/** Deterministic plan ID of a recorded observation (shared with closure). */
export function continuityGapPlanId(observation: ContinuityGapObservation): string {
  return planId(normalizedObservation(observation));
}

function triggerFor(classification: PersistedContinuityGapClassification): string {
  return `continuity_gap_${classification}`;
}

function classificationFromTrigger(trigger: string): PersistedContinuityGapClassification {
  const prefix = 'continuity_gap_';
  if (!trigger.startsWith(prefix)) throw new Error('continuity gap ledger contains malformed trigger');
  return requireClassification(trigger.slice(prefix.length));
}

export function parseContinuityGapEvidenceRef(value: string | null): ContinuityGapObservation {
  if (value === null) throw new Error('continuity gap ledger contains malformed evidence');
  const match = /^continuity-gap:v1;receipt=([a-f0-9]{64});destination=([a-f0-9]{64});manifest=([a-f0-9]{64});evidence=([a-f0-9]{64});ordinal=([1-9][0-9]*);classification=(absent|observed_not_admitted|ambiguous)$/.exec(value);
  if (!match) throw new Error('continuity gap ledger contains malformed evidence');
  const ordinal = Number(match[5]);
  if (!Number.isSafeInteger(ordinal)) {
    throw new Error('continuity gap ledger contains malformed evidence');
  }
  return {
    receiptFingerprint: match[1],
    destinationFingerprint: match[2],
    manifestFingerprint: match[3],
    evidenceFingerprint: match[4],
    ordinal,
    classification: requireClassification(match[6]),
  };
}

function assertStoredPlan(
  row: StoredPlanRow | undefined,
  expectedPlanId: string,
  expectedEvidenceRef: string,
): void {
  if (
    !row
    || row.plan_id !== expectedPlanId
    || row.origin !== 'operator'
    || row.actor !== ACTOR
    || row.summary !== SUMMARY
    || row.evidence_ref !== expectedEvidenceRef
  ) {
    throw new Error('Continuity gap plan conflicts with existing durable evidence');
  }
}

export function recordContinuityGaps(
  raw: DatabaseSync,
  observations: ContinuityGapObservation[],
): RecordContinuityGapsResult {
  if (observations.length < 1 || observations.length > 200) {
    throw new Error('Continuity gap recording requires between 1 and 200 observations');
  }
  const normalized = observations.map(normalizedObservation);
  const identities = normalized.map(planId);
  if (new Set(identities).size !== identities.length) {
    throw new Error('Continuity gap observations contain duplicate durable identities');
  }

  const nested = raw.isTransaction;
  const begin = nested ? null : raw.prepare('BEGIN IMMEDIATE');
  const commit = nested ? null : raw.prepare('COMMIT');
  const rollback = nested ? null : raw.prepare('ROLLBACK');
  const insertPlan = raw.prepare(`
    INSERT OR IGNORE INTO recovery_plans (
      plan_id, origin, actor, summary, evidence_ref
    ) VALUES (?, 'operator', ?, ?, ?)
  `);
  const readPlan = raw.prepare(`
    SELECT plan_id, origin, actor, summary, evidence_ref
    FROM recovery_plans
    WHERE plan_id = ?
  `);
  const readRun = raw.prepare(`
    SELECT id, trigger, status, completed_at
    FROM recovery_runs
    WHERE recovery_plan_id = ?
      AND trigger LIKE 'continuity_gap_%'
  `);
  const insertRun = raw.prepare(`
    INSERT INTO recovery_runs (trigger, recovery_plan_id, status)
    VALUES (?, ?, 'started')
  `);

  if (nested) raw.exec('SAVEPOINT continuity_gap_record');
  else begin?.run();
  let opened = true;
  try {
    let created = 0;
    let existing = 0;
    for (const observation of normalized) {
      const id = planId(observation);
      const evidence = evidenceRef(observation);
      const inserted = Number(insertPlan.run(id, ACTOR, SUMMARY, evidence).changes);
      assertStoredPlan(readPlan.get(id) as StoredPlanRow | undefined, id, evidence);
      const runs = readRun.all(id) as Array<{
        trigger: string;
        status: string;
        completed_at: string | null;
      }>;
      if (runs.length > 1) {
        throw new Error('Continuity gap plan has duplicate durable state');
      }
      if (runs.length === 0) {
        if (inserted !== 1) {
          throw new Error('Continuity gap plan is missing its durable state');
        }
        insertRun.run(triggerFor(observation.classification), id);
        created += 1;
      } else {
        const run = runs[0];
        if (
          run.trigger !== triggerFor(observation.classification)
          || run.status !== 'started'
          || run.completed_at !== null
        ) {
          throw new Error('Continuity gap plan conflicts with existing durable state');
        }
        existing += 1;
      }
    }
    if (nested) raw.exec('RELEASE continuity_gap_record');
    else commit?.run();
    opened = false;
    const ambiguous = normalized.filter((row) => row.classification === 'ambiguous').length;
    return {
      created,
      existing,
      unresolved: normalized.length - ambiguous,
      ambiguous,
    };
  } catch (error) {
    if (opened) {
      try {
        if (nested) {
          raw.exec('ROLLBACK TO continuity_gap_record');
          raw.exec('RELEASE continuity_gap_record');
        } else {
          rollback?.run();
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Continuity gap recording failed and rollback did not complete',
        );
      }
    }
    throw error;
  }
}

/** Every recorded gap, validated exactly; throws on any malformed ledger state. */
export function readContinuityGapLedger(raw: DatabaseSync): ContinuityGapLedgerEntry[] {
  const foreignReservedState = raw.prepare(`
    SELECT 1
    FROM recovery_runs runs
    JOIN recovery_plans plans ON plans.plan_id = runs.recovery_plan_id
    WHERE runs.trigger LIKE 'continuity_gap_%'
      AND plans.actor <> ?
    LIMIT 1
  `).get(ACTOR);
  if (foreignReservedState) {
    throw new Error('continuity gap ledger contains foreign reserved state');
  }
  const rows = raw.prepare(`
    SELECT plans.plan_id, plans.origin, plans.actor, plans.summary, plans.evidence_ref,
           runs.trigger, runs.status, runs.completed_at
    FROM recovery_plans plans
    LEFT JOIN recovery_runs runs
      ON runs.recovery_plan_id = plans.plan_id
     AND runs.trigger LIKE 'continuity_gap_%'
    WHERE plans.actor = ?
    ORDER BY plans.plan_id, runs.id
  `).all(ACTOR) as unknown as HealthRow[];
  const seen = new Set<string>();
  const entries: ContinuityGapLedgerEntry[] = [];
  for (const row of rows) {
    if (seen.has(row.plan_id)) {
      throw new Error('continuity gap ledger contains duplicate durable state');
    }
    seen.add(row.plan_id);
    if (row.trigger === null || row.status !== 'started' || row.completed_at !== null) {
      throw new Error('continuity gap ledger contains malformed state');
    }
    const evidence = parseContinuityGapEvidenceRef(row.evidence_ref);
    if (planId(evidence) !== row.plan_id) {
      throw new Error('continuity gap ledger contains malformed evidence');
    }
    if (
      row.origin !== 'operator'
      || row.actor !== ACTOR
      || row.summary !== SUMMARY
    ) {
      throw new Error('continuity gap ledger contains malformed plan ownership');
    }
    const classification = classificationFromTrigger(row.trigger);
    if (classification !== evidence.classification) {
      throw new Error('continuity gap ledger contains conflicting taxonomy');
    }
    entries.push({ planId: row.plan_id, observation: evidence });
  }
  return entries;
}

/**
 * Continuity counts for health and every other reader. A closure must name a
 * recorded gap and carry its receipt fingerprint and classification; anything
 * else makes the whole reading unreadable rather than silently uncounted.
 */
export function readContinuityGapHealth(raw: DatabaseSync): ContinuityGapHealth {
  const entries = readContinuityGapLedger(raw);
  const closures = readContinuityGapClosureLedger(raw);
  const byPlan = new Map(closures.state === 'present'
    ? closures.rows.map((row) => [row.planId, row])
    : []);
  let unresolved = 0;
  let ambiguous = 0;
  let ambiguousTotal = 0;
  let addressed = 0;
  let declined = 0;
  for (const { planId: id, observation } of entries) {
    const originallyAmbiguous = observation.classification === 'ambiguous';
    if (originallyAmbiguous) ambiguousTotal += 1;
    const closure = byPlan.get(id);
    if (!closure) {
      if (originallyAmbiguous) ambiguous += 1;
      else unresolved += 1;
      continue;
    }
    byPlan.delete(id);
    if (
      closure.receiptFingerprint !== observation.receiptFingerprint
      || closure.originalClassification !== observation.classification
    ) {
      throw new Error('continuity gap closure ledger contains a conflicting closure');
    }
    if (closure.disposition === 'addressed') addressed += 1;
    else declined += 1;
  }
  if (byPlan.size > 0) {
    throw new Error('continuity gap closure ledger contains an orphaned closure');
  }
  const open = unresolved + ambiguous;
  if (closures.state === 'absent') {
    return {
      readable: true,
      closure_ledger: 'absent',
      total: null,
      open,
      unresolved,
      ambiguous,
      ambiguous_total: ambiguousTotal,
      closed: null,
      addressed: null,
      declined: null,
    };
  }
  const closed = addressed + declined;
  return {
    readable: true,
    closure_ledger: 'present',
    total: open + closed,
    open,
    unresolved,
    ambiguous,
    ambiguous_total: ambiguousTotal,
    closed,
    addressed,
    declined,
  };
}
