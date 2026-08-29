// src/core/observability/lifecycle-event.ts
// Fleet Lifecycle Observability Standard — Contract E: the versioned
// `whatsoup.lifecycle.event.v1` envelope (design §2).
//
// Closed sets throughout: phases, lanes, envelope keys. Correlation keys are
// carried as they exist at the emitting point (all optional, object required).
// Clock model (O4): `boot_id` + `mono_ms` from day one — progress age derives
// from mono_ms deltas within a boot, never wall-clock subtraction; `at_utc` is
// the durable cross-restart witness.
//
// Privacy (Contract H): `attrs` values are closed to enum-like tokens, finite
// integers, booleans, or keyed digests (`k<N>:<64hex>`). Free-form text —
// message content, contact names, phone-shaped strings — is rejected AT THE
// ENVELOPE, so a leak cannot even be recorded in the private store.
//
// Dark by default: nothing imports this until emission is gated behind the
// `observability.fleetLifecycle` phase (see ./fleet-lifecycle-flag.ts).

import { z } from 'zod';

export const LIFECYCLE_EVENT_SCHEMA_ID = 'whatsoup.lifecycle.event.v1';

export const LIFECYCLE_PHASES = [
  'admitted', 'dispatched', 'acknowledged', 'progress', 'tool_effect',
  'terminal_result', 'finalized', 'delivered', 'suppressed', 'released',
  'recovery_claimed', 'recovery_completed', 'reclaimed', 'abandoned',
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export const LIFECYCLE_LANES = ['L-INT', 'L-SCH', 'L-CTL', 'L-REC', 'L-PRB', 'L-OUT'] as const;
export type LifecycleLane = (typeof LIFECYCLE_LANES)[number];

const KEYED_DIGEST_PATTERN = /^k[1-9][0-9]*:[0-9a-f]{64}$/;
// Enum-like token: starts with a letter, short, no whitespace — never content.
const ENUM_TOKEN_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const attrValueSchema = z.union([
  z.boolean(),
  z.number().int().finite(),
  z.string().refine(
    (value) => KEYED_DIGEST_PATTERN.test(value) || ENUM_TOKEN_PATTERN.test(value),
    { message: 'attrs values must be enum tokens, integers, booleans, or keyed digests — never free-form text' },
  ),
]);

const boundedId = z.string().min(1).max(256);

const correlationSchema = z
  .object({
    trigger_occurrence_id: boundedId.optional(),
    inbound_seq: z.number().int().nonnegative().optional(),
    logical_turn_id: boundedId.optional(),
    session_id: boundedId.optional(),
    outbound_op_id: boundedId.optional(),
    generation: z.number().int().nonnegative().optional(),
  })
  .strict();

const lifecycleEventSchema = z
  .object({
    schema: z.literal(LIFECYCLE_EVENT_SCHEMA_ID),
    instance: boundedId,
    host: boundedId,
    lane: z.enum(LIFECYCLE_LANES),
    origin_lane: z.enum(LIFECYCLE_LANES).nullable(),
    work_id: boundedId,
    correlation: correlationSchema,
    phase: z.enum(LIFECYCLE_PHASES),
    at_utc: z.string().regex(UTC_PATTERN, 'at_utc must be an RFC 3339 UTC timestamp with Z'),
    boot_id: boundedId,
    mono_ms: z.number().int().nonnegative(),
    attrs: z.record(z.string().regex(ENUM_TOKEN_PATTERN), attrValueSchema),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.lane === 'L-REC' && event.origin_lane === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['origin_lane'],
        message: 'L-REC events must carry origin_lane (design §1)',
      });
    }
  });

export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;

export type ParseLifecycleEventResult =
  | { ok: true; event: LifecycleEvent }
  | { ok: false; reason: string };

/** Validate an unknown value as an event.v1 envelope. Never throws. */
export function parseLifecycleEvent(value: unknown): ParseLifecycleEventResult {
  const result = lifecycleEventSchema.safeParse(value);
  if (result.success) return { ok: true, event: result.data };
  const issue = result.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? '(root)' : issue.path.join('.');
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid event'}` };
}
