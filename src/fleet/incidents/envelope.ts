import { z } from 'zod';
import { isRecord } from '../../lib/type-guards.ts';
import { isStrictIsoUtcTimestamp } from '../time-utils.ts';

export const SIGNAL_KINDS = [
  'condition_observed',
  'condition_recovered',
  'heartbeat_observed',
  'notice_recorded',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

const MAX_ATTRIBUTE_KEYS = 16;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_STRING_LENGTH = 256;
const MAX_ID_LENGTH = 128;

const boundedId = z.string().min(1).max(MAX_ID_LENGTH);

const isoUtcTimestamp = z
  .string()
  .max(64)
  .refine(isStrictIsoUtcTimestamp, 'must be a strict ISO-8601 UTC timestamp');

const attributeValue = z.union([
  z.string().max(MAX_ATTRIBUTE_STRING_LENGTH),
  z.number().finite(),
  z.boolean(),
]);

const attributes = z
  .record(z.string().min(1).max(MAX_ATTRIBUTE_KEY_LENGTH), attributeValue)
  .refine(
    (record) => Object.keys(record).length <= MAX_ATTRIBUTE_KEYS,
    `attributes may not exceed ${MAX_ATTRIBUTE_KEYS} keys`,
  );

const commonFields = {
  schemaVersion: z.literal(1),
  signalId: boundedId,
  subject: boundedId,
  observedAt: isoUtcTimestamp,
  attributes: attributes.optional(),
};

const occurrenceFields = {
  conditionClass: boundedId,
  occurrenceId: boundedId,
  occurrenceSeq: z.number().int().nonnegative(),
};

const envelopeSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...commonFields, kind: z.literal('condition_observed'), ...occurrenceFields })
    .strict(),
  z
    .object({
      ...commonFields,
      kind: z.literal('condition_recovered'),
      ...occurrenceFields,
      recoveryProofClass: boundedId.optional(),
    })
    .strict(),
  z.object({ ...commonFields, kind: z.literal('heartbeat_observed') }).strict(),
  z.object({ ...commonFields, kind: z.literal('notice_recorded') }).strict(),
]);

export type SignalEnvelope = z.infer<typeof envelopeSchema>;
export type ConditionObservedEnvelope = Extract<SignalEnvelope, { kind: 'condition_observed' }>;
export type ConditionRecoveredEnvelope = Extract<SignalEnvelope, { kind: 'condition_recovered' }>;

export type EnvelopeResult =
  | { ok: true; envelope: SignalEnvelope }
  | { ok: false; errors: string[] };

export function parseSignalEnvelopeValue(parsed: unknown): EnvelopeResult {
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    };
  }
  return { ok: true, envelope: result.data };
}

export function parseSignalEnvelope(rawJsonText: string): EnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch {
    return { ok: false, errors: ['body is not valid JSON'] };
  }
  return parseSignalEnvelopeValue(parsed);
}

/**
 * Extract the producer-declared signal identity from an already-parsed body.
 * Identity must be resolvable before full validation so idempotent replays and
 * identity conflicts can be answered even for bodies that fail later checks.
 */
export function extractSignalId(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const candidate = parsed.signalId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}
