import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readBody, jsonResponse } from '../../lib/http.ts';
import {
  silenceRegistryUnavailableError,
  validationError,
} from '../response-error-projection.ts';
import {
  SilenceRuleValidationError,
  SilenceStoreUnavailableError,
  addSilence,
  listActiveSilences,
  removeSilence,
} from '../silence-manager.ts';

/**
 * Longest silence this API will install, in minutes (one year).
 *
 * A silence suppresses alerting for an instance, so the bound is not cosmetic.
 * Two distinct failures live past it:
 *
 *  - `1e999` is a VALID JSON number literal that parses to `Infinity`, and
 *    `Infinity <= 0` is false, so it passed the old guard. `addSilence` then
 *    built `new Date(now + Infinity)` and `toISOString()` threw a RangeError out
 *    of an unguarded call — a 500 on a request that should have been a 400.
 *  - The issue's suggested `Number.isFinite` guard does NOT close that hole:
 *    `1e308` and `1e12` are finite and still exceed the ECMA-262 maximum time
 *    value (8.64e15 ms), so they throw identically. Only an explicit upper
 *    bound rejects them — which is why this is a bound and not a finiteness
 *    test.
 *
 * A year is far inside the Date range and generous for any maintenance window,
 * while guaranteeing a silence cannot outlive the operator who set it.
 */
export const MAX_SILENCE_MINUTES = 365 * 24 * 60;

const DURATION_MINUTES_ERROR =
  `duration_minutes must be a positive number of minutes no greater than ${MAX_SILENCE_MINUTES}`;

/**
 * Field-scoped shape schemas for `handleAddSilence`'s request-body
 * validators (Tier-B lane 2, tierb-contract-lane-spec-r15 §1.4). `instance`
 * and `duration_minutes` are each their own schema, checked SEQUENTIALLY in
 * the handler below with an early return per field, rather than one
 * combined `z.object(...)`. That mirrors the original ladder's own
 * short-circuit order exactly — `instance` is validated before
 * `duration_minutes` ever runs, so a body invalid in both fields must
 * report `'instance is required'`, never the duration message. A single
 * combined schema's default cross-field issue collection does not
 * guarantee that ordering (PILOT ADDENDUM point 1); two independently
 * early-returning schemas make the precedence explicit and remove the
 * ambiguity instead of relying on `issues[0]` across fields.
 *
 * `data['instance']` / `data['duration_minutes']` extraction happens
 * exactly as it did before conversion (see `handleAddSilence` below) — a
 * literal JSON `null` body still throws a TypeError on that property
 * access (no `isRecord` guard exists here, unlike health.ts's endpoints),
 * preserved on purpose (see tests/fleet/routes/silence-zod-equivalence.test.ts's
 * null-body crash case). Because the schemas below only ever see the
 * already-extracted field VALUE, not the raw `data` object, no
 * `z.object`-level `invalid_type_error` override is needed here — there is
 * no object-shape node in this conversion for a non-object root to hit.
 *
 * `reason` is deliberately NOT modeled — the original ladder never
 * rejects on it (`typeof reason === 'string' ? reason : 'manual silence'`,
 * a silent cast-through with no reject path), so giving it a schema would
 * add a rejection mode the original never had (lane spec §3.5).
 */
const InstanceFieldSchema = z
  .string({
    required_error: 'instance is required',
    invalid_type_error: 'instance is required',
  })
  .min(1, { message: 'instance is required' });

/**
 * `duration_minutes must be a positive number ... no greater than N` covers
 * three original sub-conditions (wrong type, `<= 0`, `> MAX_SILENCE_MINUTES`)
 * with ONE literal message. Unlike `/access`'s three sequential DISTINCT
 * messages, this field has no message-ordering ambiguity to resolve: the
 * three sub-conditions are mutually exclusive per value (a value cannot
 * simultaneously fail the type check and a numeric range check), so
 * whichever single zod check fires, the resulting message is identical.
 * `.gt(0)` matches the original strict `<= 0` rejection; `.max()` is
 * inclusive, matching the original `> MAX_SILENCE_MINUTES` rejection (a
 * duration exactly at the cap is accepted).
 */
const DurationMinutesFieldSchema = z
  .number({
    required_error: DURATION_MINUTES_ERROR,
    invalid_type_error: DURATION_MINUTES_ERROR,
  })
  .gt(0, { message: DURATION_MINUTES_ERROR })
  .max(MAX_SILENCE_MINUTES, { message: DURATION_MINUTES_ERROR });

function respondSilenceRegistryUnavailable(
  res: ServerResponse,
  result: SilenceStoreUnavailableError,
): void {
  jsonResponse(
    res,
    result.readBasis === 'last_known_good' ? 409 : 503,
    silenceRegistryUnavailableError(result.reasonClass === 'read_failed'),
  );
}

/** GET /api/fleet/silences — list active silences */
export async function handleGetSilences(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const result = listActiveSilences();
  if (result.rules === null) {
    respondSilenceRegistryUnavailable(res, new SilenceStoreUnavailableError(result));
    return;
  }
  const { rules, ...metadata } = result;
  jsonResponse(res, 200, { ...metadata, silences: rules });
}

/** POST /api/fleet/silence — add a silence */
export async function handleAddSilence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    jsonResponse(res, 400, validationError('invalid_request_body', 'silence'));
    return;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON' });
    return;
  }

  // Property access on `data` below is unguarded on purpose: no `isRecord`
  // check exists before it, so a literal JSON `null` body still throws a
  // TypeError here exactly as it did before this field-shape guard moved to
  // zod (see the equivalence net's null-body crash case).
  const instanceField = InstanceFieldSchema.safeParse(data['instance']);
  if (!instanceField.success) {
    jsonResponse(res, 400, { error: instanceField.error.issues[0]?.message ?? 'instance is required' });
    return;
  }
  const instance = instanceField.data;

  const durationField = DurationMinutesFieldSchema.safeParse(data['duration_minutes']);
  if (!durationField.success) {
    jsonResponse(res, 400, { error: durationField.error.issues[0]?.message ?? DURATION_MINUTES_ERROR });
    return;
  }
  const duration_minutes = durationField.data;

  const reason = data['reason'];

  let rule;
  try {
    rule = addSilence(
      instance,
      duration_minutes,
      typeof reason === 'string' ? reason : 'manual silence',
      'fleet-api',
    );
  } catch (err) {
    if (err instanceof SilenceStoreUnavailableError) {
      respondSilenceRegistryUnavailable(res, err);
      return;
    }
    if (err instanceof SilenceRuleValidationError) {
      jsonResponse(res, 400, validationError('invalid_silence_rule', 'silence'));
      return;
    }
    throw err;
  }
  jsonResponse(res, 200, { ok: true, rule });
}

/** DELETE /api/fleet/silence/:instance — remove a silence */
export async function handleRemoveSilence(
  _req: IncomingMessage,
  res: ServerResponse,
  params: { instance: string },
): Promise<void> {
  let removed: boolean;
  try {
    removed = removeSilence(params.instance);
  } catch (err) {
    if (err instanceof SilenceStoreUnavailableError) {
      respondSilenceRegistryUnavailable(res, err);
      return;
    }
    throw err;
  }
  if (!removed) {
    jsonResponse(res, 404, { error: 'no silence found for instance' });
    return;
  }
  jsonResponse(res, 200, { ok: true });
}
