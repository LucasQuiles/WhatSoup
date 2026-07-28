import { z } from 'zod';

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
  .refine((value) => Number.isFinite(Date.parse(value)), 'observedAt must be an ISO-8601 timestamp');

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

const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    signalId: boundedId,
    kind: z.enum(SIGNAL_KINDS),
    subject: boundedId,
    conditionClass: boundedId.optional(),
    occurrenceId: boundedId.optional(),
    occurrenceSeq: z.number().int().nonnegative().optional(),
    observedAt: isoUtcTimestamp,
    attributes: attributes.optional(),
    recoveryProofClass: boundedId.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isConditionKind =
      value.kind === 'condition_observed' || value.kind === 'condition_recovered';
    if (isConditionKind) {
      if (!value.conditionClass) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'conditionClass required for condition kinds' });
      }
      if (!value.occurrenceId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'occurrenceId required for condition kinds' });
      }
      if (value.occurrenceSeq === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'occurrenceSeq required for condition kinds' });
      }
    }
  });

export interface SignalEnvelope {
  schemaVersion: 1;
  signalId: string;
  kind: SignalKind;
  subject: string;
  conditionClass?: string;
  occurrenceId?: string;
  occurrenceSeq?: number;
  observedAt: string;
  attributes?: Record<string, string | number | boolean>;
  recoveryProofClass?: string;
}

export type EnvelopeResult =
  | { ok: true; envelope: SignalEnvelope }
  | { ok: false; errors: string[] };

export function parseSignalEnvelope(rawJsonText: string): EnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch {
    return { ok: false, errors: ['body is not valid JSON'] };
  }

  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    };
  }
  return { ok: true, envelope: result.data };
}
