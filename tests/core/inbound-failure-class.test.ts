import { describe, it, expect } from 'vitest';
import {
  ADMISSION_REJECT_CLASSES,
  INBOUND_FAILURE_CLASSES,
  admissionRejectInboundFailureClass,
  coerceInboundFailureClass,
  classifyErrorForInbound,
} from '../../src/core/inbound-failure-class.ts';

describe('inbound-failure-class — vocabulary', () => {
  it('exposes exactly the bounded classes (incl. #1750 admission subclasses + #1749 recovery reclaim)', () => {
    expect([...INBOUND_FAILURE_CLASSES].sort()).toEqual(
      [
        'crash_recovery',
        'db_error',
        'provider_failure',
        'recovery_owner_reclaimed',
        'session_crash',
        'session_spawn_failed',
        'stale_reclaim',
        'timeout',
        'transport_disconnected',
        'transport_send_failed',
        // #1750 admission-rejection subclasses
        'queue_full',
        'queue_halted',
        'queue_closed',
        'pre_dispatch_error',
        'scope_blocked_recovery',
        // Turn-processor exception, split out of 'unknown' so reply-guarantee
        // breaches are mineable by driver.
        'processor_throw',
        'unknown',
      ].sort(),
    );
  });

  it('every admission-rejection subclass is a member of the durable vocabulary', () => {
    // Guards the coerce gate: any AdmissionRejectClass not admitted into
    // INBOUND_FAILURE_CLASSES would be silently collapsed to 'unknown' at write.
    for (const cls of ADMISSION_REJECT_CLASSES) {
      expect(INBOUND_FAILURE_CLASSES.has(cls)).toBe(true);
    }
  });
});

describe('inbound-failure-class — admissionRejectInboundFailureClass (#1750)', () => {
  it('maps each admission subclass to its same-named distinct failure class', () => {
    expect(admissionRejectInboundFailureClass('queue_full')).toBe('queue_full');
    expect(admissionRejectInboundFailureClass('queue_halted')).toBe('queue_halted');
    expect(admissionRejectInboundFailureClass('queue_closed')).toBe('queue_closed');
    expect(admissionRejectInboundFailureClass('pre_dispatch_error')).toBe('pre_dispatch_error');
    expect(admissionRejectInboundFailureClass('scope_blocked_recovery')).toBe('scope_blocked_recovery');
  });

  it('maps a legacy (null/undefined) admission class to unknown', () => {
    expect(admissionRejectInboundFailureClass(null)).toBe('unknown');
    expect(admissionRejectInboundFailureClass(undefined)).toBe('unknown');
  });

  it('rejects an out-of-vocabulary admission class rather than silently coercing', () => {
    expect(() => admissionRejectInboundFailureClass('disk_on_fire')).toThrow(/invalid rejection class/);
  });
});

describe('inbound-failure-class — coerceInboundFailureClass', () => {
  it('passes through an in-vocabulary value', () => {
    expect(coerceInboundFailureClass('db_error')).toBe('db_error');
    expect(coerceInboundFailureClass('provider_failure')).toBe('provider_failure');
    expect(coerceInboundFailureClass('crash_recovery')).toBe('crash_recovery');
  });

  it('coerces undefined to unknown', () => {
    expect(coerceInboundFailureClass(undefined)).toBe('unknown');
  });

  it('coerces an out-of-vocabulary string to unknown', () => {
    expect(coerceInboundFailureClass('disk_on_fire')).toBe('unknown');
    expect(coerceInboundFailureClass('')).toBe('unknown');
    expect(coerceInboundFailureClass('ERROR')).toBe('unknown');
  });
});

describe('inbound-failure-class — classifyErrorForInbound', () => {
  it('classifies SQLITE_* on .code as db_error', () => {
    const err = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    expect(classifyErrorForInbound(err)).toBe('db_error');
  });

  it('classifies SQLITE_FULL on .code as db_error', () => {
    const err = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    expect(classifyErrorForInbound(err)).toBe('db_error');
  });

  it('classifies a message-embedded SQLITE_CORRUPT as db_error', () => {
    expect(classifyErrorForInbound(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe('db_error');
  });

  it('classifies each unrecoverable SQLITE code family as db_error', () => {
    for (const code of ['SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_CORRUPT', 'SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_NOTADB']) {
      expect(classifyErrorForInbound(Object.assign(new Error('x'), { code })), code).toBe('db_error');
    }
  });

  it('classifies ETIMEDOUT as timeout', () => {
    expect(classifyErrorForInbound(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe('timeout');
  });

  it('classifies an AbortError (by name) as timeout', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(classifyErrorForInbound(err)).toBe('timeout');
  });

  it('classifies ECONNRESET as transport_disconnected', () => {
    expect(classifyErrorForInbound(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe('transport_disconnected');
  });

  it('classifies a "socket hang up" message as transport_disconnected', () => {
    expect(classifyErrorForInbound(new Error('socket hang up'))).toBe('transport_disconnected');
  });

  it('classifies EPIPE and ENOTCONN as transport_disconnected', () => {
    expect(classifyErrorForInbound(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe('transport_disconnected');
    expect(classifyErrorForInbound(Object.assign(new Error('ENOTCONN'), { code: 'ENOTCONN' }))).toBe('transport_disconnected');
  });

  it('classifies a plain Error as unknown', () => {
    expect(classifyErrorForInbound(new Error('something odd happened'))).toBe('unknown');
  });

  it('classifies a bare string throw as unknown', () => {
    expect(classifyErrorForInbound('boom')).toBe('unknown');
  });

  it('classifies undefined as unknown', () => {
    expect(classifyErrorForInbound(undefined)).toBe('unknown');
  });

  it('never returns a value outside the bounded vocabulary', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      'boom',
      42,
      new Error('generic'),
      Object.assign(new Error('x'), { code: 'SQLITE_FULL' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    ];
    for (const input of inputs) {
      expect(INBOUND_FAILURE_CLASSES.has(classifyErrorForInbound(input))).toBe(true);
    }
  });
});
