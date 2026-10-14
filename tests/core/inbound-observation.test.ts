import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const doubles = vi.hoisted(() => ({
  emitAlert: vi.fn(),
  useRealEmitAlert: false,
}));

vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  const logger = singletonLoggerMock();
  return { createChildLogger: () => logger };
});

vi.mock('../../src/lib/emit-alert.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/emit-alert.ts')>();
  return {
    ...actual,
    emitAlert: (...args: Parameters<typeof actual.emitAlert>) => (
      doubles.useRealEmitAlert ? actual.emitAlert(...args) : doubles.emitAlert(...args)
    ),
  };
});

import { createChildLogger } from '../../src/logger.ts';
import type { SingletonLoggerMock } from '../helpers/logger-mock.ts';
import {
  INBOUND_OBSERVATION_ALERT_WINDOW_MS,
  INBOUND_OBSERVATION_REASONS,
  getInboundObservationHealth,
  observeInbound,
  resetInboundObservations,
} from '../../src/core/inbound-observation.ts';

const mockLog = createChildLogger('inbound-observation-test') as unknown as SingletonLoggerMock;
const tmp = trackTmpDirs('inbound-observation-');

beforeEach(() => {
  vi.clearAllMocks();
  doubles.useRealEmitAlert = false;
  doubles.emitAlert.mockReset();
  doubles.emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
  resetInboundObservations();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env['WHATSOUP_ALERT_SINK'];
  resetInboundObservations();
});

describe('inbound observation counts', () => {
  it('starts with every closed reason at zero', () => {
    expect(getInboundObservationHealth()).toEqual({
      counts: Object.fromEntries(INBOUND_OBSERVATION_REASONS.map((reason) => [reason, 0])),
      alerts: { durably_queued: 0, captured: 0, legacy_accepted_unconfirmed: 0, failed: 0, rate_limited: 0 },
      recorder_failures: 0,
    });
  });

  it('counts attempts per reason and ignores non-positive or fractional attempts', () => {
    observeInbound('WhatSoup', 'transport.unsupported_upsert_type', 3);
    observeInbound('WhatSoup', 'transport.unsupported_upsert_type', 0);
    observeInbound('WhatSoup', 'transport.stale_socket', -1);
    observeInbound('WhatSoup', 'transport.stale_socket', 1.5);
    observeInbound('WhatSoup', 'transport.parser_refused');

    expect(getInboundObservationHealth().counts).toMatchObject({
      'transport.unsupported_upsert_type': 3,
      'transport.stale_socket': 0,
      'transport.parser_refused': 1,
    });
  });

  it('keeps advisory reasons out of alerts and warn logs', () => {
    observeInbound('WhatSoup', 'transport.stale_socket');
    observeInbound('WhatSoup', 'transport.unsupported_upsert_type');
    observeInbound('WhatSoup', 'transport.parser_refused');

    expect(doubles.emitAlert).not.toHaveBeenCalled();
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.debug).toHaveBeenCalledTimes(3);
  });

  it('warns on a stored message that was not admitted, without an alert', () => {
    observeInbound('WhatSoup', 'ingest.stored_not_admitted');

    expect(doubles.emitAlert).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      { reason: 'ingest.stored_not_admitted', attempts: 1 },
      'stored inbound message not admitted',
    );
  });
});

describe('inbound observation alerts', () => {
  it.each([
    ['transport.no_consumer', 'inbound_no_consumer'],
    ['ingest.store_failed', 'inbound_store_failed'],
  ] as const)('%s raises a warning under the fixed source %s', (reason, source) => {
    observeInbound('WhatSoup', reason);

    expect(doubles.emitAlert).toHaveBeenCalledTimes(1);
    expect(doubles.emitAlert).toHaveBeenCalledWith('WhatSoup', source, expect.any(String), '', 'warning');
    expect(getInboundObservationHealth().alerts.durably_queued).toBe(1);
  });

  it('rate-limits each alerting reason to one emission per window, independently', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T16:00:00Z'));
    observeInbound('WhatSoup', 'ingest.store_failed');
    observeInbound('WhatSoup', 'ingest.store_failed');
    observeInbound('WhatSoup', 'transport.no_consumer');
    expect(doubles.emitAlert).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + INBOUND_OBSERVATION_ALERT_WINDOW_MS);
    observeInbound('WhatSoup', 'ingest.store_failed');

    expect(doubles.emitAlert).toHaveBeenCalledTimes(3);
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'ingest.store_failed': 3, 'transport.no_consumer': 1 },
      alerts: { durably_queued: 3, rate_limited: 1 },
    });
  });

  it('keeps durably_queued, captured, legacy_accepted_unconfirmed and failed distinct', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T16:00:00Z'));
    for (const status of ['durably_queued', 'captured', 'legacy_accepted_unconfirmed', 'failed'] as const) {
      doubles.emitAlert.mockReturnValueOnce({ ok: status !== 'failed', channel: 'outbox', status });
      observeInbound('WhatSoup', 'ingest.store_failed');
      vi.setSystemTime(Date.now() + INBOUND_OBSERVATION_ALERT_WINDOW_MS);
    }

    expect(getInboundObservationHealth().alerts).toEqual({
      durably_queued: 1, captured: 1, legacy_accepted_unconfirmed: 1, failed: 1, rate_limited: 0,
    });
  });
});

describe('alert window counts only accepted emissions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T16:00:00Z'));
  });

  it('a failed first emission does not consume the window; the next observation retries', () => {
    doubles.emitAlert.mockReturnValueOnce({ ok: false, channel: 'none', status: 'failed' });

    observeInbound('WhatSoup', 'ingest.store_failed');
    observeInbound('WhatSoup', 'ingest.store_failed');
    observeInbound('WhatSoup', 'ingest.store_failed');

    expect(doubles.emitAlert).toHaveBeenCalledTimes(2);
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'ingest.store_failed': 3 },
      alerts: { failed: 1, durably_queued: 1, rate_limited: 1 },
      recorder_failures: 0,
    });
  });

  it('a throwing first emission does not consume the window; the next observation retries', () => {
    doubles.emitAlert.mockImplementationOnce(() => { throw new Error('outbox exploded'); });

    expect(() => observeInbound('WhatSoup', 'transport.no_consumer')).not.toThrow();
    observeInbound('WhatSoup', 'transport.no_consumer');
    observeInbound('WhatSoup', 'transport.no_consumer');

    expect(doubles.emitAlert).toHaveBeenCalledTimes(2);
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'transport.no_consumer': 3 },
      alerts: { failed: 0, durably_queued: 1, rate_limited: 1 },
      recorder_failures: 1,
    });
  });

  it.each(['durably_queued', 'captured', 'legacy_accepted_unconfirmed'] as const)(
    'an accepted %s emission is reported as itself and starts the window',
    (status) => {
      doubles.emitAlert.mockReturnValue({ ok: true, channel: 'legacy', status });

      observeInbound('WhatSoup', 'ingest.store_failed');
      observeInbound('WhatSoup', 'ingest.store_failed');

      expect(doubles.emitAlert).toHaveBeenCalledTimes(1);
      expect(getInboundObservationHealth().alerts).toEqual({
        durably_queued: 0, captured: 0, legacy_accepted_unconfirmed: 0, failed: 0, rate_limited: 1, [status]: 1,
      });
    },
  );
});

describe('recorder failures', () => {
  it('an alert that throws is counted, never rethrown, and the observation still counts', () => {
    doubles.emitAlert.mockImplementation(() => { throw new Error('outbox exploded'); });

    expect(() => observeInbound('WhatSoup', 'transport.no_consumer')).not.toThrow();
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'transport.no_consumer': 1 },
      recorder_failures: 1,
    });
  });

  it('a logger that throws cannot prevent the operational alert', () => {
    mockLog.warn.mockImplementationOnce(() => { throw new Error('logger exploded'); });

    expect(() => observeInbound('WhatSoup', 'ingest.store_failed')).not.toThrow();
    expect(doubles.emitAlert).toHaveBeenCalledTimes(1);
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'ingest.store_failed': 1 },
      alerts: { durably_queued: 1 },
      recorder_failures: 1,
    });
  });

  it('a throwing alert still leaves the warning log', () => {
    doubles.emitAlert.mockImplementation(() => { throw new Error('outbox exploded'); });

    observeInbound('WhatSoup', 'ingest.store_failed');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'ingest.store_failed', alertAccepted: false, alertStatus: 'threw' }),
      'inbound message not admitted locally',
    );
  });

  it('a logger that throws is counted, never rethrown', () => {
    mockLog.debug.mockImplementationOnce(() => { throw new Error('logger exploded'); });

    expect(() => observeInbound('WhatSoup', 'transport.parser_refused')).not.toThrow();
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'transport.parser_refused': 1 },
      recorder_failures: 1,
    });
  });
});

describe('alert confinement at the real sink boundary', () => {
  it.each([
    ['transport.no_consumer', 'inbound_no_consumer'],
    ['ingest.store_failed', 'inbound_store_failed'],
  ] as const)('%s keeps its fixed source and carries no identifiers or prose', (reason, source) => {
    doubles.useRealEmitAlert = true;
    const sink = path.join(tmp.make('sink'), 'alerts.ndjson');
    process.env['WHATSOUP_ALERT_SINK'] = sink;

    observeInbound('WhatSoup', reason);

    const lines = readFileSync(sink, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(event).toMatchObject({ eventType: 'alert', severity: 'warning', source });
    expect(event.summary).toEqual({
      failureClass: expect.any(String),
      length: expect.any(Number),
      correlationDigest: expect.stringMatching(/^[0-9a-f]+$/),
    });
    expect(event).not.toHaveProperty('conversationScope');
    expect(lines[0]).not.toMatch(/@s\.whatsapp\.net|@lid|@g\.us|messageId|not admitted|could not be stored|persistence path|retention unknown/);
    expect(getInboundObservationHealth().alerts.captured).toBe(1);
  });
});
