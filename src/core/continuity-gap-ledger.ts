import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

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

export interface ContinuityGapHealth {
  readable: true;
  open: number;
  unresolved: number;
  ambiguous: number;
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

function triggerFor(classification: PersistedContinuityGapClassification): string {
  return `continuity_gap_${classification}`;
}

function classificationFromTrigger(trigger: string): PersistedContinuityGapClassification {
  const prefix = 'continuity_gap_';
  if (!trigger.startsWith(prefix)) throw new Error('continuity gap ledger contains malformed trigger');
  return requireClassification(trigger.slice(prefix.length));
}

function parseEvidenceRef(value: string | null): ContinuityGapObservation {
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
      } catch { /* best-effort rollback */ }
    }
    throw error;
  }
}

export function readContinuityGapHealth(raw: DatabaseSync): ContinuityGapHealth {
  const rows = raw.prepare(`
    SELECT plans.plan_id, plans.evidence_ref,
           runs.trigger, runs.status, runs.completed_at
    FROM recovery_plans plans
    LEFT JOIN recovery_runs runs
      ON runs.recovery_plan_id = plans.plan_id
     AND runs.trigger LIKE 'continuity_gap_%'
    WHERE plans.actor = ?
    ORDER BY plans.plan_id, runs.id
  `).all(ACTOR) as unknown as HealthRow[];
  const seen = new Set<string>();
  let unresolved = 0;
  let ambiguous = 0;
  for (const row of rows) {
    if (seen.has(row.plan_id)) {
      throw new Error('continuity gap ledger contains duplicate durable state');
    }
    seen.add(row.plan_id);
    if (row.trigger === null || row.status !== 'started' || row.completed_at !== null) {
      throw new Error('continuity gap ledger contains malformed state');
    }
    const evidence = parseEvidenceRef(row.evidence_ref);
    if (planId(evidence) !== row.plan_id) {
      throw new Error('continuity gap ledger contains malformed evidence');
    }
    const classification = classificationFromTrigger(row.trigger);
    if (classification !== evidence.classification) {
      throw new Error('continuity gap ledger contains conflicting taxonomy');
    }
    if (classification === 'ambiguous') ambiguous += 1;
    else unresolved += 1;
  }
  return {
    readable: true,
    open: unresolved + ambiguous,
    unresolved,
    ambiguous,
  };
}
