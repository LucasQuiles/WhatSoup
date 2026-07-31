import type { IncomingMessage, ServerResponse } from 'node:http';
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

  const instance = data['instance'];
  const duration_minutes = data['duration_minutes'];
  const reason = data['reason'];

  if (typeof instance !== 'string' || !instance) {
    jsonResponse(res, 400, { error: 'instance is required' });
    return;
  }
  // The upper bound is what does the work: it rejects Infinity and the finite
  // overflowing values alike. `Number.isFinite` is deliberately NOT used here —
  // it would be unreachable. JSON cannot yield a numeric NaN (`{"d":NaN}` is a
  // SyntaxError, and `{"d":"NaN"}` is a string caught by the typeof check), and
  // ±Infinity is already excluded by the bound and the `<= 0` test.
  if (
    typeof duration_minutes !== 'number'
    || duration_minutes <= 0
    || duration_minutes > MAX_SILENCE_MINUTES
  ) {
    jsonResponse(res, 400, {
      error: `duration_minutes must be a positive number of minutes no greater than ${MAX_SILENCE_MINUTES}`,
    });
    return;
  }

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
