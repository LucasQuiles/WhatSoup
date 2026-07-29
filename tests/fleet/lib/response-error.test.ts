/**
 * Exact-byte canary tests for the fleet response-error projection
 * (issue #2517, initial schema introduction).
 *
 * These tests prove the projection is closed: raw exception prose, stack,
 * cause, command, stderr, filesystem paths, environment, and arbitrary
 * fields never reach the published response shape. The tests inject
 * synthetic markers into every plausible leakage channel and assert their
 * absence from the serialized JSON.
 *
 * The markers are deliberately distinctive (so a half-leak is obvious in a
 * diff) and never reused across tests (so a false negative from marker
 * collision is impossible).
 */

import { describe, expect, it } from 'vitest';

import {
  FLEET_OPERATIONS,
  FLEET_RESPONSE_CODES,
  FLEET_STAGES,
  MUTATION_STATES,
  classifyErrno,
  classifyFleetError,
  newCorrelationId,
  projectFleetError,
  projectReadError,
  registeredClientSafeMessage,
  retryHintFor,
} from '../../../src/fleet/lib/response-error.ts';

// ─────────────────────────────────────────────────────────────────────────
// Closure of the response schema.
// ─────────────────────────────────────────────────────────────────────────

describe('FLEET_RESPONSE_CODES is closed and exhaustive', () => {
  it('contains the contract-required codes', () => {
    // Issue #2517 § "Required contract" names these classes explicitly.
    expect(FLEET_RESPONSE_CODES).toContain('source_unavailable');
    expect(FLEET_RESPONSE_CODES).toContain('permission_denied');
    expect(FLEET_RESPONSE_CODES).toContain('storage_full');
    expect(FLEET_RESPONSE_CODES).toContain('service_action_failed');
    expect(FLEET_RESPONSE_CODES).toContain('rollback_failed');
    expect(FLEET_RESPONSE_CODES).toContain('internal_error');
  });

  it('does not contain free-form placeholder codes', () => {
    for (const code of FLEET_RESPONSE_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(code).not.toContain(' ');
      expect(code).not.toContain('TODO');
      expect(code).not.toContain('FIXME');
    }
  });
});

describe('FLEET_OPERATIONS and FLEET_STAGES are closed', () => {
  it('operations cover the documented fleet routes', () => {
    // Issue #2517 § "Current source proof" lists the affected route families.
    expect(FLEET_OPERATIONS).toContain('restart');
    expect(FLEET_OPERATIONS).toContain('stop');
    expect(FLEET_OPERATIONS).toContain('delete');
    expect(FLEET_OPERATIONS).toContain('create');
    expect(FLEET_OPERATIONS).toContain('config.read');
    expect(FLEET_OPERATIONS).toContain('config.write');
    expect(FLEET_OPERATIONS).toContain('checkpoint.restore');
    expect(FLEET_OPERATIONS).toContain('log.scan');
    expect(FLEET_OPERATIONS).toContain('checkpoint.write');
  });

  it('every operation/stage literal matches the bounded pattern', () => {
    for (const op of FLEET_OPERATIONS) {
      expect(op).toMatch(/^[a-z][a-z0-9._-]*$/);
    }
    for (const stage of FLEET_STAGES) {
      expect(stage).toMatch(/^[a-z][a-z0-9._-]*$/);
    }
  });
});

describe('MUTATION_STATES matches the contract', () => {
  it('contains the five required states', () => {
    expect(MUTATION_STATES).toEqual(
      expect.arrayContaining([
        'not_started',
        'applied',
        'rolled_back',
        'rollback_failed',
        'unknown',
      ]),
    );
    expect(MUTATION_STATES).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Negative canaries: synthetic markers must NOT reach the response.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Serialize a projection and assert that none of the given markers appear
 * anywhere in the resulting JSON string. This is the exact-byte negative
 * proof: a single byte of any marker reaching the response fails the test.
 */
function expectMarkersAbsent(projected: unknown, markers: string[]): void {
  const json = JSON.stringify(projected);
  for (const marker of markers) {
    expect(json, `marker ${marker!} must not appear in serialized response`).not.toContain(marker);
  }
}

describe('projectFleetError rejects raw exception prose', () => {
  it('discards Error.message, .stack, .cause, and .name', () => {
    const cause = new Error('inner cause marker CAUSE-9f3a');
    const err = new Error('outer message marker MSG-1a2b', { cause });
    err.name = 'CustomError marker NAME-7c4d';
    err.stack = 'Error: outer marker STACK-5e6f\n    at foo (bar.ts:1:1)';

    const projected = projectFleetError(err, {
      operation: 'restart',
      stage: 'execute',
    });

    expectMarkersAbsent(projected, [
      'CAUSE-9f3a',
      'MSG-1a2b',
      'NAME-7c4d',
      'STACK-5e6f',
      'outer message',
      'inner cause',
      'CustomError',
    ]);
    expect(projected.code).toBe('internal_error');
  });

  it('discards non-Error throw values (string, object, number)', () => {
    const stringThrow = 'raw throw string marker THROWSTR-8a9b';
    const objectThrow = { detail: 'object throw marker THROWOBJ-2c3d', code: 42 };
    const numberThrow = 40420;

    for (const v of [stringThrow, objectThrow, numberThrow]) {
      const projected = projectFleetError(v, { operation: 'unknown', stage: 'unknown' });
      expectMarkersAbsent(projected, ['THROWSTR-8a9b', 'THROWOBJ-2c3d']);
      expect(projected.code).toBe('internal_error');
    }
  });

  it('discards filesystem paths, commands, and stderr fragments', () => {
    const err = Object.assign(new Error('marker PATH-9e8f'), {
      path: '/etc/secrets/marker PATH-9e8f/credentials.json',
      syscall: 'open',
      command: 'systemctl marker CMD-1b2c restart whatsoup@prod',
      stderr: 'marker STDERR-3d4e permission denied\ntraceback marker TB-5f6a',
    });

    const projected = projectFleetError(err, { operation: 'config.read', stage: 'read' });

    expectMarkersAbsent(projected, [
      'PATH-9e8f',
      'CMD-1b2c',
      'STDERR-3d4e',
      'TB-5f6a',
      '/etc/secrets',
      'systemctl',
      'permission denied',
      'credentials.json',
    ]);
  });

  it('discards environment and arbitrary fields', () => {
    const err = Object.assign(new Error('marker BASE-7g8h'), {
      env: { DATABASE_URL: 'postgres://marker ENV-9i0j:p@host' },
      arbitraryField: 'marker ARB-1k2l should not leak',
      nestedArray: [{ command: 'rm -rf marker ARR-3m4n' }],
    });

    const projected = projectFleetError(err, { operation: 'unknown', stage: 'unknown' });

    expectMarkersAbsent(projected, [
      'ENV-9i0j',
      'ARB-1k2l',
      'ARR-3m4n',
      'DATABASE_URL',
      'rm -rf',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Classifier correctness.
// ─────────────────────────────────────────────────────────────────────────

describe('classifyFleetError maps errno to bounded codes', () => {
  const cases: Array<[unknown, string]> = [
    [{ errno: 'ENOENT' }, 'source_unavailable'],
    [{ errno: 'ENOTDIR' }, 'source_unavailable'],
    [{ errno: 'ECONNREFUSED' }, 'source_unavailable'],
    [{ errno: 'ETIMEDOUT' }, 'source_unavailable'],
    [{ errno: 'EACCES' }, 'permission_denied'],
    [{ errno: 'EPERM' }, 'permission_denied'],
    [{ errno: 'ENOSPC' }, 'storage_full'],
    [{ errno: 'EDQUOT' }, 'storage_full'],
    [{ errno: 'EFBIG' }, 'storage_full'],
    [{ errno: 'UNKNOWN_ERRNO' }, 'internal_error'],
    [{ code: 'ENOENT' }, 'source_unavailable'],
    [{ code: 'EACCES' }, 'permission_denied'],
    [{ code: 'UNKNOWN_CODE' }, 'internal_error'],
    ['raw string', 'internal_error'],
    [42, 'internal_error'],
    [null, 'internal_error'],
    [undefined, 'internal_error'],
  ];

  for (const [input, expected] of cases) {
    it(`classifies ${JSON.stringify(input)} → ${expected}`, () => {
      expect(classifyFleetError(input)).toBe(expected);
    });
  }
});

describe('classifyErrno is the SSOT for errno → code', () => {
  it('returns null for non-errno strings', () => {
    expect(classifyErrno(undefined)).toBeNull();
    expect(classifyErrno(42)).toBeNull();
    expect(classifyErrno('UNKNOWN')).toBeNull();
  });

  it('maps each errno exactly once', () => {
    expect(classifyErrno('ENOENT')).toBe('source_unavailable');
    expect(classifyErrno('EACCES')).toBe('permission_denied');
    expect(classifyErrno('ENOSPC')).toBe('storage_full');
  });
});

describe('classifyFleetError honors fleetErrorClass hint', () => {
  it('maps explicit fleetErrorClass to a registered code', () => {
    expect(classifyFleetError({ fleetErrorClass: 'rollback_failed' })).toBe('rollback_failed');
    expect(classifyFleetError({ fleetErrorClass: 'service_action_failed' })).toBe('service_action_failed');
  });

  it('rejects unknown fleetErrorClass strings', () => {
    expect(classifyFleetError({ fleetErrorClass: 'free_form_code' })).toBe('internal_error');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Retry hint derivation.
// ─────────────────────────────────────────────────────────────────────────

describe('retryHintFor is exhaustive and bounded', () => {
  const expected: Record<string, 'yes' | 'no' | 'unknown'> = {
    invalid_request: 'no',
    source_unavailable: 'yes',
    permission_denied: 'no',
    storage_full: 'unknown',
    service_action_failed: 'unknown',
    rollback_failed: 'unknown',
    restore_failed: 'unknown',
    credential_store_unavailable: 'unknown',
    transport_unavailable: 'yes',
    log_source_unavailable: 'yes',
    internal_error: 'unknown',
  };

  it('returns a bounded hint for every registered code', () => {
    for (const code of FLEET_RESPONSE_CODES) {
      const hint = retryHintFor(code);
      expect(hint, `code ${code!}`).toBe(expected[code]!);
      expect(['yes', 'no', 'unknown']).toContain(hint);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Registered client-safe message contract.
// ─────────────────────────────────────────────────────────────────────────

describe('registeredClientSafeMessage is the only path to .message', () => {
  it('produces a marker-carrying object', () => {
    const safe = registeredClientSafeMessage('instance restart requested');
    expect(safe.text).toBe('instance restart requested');
    // The marker is not enumerable from outside, but the projection honors it.
    const projected = projectFleetError(new Error('leak marker LEAK-1a2b'), {
      operation: 'restart',
      stage: 'preflight',
      safeMessage: safe,
    });
    expect(projected.message).toBe('instance restart requested');
    expectMarkersAbsent(projected, ['leak marker', 'LEAK-1a2b']);
  });

  it('rejects arbitrary strings passed as safeMessage', () => {
    // The shape is intentionally incompatible: a raw string lacks the symbol.
    const projected = projectFleetError(new Error('marker MSG-3c4d'), {
      operation: 'restart',
      stage: 'preflight',
    // @ts-expect-error -- deliberately passing a raw string to prove the runtime guard rejects it. expires 2026-12-31
    safeMessage: 'raw attacker string marker ATTACK-5e6f',
    });
    expect(projected.message).toBeUndefined();
    expectMarkersAbsent(projected, ['ATTACK-5e6f', 'MSG-3c4d']);
  });

  it('does not interpolate Error.message even when safeMessage is set', () => {
    const err = new Error('raw marker RAW-7g8h should not concatenate');
    const safe = registeredClientSafeMessage('checkpoint restore requested');
    const projected = projectFleetError(err, {
      operation: 'checkpoint.restore',
      stage: 'preflight',
      safeMessage: safe,
    });
    expect(projected.message).toBe('checkpoint restore requested');
    expectMarkersAbsent(projected, ['RAW-7g8h', 'concatenate']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Correlation ID.
// ─────────────────────────────────────────────────────────────────────────

describe('newCorrelationId', () => {
  it('produces a UUID-shaped opaque string', () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is unique across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newCorrelationId());
    expect(ids.size).toBe(1000);
  });

  it('does not carry semantic information about the failure', () => {
    // The correlation ID is the only handle to internal diagnostics; it MUST
    // be opaque. Injecting semantic text would couple the public response
    // contract to internal state.
    for (let i = 0; i < 100; i++) {
      const id = newCorrelationId();
      expect(id).toMatch(/^[0-9a-f-]+$/);
      expect(id).not.toContain('error');
      expect(id).not.toContain('restart');
      expect(id).not.toContain('path');
    }
  });
});

describe('projectFleetError always sets a correlationId', () => {
  it('generates one when not supplied', () => {
    const projected = projectFleetError(new Error('x'), {
      operation: 'restart',
      stage: 'execute',
    });
    expect(projected.correlationId).toMatch(/^[0-9a-f-]+$/);
    expect(projected.correlationId.length).toBeGreaterThanOrEqual(32);
  });

  it('honors an externally-supplied correlationId', () => {
    const external = '11111111-2222-4333-8444-555555555555';
    const projected = projectFleetError(new Error('x'), {
      operation: 'restart',
      stage: 'execute',
      correlationId: external,
    });
    expect(projected.correlationId).toBe(external);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Mutation state truth.
// ─────────────────────────────────────────────────────────────────────────

describe('projectFleetError preserves mutation state truth', () => {
  it('defaults to unknown when not specified', () => {
    const projected = projectFleetError(new Error('x'), {
      operation: 'restart',
      stage: 'execute',
    });
    expect(projected.mutationState).toBe('unknown');
  });

  it('honors explicit mutation state from observed state, not exception text', () => {
    const cases = ['not_started', 'applied', 'rolled_back', 'rollback_failed', 'unknown'] as const;
    for (const m of cases) {
      const projected = projectFleetError(new Error('marker MUTEX-9i0j'), {
        operation: 'restart',
        stage: 'execute',
        mutationState: m,
      });
      expect(projected.mutationState).toBe(m);
      // Mutation state must come from observed state, never from exception text.
      expectMarkersAbsent(projected, ['MUTEX-9i0j']);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Operation / stage collapse.
// ─────────────────────────────────────────────────────────────────────────

describe('unknown operation/stage names collapse safely', () => {
  it('collapses a free-form operation to "unknown"', () => {
    const projected = projectFleetError(new Error('x'), {
      operation: 'arbitrary_op marker OP-1a2b',
      stage: 'execute',
    });
    expect(projected.operation).toBe('unknown');
    expectMarkersAbsent(projected, ['arbitrary_op', 'OP-1a2b']);
  });

  it('collapses a free-form stage to "unknown"', () => {
    const projected = projectFleetError(new Error('x'), {
      operation: 'restart',
      stage: 'arbitrary_stage marker STAGE-3c4d',
    });
    expect(projected.stage).toBe('unknown');
    expectMarkersAbsent(projected, ['arbitrary_stage', 'STAGE-3c4d']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// projectReadError convenience wrapper.
// ─────────────────────────────────────────────────────────────────────────

describe('projectReadError forces mutationState to unknown', () => {
  it('always produces mutationState=unknown regardless of err', () => {
    const projected = projectReadError(new Error('read marker READ-5e6f'), {
      operation: 'log.scan',
      stage: 'read',
    });
    expect(projected.mutationState).toBe('unknown');
    expect(projected.code).toBe('internal_error');
    expectMarkersAbsent(projected, ['read marker', 'READ-5e6f']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Serialization shape — exact wire contract.
// ─────────────────────────────────────────────────────────────────────────

describe('projected error serializes to the exact v1 wire shape', () => {
  it('has only the contract-defined top-level keys', () => {
    const projected = projectFleetError(new Error('x'), {
      operation: 'restart',
      stage: 'execute',
      safeMessage: registeredClientSafeMessage('restart requested'),
    });
    const keys = Object.keys(projected).sort();
    // schema, code, operation, stage, retryable, mutationState, correlationId, message
    expect(keys).toEqual([
      'code',
      'correlationId',
      'message',
      'mutationState',
      'operation',
      'retryable',
      'schema',
      'stage',
    ]);
  });

  it('omits message when no safeMessage is registered', () => {
    const projected = projectFleetError(new Error('x'), {
      operation: 'restart',
      stage: 'execute',
    });
    expect(Object.keys(projected)).not.toContain('message');
  });

  it('schema version is exactly "fleet-response-error/v1"', () => {
    const projected = projectFleetError(new Error('x'), {
      operation: 'restart',
      stage: 'execute',
    });
    expect(projected.schema).toBe('fleet-response-error/v1');
  });
});
