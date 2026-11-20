import { z } from 'zod';
import { isRecord } from '../../lib/type-guards.ts';
import { isStrictIsoUtcTimestamp } from '../time-utils.ts';

export const INCIDENT_PHASE_KINDS = [
  'notification_delivered',
  'q_receipt',
  'diagnosis_recorded',
  'change_approved',
  'execution_recorded',
  'recovery_confirmed',
] as const;

export type IncidentPhaseKind = (typeof INCIDENT_PHASE_KINDS)[number];

export const INCIDENT_ACTOR_CLASSES = [
  'observer',
  'notifier',
  'q_receiver',
  'diagnostician',
  'approver',
  'executor',
  'recovery_witness',
] as const;

export type IncidentActorClass = (typeof INCIDENT_ACTOR_CLASSES)[number];

export const RECOVERY_EVIDENCE_CLASSES = [
  'runtime_reverified',
  'provider_acknowledged',
  'sustained_runtime_stability',
] as const;

export type RecoveryEvidenceClass = (typeof RECOVERY_EVIDENCE_CLASSES)[number];

const RECOVERY_EVIDENCE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isRecoveryEvidenceDigest(value: string): boolean {
  return RECOVERY_EVIDENCE_DIGEST.test(value);
}

const boundedId = z.string().min(1).max(128);
const timestamp = z.string().max(64).refine(isStrictIsoUtcTimestamp, 'must be a strict ISO-8601 UTC timestamp');

const schema = z.object({
  schemaVersion: z.literal(1),
  factId: boundedId,
  incidentId: z.number().int().positive(),
  occurrenceId: boundedId,
  phase: z.enum(INCIDENT_PHASE_KINDS),
  sourceEventId: z.number().int().positive(),
  relatedFactId: boundedId.optional(),
  evidenceClass: boundedId.optional(),
  evidenceDigest: z.string().min(1).max(128).optional(),
  observedAt: timestamp,
}).strict();

export type IncidentPhaseEnvelope = z.infer<typeof schema>;

export function parseIncidentPhaseValue(value: unknown):
  | { ok: true; envelope: IncidentPhaseEnvelope }
  | { ok: false; errors: string[] } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, envelope: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
  };
}

export function extractPhaseFactId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.factId === 'string' && value.factId.length > 0 ? value.factId : null;
}
