import { z } from 'zod';

export const Severity = z.enum(['crit', 'high', 'med', 'low', 'info']);
export type Severity = z.infer<typeof Severity>;

export const Domain = z.enum(['exposure', 'credential', 'capability', 'change', 'alerting']);
export type Domain = z.infer<typeof Domain>;

export const EventKind = z.enum([
  'drift', 'drift_dedup', 'drift_muted', 'probe_error',
  'baseline_integrity_fail',
  'alert_delivery_succeeded', 'alert_delivery_failed', 'alert_delivery_failed_all',
  'mute_set', 'mute_expire',
  'heartbeat', 'jsonl_mirror_failed',
  'self_secret_widened', 'alert_token_aging', 'cycle_refused', 'cycle_failed',
]);
export type EventKind = z.infer<typeof EventKind>;

export const EventSchema = z.object({
  id: z.number().int().nonnegative(),
  ts: z.string(),
  kind: EventKind,
  domain: Domain.optional(),
  scope_id: z.string().optional(),
  probe_id: z.string().optional(),
  severity: Severity.optional(),
  fingerprint: z.string().length(64).optional(),
  correlation_id: z.string().min(1).optional(),
  payload: z.record(z.unknown()),
  alerted_to: z.enum(['whatsoup', 'local_notification', 'local_log', 'external_push', 'none']).optional(),
}).strict();
export type Event = z.infer<typeof EventSchema>;

export const MuteSchema = z.object({
  id: z.number().int().nonnegative(),
  host: z.string(),
  domain: z.string(),
  expires_at: z.string(),
  reason: z.string().min(1),
  allow_revert_suppression: z.boolean().default(false),
  created_by: z.string(),
}).strict();
export type Mute = z.infer<typeof MuteSchema>;

export const ProbeDocSchema = z.object({
  probe_id: z.string(),
  scope_id: z.string(),
  captured_at: z.string(),
  fields: z.record(z.unknown()),
}).strict();
export type ProbeDoc = z.infer<typeof ProbeDocSchema>;

export const BaselineRowSchema = z.object({
  probe_id: z.string(),
  scope_id: z.string(),
  expected_doc: z.string(),
  captured_at: z.string(),
  captured_by: z.string(),
  hmac: z.string().length(64),
}).strict();
export type BaselineRow = z.infer<typeof BaselineRowSchema>;
