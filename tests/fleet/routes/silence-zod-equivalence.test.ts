// tests/fleet/routes/silence-zod-equivalence.test.ts
//
// Equivalence net for Tier-B lane 2 (#2203 tierb-contract-lane-spec-r15,
// lane 2): src/fleet/routes/silence.ts's `handleAddSilence` hand-rolled
// request-body shape guards for `instance` and `duration_minutes` move to
// zod. Only those two REJECTING field checks are in scope — `reason` is a
// silent cast-through (`typeof reason === 'string' ? reason : 'manual
// silence'`) that never rejects, and the `readBody`/`JSON.parse` catches
// plus the `addSilence()`-throw-derived `fleet-error-v1` branch are
// envelope/business-rule concerns outside a shape-guard conversion (lane
// spec §1.4). This file is written and run GREEN against the
// pre-conversion handler first (see the lane's commit evidence trailer);
// it is then re-run UNMODIFIED after the conversion to prove the shape
// guard's exact `error` message text per branch — and its message
// PRECEDENCE when both fields are simultaneously invalid — did not drift.
//
// `handleAddSilence` is exported directly (unlike media-bridge's private
// socket handler), so both the reference ladder and the live verdict are
// observed the same way tests/fleet/routes/silence.test.ts does: calling
// the handler with mockReq/mockRes, homedir redirected to a temp dir.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';
import { MAX_SILENCE_MINUTES } from '../../../src/fleet/routes/silence.ts';

const DURATION_ERROR =
  `duration_minutes must be a positive number of minutes no greater than ${MAX_SILENCE_MINUTES}`;

// ─── Reference implementation ──────────────────────────────────────────────
// Verbatim pre-conversion shape guard (silence.ts handleAddSilence, the
// `instance`/`duration_minutes` ladder as of the r15 lane-2 anchor). Do not
// modernize this — it defines the value space and message text the zod
// schemas must reproduce exactly, including short-circuit ORDER: `instance`
// is checked before `duration_minutes`, so an instance-invalid body never
// reaches the duration check.
//
// Deliberately does NOT guard against a non-object `data` the way health.ts's
// endpoints do (no `isRecord` gate exists before `data['instance']` in the
// original code) — so this reference function propagates the same
// TypeError a literal JSON `null` body throws on property access, instead
// of catching it. See the crash-preservation test below.
type ShapeVerdict =
  | { stage: 'invalid_json' }
  | { stage: 'instance_required' }
  | { stage: 'duration_invalid' }
  | { stage: 'ok'; instance: string; duration_minutes: number };

function referenceAddSilenceShapeGuard(raw: string): ShapeVerdict {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { stage: 'invalid_json' };
  }
  const d = data as Record<string, unknown>;
  const instance = d['instance'];
  const duration_minutes = d['duration_minutes'];
  if (typeof instance !== 'string' || !instance) {
    return { stage: 'instance_required' };
  }
  if (
    typeof duration_minutes !== 'number'
    || duration_minutes <= 0
    || duration_minutes > MAX_SILENCE_MINUTES
  ) {
    return { stage: 'duration_invalid' };
  }
  return { stage: 'ok', instance, duration_minutes };
}

// ─── Harness ────────────────────────────────────────────────────────────────
// Mirrors tests/fleet/routes/silence.test.ts's homedir-redirect pattern:
// addSilence() persists to ~/.config/whatsoup/fleet-silences.json, so the
// accept-branch cases need a real (temp) home directory to reach 200
// without polluting the operator's actual config.

let homeDir: string;

async function importRoutes(): Promise<typeof import('../../../src/fleet/routes/silence.ts')> {
  return import('../../../src/fleet/routes/silence.ts');
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'whatsoup-silence-zod-eq-'));
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal: () => Promise<typeof import('node:os')>) => {
    const actual = await importOriginal();
    return { ...actual, homedir: () => homeDir };
  });
});

afterEach(() => {
  vi.doUnmock('node:os');
  vi.resetModules();
  rmSync(homeDir, { recursive: true, force: true });
});

// ─── Crash-preservation: literal JSON null body ────────────────────────────

describe('silence shape-guard equivalence: null-body crash (legacy trap, preserved on purpose)', () => {
  it('reference ladder throws a TypeError on property access against a null root', () => {
    expect(() => referenceAddSilenceShapeGuard('null')).toThrow(TypeError);
  });

  it('live handler rejects (throws) the same way — not a graceful 400', async () => {
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await expect(
      handleAddSilence(mockReq({ method: 'POST', url: '/api/fleet/silence', body: 'null' }), res),
    ).rejects.toThrow(TypeError);
    // No response was ever written — the crash happens before any
    // jsonResponse() call, same as pre-conversion.
    expect(res._status).toBe(0);
  });
});

// ─── Shape-rejecting cases: reference verdict + exact live message ─────────

interface RejectCase {
  name: string;
  body: string;
  stage: 'invalid_json' | 'instance_required' | 'duration_invalid';
  message: string;
}

const rejectCases: RejectCase[] = [
  { name: 'malformed JSON', body: '{', stage: 'invalid_json', message: 'invalid JSON' },

  // Non-object, non-null JSON roots: `d['instance']` is a SAFE property
  // access on any primitive/array other than null/undefined (auto-boxing),
  // so these fall through to instance_required rather than crashing —
  // contrast with the null case above.
  { name: 'array body (safe undefined instance access)', body: '[]', stage: 'instance_required', message: 'instance is required' },
  { name: 'number body (safe undefined instance access)', body: '42', stage: 'instance_required', message: 'instance is required' },
  { name: 'string body (safe undefined instance access)', body: '"hello"', stage: 'instance_required', message: 'instance is required' },
  { name: 'boolean-true body (safe undefined instance access)', body: 'true', stage: 'instance_required', message: 'instance is required' },
  { name: 'boolean-false body (safe undefined instance access)', body: 'false', stage: 'instance_required', message: 'instance is required' },

  { name: 'missing instance', body: JSON.stringify({ duration_minutes: 15 }), stage: 'instance_required', message: 'instance is required' },
  { name: 'empty instance', body: JSON.stringify({ instance: '', duration_minutes: 15 }), stage: 'instance_required', message: 'instance is required' },
  { name: 'instance: null', body: JSON.stringify({ instance: null, duration_minutes: 15 }), stage: 'instance_required', message: 'instance is required' },
  { name: 'instance: number', body: JSON.stringify({ instance: 123, duration_minutes: 15 }), stage: 'instance_required', message: 'instance is required' },
  { name: 'instance: boolean', body: JSON.stringify({ instance: true, duration_minutes: 15 }), stage: 'instance_required', message: 'instance is required' },
  { name: 'instance: array', body: JSON.stringify({ instance: [], duration_minutes: 15 }), stage: 'instance_required', message: 'instance is required' },
  { name: 'instance: object', body: JSON.stringify({ instance: {}, duration_minutes: 15 }), stage: 'instance_required', message: 'instance is required' },

  { name: 'missing duration_minutes', body: JSON.stringify({ instance: 'q' }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: string', body: JSON.stringify({ instance: 'q', duration_minutes: '15' }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: numeric-looking string', body: JSON.stringify({ instance: 'q', duration_minutes: '0' }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: zero', body: JSON.stringify({ instance: 'q', duration_minutes: 0 }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: negative', body: JSON.stringify({ instance: 'q', duration_minutes: -30 }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: null', body: JSON.stringify({ instance: 'q', duration_minutes: null }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: boolean', body: JSON.stringify({ instance: 'q', duration_minutes: true }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: array', body: JSON.stringify({ instance: 'q', duration_minutes: [15] }), stage: 'duration_invalid', message: DURATION_ERROR },

  // #2292 L11: `1e999` is a VALID JSON number literal that parses to
  // Infinity; typeof is 'number' and `Infinity <= 0` is false, so it passed
  // the old guard and reached addSilence, where toISOString() threw. The
  // upper bound (not Number.isFinite) is what rejects it here.
  { name: 'duration_minutes: overflowing literal (parses to Infinity)', body: '{"instance":"q","duration_minutes":1e999}', stage: 'duration_invalid', message: DURATION_ERROR },
  // Finite, yet past the ECMA-262 maximum time value — Number.isFinite
  // alone would NOT catch this; only the explicit MAX_SILENCE_MINUTES bound does.
  { name: 'duration_minutes: finite but overflows Date', body: JSON.stringify({ instance: 'q', duration_minutes: 1e308 }), stage: 'duration_invalid', message: DURATION_ERROR },
  { name: 'duration_minutes: one past the cap', body: JSON.stringify({ instance: 'q', duration_minutes: MAX_SILENCE_MINUTES + 1 }), stage: 'duration_invalid', message: DURATION_ERROR },

  // ── Multi-field-simultaneously-invalid: precedence must match the
  // ladder's short-circuit order (instance checked BEFORE duration_minutes)
  // — the exact class of drift zod's default cross-field issue collection
  // could silently introduce (PILOT ADDENDUM point 1).
  {
    name: 'multi-field-invalid: empty instance AND negative duration simultaneously — instance message must win',
    body: JSON.stringify({ instance: '', duration_minutes: -1 }),
    stage: 'instance_required',
    message: 'instance is required',
  },
  {
    name: 'multi-field-invalid: wrong-typed instance AND wrong-typed duration simultaneously — instance message must win',
    body: JSON.stringify({ instance: 123, duration_minutes: 'nope' }),
    stage: 'instance_required',
    message: 'instance is required',
  },
  {
    name: 'multi-field-invalid: missing instance AND overflowing duration simultaneously — instance message must win',
    body: JSON.stringify({ duration_minutes: 1e999 }),
    stage: 'instance_required',
    message: 'instance is required',
  },
];

describe('silence shape-guard equivalence: reject branches', () => {
  for (const c of rejectCases) {
    it(`${c.name} → ${c.stage} (reference), '${c.message}' (live)`, async () => {
      expect(referenceAddSilenceShapeGuard(c.body)).toEqual({ stage: c.stage });

      const { handleAddSilence } = await importRoutes();
      const res = mockRes();
      await handleAddSilence(mockReq({ method: 'POST', url: '/api/fleet/silence', body: c.body }), res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body)).toEqual({ error: c.message });
    });
  }
});

// ─── Shape-accepting cases: reference agrees, live reaches 200 ────────────

interface AcceptCase {
  name: string;
  instance: string;
  duration_minutes: number;
  extra?: Record<string, unknown>;
  expectReason?: string;
}

const acceptCases: AcceptCase[] = [
  { name: 'typical values', instance: 'q', duration_minutes: 15 },
  { name: 'exactly at the cap — the accept side of the boundary rejection tests above', instance: 'q', duration_minutes: MAX_SILENCE_MINUTES },
  { name: 'smallest positive fractional duration', instance: 'q', duration_minutes: 0.5 },
  {
    name: 'valid instance/duration with a simultaneously wrong-typed reason — reason is non-rejecting, falls back to default',
    instance: 'q',
    duration_minutes: 15,
    extra: { reason: 42 },
    expectReason: 'manual silence',
  },
  {
    name: 'valid instance/duration with a valid reason string',
    instance: 'q',
    duration_minutes: 15,
    extra: { reason: 'planned maintenance' },
    expectReason: 'planned maintenance',
  },
];

describe('silence shape-guard equivalence: accept branches', () => {
  for (const c of acceptCases) {
    it(`${c.name} → shape accepted (reference), 200 (live)`, async () => {
      const body = JSON.stringify({ instance: c.instance, duration_minutes: c.duration_minutes, ...c.extra });

      expect(referenceAddSilenceShapeGuard(body)).toEqual({
        stage: 'ok',
        instance: c.instance,
        duration_minutes: c.duration_minutes,
      });

      const { handleAddSilence } = await importRoutes();
      const res = mockRes();
      await handleAddSilence(mockReq({ method: 'POST', url: '/api/fleet/silence', body }), res);

      expect(res._status).toBe(200);
      const parsed = JSON.parse(res._body);
      expect(parsed.ok).toBe(true);
      expect(parsed.rule.instance).toBe(c.instance);
      if (c.expectReason !== undefined) {
        expect(parsed.rule.reason).toBe(c.expectReason);
      }
    });
  }
});
