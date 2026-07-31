/**
 * Exact-byte canary tests for the fleet response error projection — #2517.
 *
 * These tests inject synthetic markers into Error messages, causes, paths,
 * commands, stderr, and non-Error throws, then prove the markers NEVER appear
 * in any projected response field, regardless of transport (JSON or SSE).
 *
 * The marker is a unique, non-sensitive sentinel string. If it leaks into any
 * field of the FleetErrorResponse, the test fails — proving the projection is
 * closed against raw exception content.
 */
import { describe, it, expect } from 'vitest';
import {
  projectError,
  silenceRegistryUnavailableError,
  validationError,
  mutationError,
  serviceActionError,
  classifyError,
  type FleetErrorResponse,
} from '../../../src/fleet/response-error-projection.ts';

const MARKER = 'CANARY_SECRET_MARKER_x9k2j7f3q1';

/** Assert that the marker does not appear anywhere in the response object. */
function assertNoMarker(response: FleetErrorResponse): void {
  const serialized = JSON.stringify(response);
  if (serialized.includes(MARKER)) {
    throw new Error(
      `MARKER LEAK: synthetic marker "${MARKER}" found in projected response: ${serialized}`,
    );
  }
}

describe('response-error-projection — exact-byte canaries', () => {
  it('rejects Error.message content', () => {
    const err = new Error(`${MARKER} sensitive internal diagnostic`);
    const projected = projectError(err, { operation: 'config_read' });
    assertNoMarker(projected);
    expect(projected.message).not.toContain(MARKER);
  });

  it('rejects non-Error throw content', () => {
    const err = `${MARKER} arbitrary string throw`;
    const projected = projectError(err, { operation: 'service_action' });
    assertNoMarker(projected);
  });

  it('rejects Error cause chain content', () => {
    const root = new Error(`${MARKER} root cause secret`);
    const err = new Error('wrapper', { cause: root });
    const projected = projectError(err, { operation: 'config_write' });
    assertNoMarker(projected);
  });

  it('rejects NodeJS.ErrnoException path property', () => {
    const err = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
      path: `/secret/${MARKER}/config.json`,
    });
    const projected = projectError(err, { operation: 'config_read' });
    assertNoMarker(projected);
    expect(projected.code).toBe('source_unavailable');
  });

  it('rejects NodeJS.ErrnoException syscall/command property', () => {
    const err = Object.assign(new Error('spawn failed'), {
      code: 'EACCES',
      syscall: 'spawn',
      cmd: `/usr/local/bin/${MARKER}`,
    });
    const projected = projectError(err, { operation: 'service_action' });
    assertNoMarker(projected);
    expect(projected.code).toBe('permission_denied');
  });

  it('rejects stderr fragments in message', () => {
    const err = new Error(`Command failed: stderr: ${MARKER} leaked output`);
    const projected = projectError(err, { operation: 'service_action' });
    assertNoMarker(projected);
  });

  it('rejects environment variable values in message', () => {
    const err = new Error(`Connection refused: host=${MARKER} port=5432`);
    const projected = projectError(err, { operation: 'credential_verify' });
    assertNoMarker(projected);
  });

  it('rejects stack trace content', () => {
    const err = new Error(`${MARKER} in stack`);
    err.stack = `Error: ${MARKER}\n    at /home/${MARKER}/secret.ts:42:7`;
    const projected = projectError(err, { operation: 'unknown' });
    assertNoMarker(projected);
  });

  it('rejects marker in non-Error object with code', () => {
    const err = { code: 'ENOENT', message: `${MARKER} leaked` };
    const projected = projectError(err, { operation: 'log_scan' });
    assertNoMarker(projected);
  });
});

describe('response-error-projection — classification correctness', () => {
  it('classifies ENOENT as source_unavailable', () => {
    const { code } = classifyError(Object.assign(new Error('x'), { code: 'ENOENT' }));
    expect(code).toBe('source_unavailable');
  });

  it('classifies EACCES as permission_denied', () => {
    const { code } = classifyError(Object.assign(new Error('x'), { code: 'EACCES' }));
    expect(code).toBe('permission_denied');
  });

  it('classifies ENOSPC as storage_full', () => {
    const { code } = classifyError(Object.assign(new Error('x'), { code: 'ENOSPC' }));
    expect(code).toBe('storage_full');
  });

  it('classifies ECONNREFUSED as service_action_failed (retryable)', () => {
    const result = classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect(result.code).toBe('service_action_failed');
    expect(result.retryable).toBe(true);
  });

  it('classifies AbortError as service_action_failed (retryable)', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = classifyError(err);
    expect(result.code).toBe('service_action_failed');
    expect(result.retryable).toBe(true);
  });

  it('classifies unknown errors as internal_error (not retryable)', () => {
    const result = classifyError(new Error('something'));
    expect(result.code).toBe('internal_error');
    expect(result.retryable).toBe(false);
  });
});

describe('response-error-projection — schema completeness', () => {
  it('every projectError response has all required fields', () => {
    const projected = projectError(new Error('test'), { operation: 'config_read' });
    expect(projected.schema).toBe('fleet-error-v1');
    expect(typeof projected.code).toBe('string');
    expect(typeof projected.operation).toBe('string');
    expect(typeof projected.stage).toBe('string');
    expect(typeof projected.message).toBe('string');
    expect(typeof projected.retryable).toBe('boolean');
    expect(typeof projected.mutation_state).toBe('string');
    expect(typeof projected.rollback_state).toBe('string');
    expect(typeof projected.correlation_id).toBe('string');
    expect(projected.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('validationError produces correct shape', () => {
    const projected = validationError('invalid_json', 'silence');
    expect(projected.code).toBe('validation_failed');
    expect(projected.message).toBe('Invalid JSON body.');
    expect(projected.retryable).toBe(false);
    expect(projected.mutation_state).toBe('not_started');
  });

  it('mutationError preserves mutation and rollback state', () => {
    const projected = mutationError(new Error('fail'), {
      operation: 'instance_create',
      mutationState: 'rollback_failed',
      rollbackState: 'failed',
    });
    expect(projected.mutation_state).toBe('rollback_failed');
    expect(projected.rollback_state).toBe('failed');
  });

  it('serviceActionError uses the override code', () => {
    const projected = serviceActionError(new Error('x'), 'service_action', 'restart_failed');
    expect(projected.code).toBe('restart_failed');
  });

  it('projects a silence-registry precondition failure through the closed v1 schema', () => {
    const projected = silenceRegistryUnavailableError(true);
    expect(projected).toMatchObject({
      schema: 'fleet-error-v1',
      code: 'silence_registry_unavailable',
      operation: 'silence',
      stage: 'precondition',
      retryable: true,
      mutation_state: 'not_started',
      rollback_state: 'not_applicable',
    });
    assertNoMarker(projected);
  });

  it('every error code has a registered safe message', () => {
    const allCodes: FleetErrorResponse['code'][] = [
      'source_unavailable', 'permission_denied', 'storage_full',
      'service_action_failed', 'service_start_failed', 'service_stop_failed',
      'restart_failed', 'rollback_failed', 'config_read_failed',
      'config_write_failed', 'instance_creation_failed', 'auth_failed',
      'auth_timeout', 'validation_failed', 'internal_error',
      'embed_service_unavailable', 'log_scan_failed', 'silence_registry_unavailable',
    ];
    for (const code of allCodes) {
      const projected = serviceActionError(new Error('test'), 'unknown', code);
      expect(projected.message.length).toBeGreaterThan(0);
      expect(projected.message).not.toContain('undefined');
    }
  });
});
