/**
 * WS-ALERT slice — provider re-auth signal on the /health body.
 *
 * ALERT-07: the /health body exposes a deterministic top-level `reauth_required`
 *           boolean derived from the existing turn_capability enums.
 * ALERT-01/02: redacted mini10-like health fixtures (credential-unavailable and
 *           its recovered counterpart) exist, are secret-free, and the recovery
 *           body is timestamped strictly after the incident.
 *
 * Self-contained health-endpoint test file (mirrors tests/core/health-mark-read.test.ts)
 * so it stays off the tests/core/health.test.ts file-size ratchet.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock config and logger
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    agentProvider: 'claude-cli',
    healthPort: 9997, // won't actually be used (tests override)
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import type { HealthDeps } from '../../src/core/health.ts';
import { makeDb, makeDeps, makeAgentRuntime, getHealth } from './_helpers/health-server.ts';

const INCIDENT_TS = 1_782_349_000_000;
const RECOVERY_TS = 1_782_435_400_000;

/** camelCase turnCapability with per-case overrides on a usable baseline. */
function turnCapability(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    modelUsable: true,
    modelUsableStale: false,
    modelUsableCheckedAt: INCIDENT_TS,
    modelUsabilityStatus: 'usable',
    lastSuccessfulTurnAt: INCIDENT_TS,
    lastTurnErrorClass: null,
    lastTurnErrorAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ALERT-07 — reauth_required derivation on the /health body
// ---------------------------------------------------------------------------

describe('GET /health — reauth_required derivation (ALERT-07)', () => {
  it('is TRUE when model_usability_status is credential-unavailable (status trigger)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsable: false,
        modelUsabilityStatus: 'credential-unavailable',
        lastSuccessfulTurnAt: null,
        lastTurnErrorClass: null,
      }));
      const { status, json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(status).toBe(200);
      // Non-vacuous: reauth_required is derived from the real turn_capability block.
      expect(json.turn_capability.model_usability_status).toBe('credential-unavailable');
      expect(json.reauth_required).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is TRUE when last_turn_error_class is auth-required, independent of status (class trigger)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsable: false,
        modelUsabilityStatus: 'unknown', // not credential-unavailable — isolates the class trigger
        lastSuccessfulTurnAt: null,
        lastTurnErrorClass: 'auth-required',
        lastTurnErrorAt: INCIDENT_TS,
      }));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.turn_capability.last_turn_error_class).toBe('auth-required');
      expect(json.reauth_required).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is FALSE when the primary is usable', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({}));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.turn_capability.model_usability_status).toBe('usable');
      expect(json.reauth_required).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is FALSE for non-auth degradation (model-unavailable must not page reauth)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsable: false,
        modelUsabilityStatus: 'model-unavailable',
        lastSuccessfulTurnAt: null,
        lastTurnErrorClass: 'model-unavailable',
        lastTurnErrorAt: INCIDENT_TS,
      }));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.reauth_required).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is FALSE for an inconclusive probe (unknown status, no error class)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsable: null,
        modelUsabilityStatus: 'unknown',
        lastSuccessfulTurnAt: null,
        lastTurnErrorClass: null,
      }));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.reauth_required).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is FALSE when turn_capability is null — a chat instance (no probe to page on)', async () => {
    const db = makeDb();
    try {
      const { json } = await getHealth(makeDeps(db)); // default instanceType 'chat'
      expect(json.turn_capability).toBeNull();
      expect(json.reauth_required).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is FALSE when an agent runtime exposes no turn_capability details (null, not a page)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(null);
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.turn_capability).toBeNull();
      expect(json.reauth_required).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is always present and boolean (deterministic signal, never undefined)', async () => {
    const db = makeDb();
    try {
      const { json } = await getHealth(makeDeps(db));
      expect(typeof json.reauth_required).toBe('boolean');
    } finally {
      db.close();
    }
  });

  it('recovery window: usable probe FRESHER than a lingering auth-required class → FALSE (idle-bot unlatch)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsable: true,
        modelUsabilityStatus: 'usable',
        modelUsableCheckedAt: INCIDENT_TS + 86_400_000, // probe AFTER the error
        lastSuccessfulTurnAt: null,                     // idle: no user turn since
        lastTurnErrorClass: 'auth-required',
        lastTurnErrorAt: INCIDENT_TS,
      }));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.turn_capability.last_turn_error_class).toBe('auth-required');
      expect(json.reauth_required).toBe(false);
    } finally { db.close(); }
  });

  it('stale usable probe OLDER than a new auth-required error → TRUE', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsable: true,
        modelUsabilityStatus: 'usable',
        modelUsableCheckedAt: INCIDENT_TS - 86_400_000, // probe BEFORE the error
        lastTurnErrorClass: 'auth-required',
        lastTurnErrorAt: INCIDENT_TS,
      }));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.reauth_required).toBe(true);
    } finally { db.close(); }
  });

  it('auth-required with missing timestamps cannot prove supersession → TRUE (conservative)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsable: true,
        modelUsabilityStatus: 'usable',
        modelUsableCheckedAt: null,
        lastTurnErrorClass: 'auth-required',
        lastTurnErrorAt: INCIDENT_TS,
      }));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.reauth_required).toBe(true);
    } finally { db.close(); }
  });

  // Finding 4: lock ALL never-page statuses and ALL non-auth error classes.
  for (const status of ['model-unavailable', 'provider-unavailable', 'timeout', 'unknown'] as const) {
    it(`never-page status '${status}' → FALSE`, async () => {
      const db = makeDb();
      try {
        const runtime = makeAgentRuntime(turnCapability({
          modelUsable: false, modelUsabilityStatus: status,
          lastSuccessfulTurnAt: null, lastTurnErrorClass: null,
        }));
        const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
        expect(json.reauth_required).toBe(false);
      } finally { db.close(); }
    });
  }
  for (const cls of ['usage-limit', 'rate-limit', 'model-unavailable', 'policy-block', 'context-overflow', 'unknown-terminal', 'empty-output'] as const) {
    it(`non-auth error class '${cls}' → FALSE`, async () => {
      const db = makeDb();
      try {
        const runtime = makeAgentRuntime(turnCapability({
          modelUsabilityStatus: 'unknown', lastTurnErrorClass: cls, lastTurnErrorAt: INCIDENT_TS,
        }));
        const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
        expect(json.reauth_required).toBe(false);
      } finally { db.close(); }
    });
  }

  it('out-of-enum values normalize to null and → FALSE (normalizer interaction)', async () => {
    const db = makeDb();
    try {
      const runtime = makeAgentRuntime(turnCapability({
        modelUsabilityStatus: 'credential-unavailable-EXTREME', // not in enum → null
        lastTurnErrorClass: 'auth-required-ish',                // not in enum → null
      }));
      const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
      expect(json.turn_capability.model_usability_status).toBeNull();
      expect(json.turn_capability.last_turn_error_class).toBeNull();
      expect(json.reauth_required).toBe(false);
    } finally { db.close(); }
  });
});

// ---------------------------------------------------------------------------
// ALERT-01/02 — redacted provider-reauth health fixtures
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): { raw: string; json: Record<string, any> } {
  const raw = readFileSync(path.join(HERE, '..', 'fixtures', 'health', name), 'utf8');
  return { raw, json: JSON.parse(raw) };
}

// Secret shapes that must never appear in a committed health fixture.
const SECRET_SHAPES: [RegExp, string][] = [
  [/sk-[A-Za-z0-9]{8,}/, 'api-key'],
  [/\bBearer\s+\S+/i, 'bearer-token'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'jwt'],
  [/\b\d{11,}@s\.whatsapp\.net/, 'real-phone-jid'],
  [/"?(access|refresh|session|oauth)[-_]?token"?\s*[:=]/i, 'token-field'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private-key'],
];

/** snake_case fixture turn_capability → camelCase runtime shape. */
function toRuntimeTc(tc: Record<string, any>): Record<string, unknown> {
  return {
    modelUsable: tc.model_usable,
    modelUsableStale: tc.model_usable_stale,
    modelUsableCheckedAt: tc.model_usable_checked_at,
    modelUsabilityStatus: tc.model_usability_status,
    lastSuccessfulTurnAt: tc.last_successful_turn_at,
    lastTurnErrorClass: tc.last_turn_error_class,
    lastTurnErrorAt: tc.last_turn_error_at,
  };
}

async function liveBodyFor(tc: Record<string, unknown>): Promise<Record<string, any>> {
  const db = makeDb();
  try {
    const runtime = makeAgentRuntime(tc);
    const { json } = await getHealth(makeDeps(db, { instanceType: 'agent', runtime: runtime as unknown as HealthDeps['runtime'] }));
    return json;
  } finally { db.close(); }
}

describe('provider-reauth health fixtures (ALERT-01/02)', () => {
  for (const name of ['provider-reauth-required.json', 'provider-reauth-recovered.json']) {
    it(`${name} is serializer-faithful: status, turn_capability, and reauth_required match the REAL /health body`, async () => {
      const { json: fixture } = readFixture(name);
      const live = await liveBodyFor(toRuntimeTc(fixture.turn_capability));
      // The three load-bearing surfaces a poller classifier keys on (review finding 2:
      // a fixture body the serializer cannot emit mistrains the classifier it exists to serve).
      expect(fixture.status).toBe(live.status);
      expect(fixture.turn_capability).toEqual(live.turn_capability);
      expect(fixture.reauth_required).toBe(live.reauth_required);
      // Key-set fidelity derived from the LIVE body, not a hand-copied list (finding 12).
      expect(Object.keys(fixture.turn_capability).sort()).toEqual(Object.keys(live.turn_capability).sort());
    });
  }

  it('recovered fixture is the recovery-window body: usable probe, LINGERING auth-required class, ordered timestamps', () => {
    const { json } = readFixture('provider-reauth-recovered.json');
    expect(json.turn_capability.model_usability_status).toBe('usable');
    expect(json.turn_capability.model_usable).toBe(true);
    // Finding 5: the error fields are load-bearing — assert their values explicitly.
    expect(json.turn_capability.last_turn_error_class).toBe('auth-required');
    expect(json.turn_capability.last_turn_error_at).toBe(INCIDENT_TS);
    expect(json.turn_capability.model_usable_checked_at).toBe(RECOVERY_TS); // RECOVERY_TS now used (finding 13)
    expect(json.turn_capability.last_successful_turn_at).toBeNull(); // idle bot — no user turn since
    expect(RECOVERY_TS).toBeGreaterThan(INCIDENT_TS);
    expect(json.reauth_required).toBe(false);
  });

  it('required fixture carries the incident signature: connected WhatsApp, dead credential, degraded status', () => {
    const { json } = readFixture('provider-reauth-required.json');
    expect(json.status).toBe('degraded'); // serializer-forced; 'healthy' is unrepresentable (finding 2)
    expect(json.whatsapp.connected).toBe(true);
    expect(json.turn_capability.model_usability_status).toBe('credential-unavailable');
    expect(json.turn_capability.last_turn_error_at).toBe(INCIDENT_TS);
    expect(json.reauth_required).toBe(true);
  });

  it('both fixtures are free of secret-shaped values (redaction scan)', () => {
    for (const name of ['provider-reauth-required.json', 'provider-reauth-recovered.json']) {
      const { raw } = readFixture(name);
      for (const [shape, label] of SECRET_SHAPES) {
        expect(shape.test(raw), `${name} must not contain ${label}`).toBe(false);
      }
    }
  });
});
