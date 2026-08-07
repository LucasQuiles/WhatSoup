import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitAlertChecked = vi.hoisted(() => vi.fn(() => true));
const clearAlertSourceChecked = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/lib/emit-alert.ts', () => ({ emitAlertChecked, clearAlertSourceChecked }));

import { OutboundFloodIncidentLifecycle } from '../../src/transport/outbound-flood-incident.ts';
import type { OutboundFloodRecordResult, OutboundFloodStats } from '../../src/transport/outbound-flood-detector.ts';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

const tripResult: OutboundFloodRecordResult = { flooding: true, count: 40 } as OutboundFloodRecordResult;

function quietStats(): OutboundFloodStats {
  return {
    flooding: false,
    windowMs: 60_000,
    threshold: 30,
    destCount: 0,
    worstCount: 0,
  } as OutboundFloodStats;
}

describe('OutboundFloodIncidentLifecycle (#2414 pending-retry + marker durability)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'whatsoup-flood-incident-'));
    emitAlertChecked.mockClear();
    emitAlertChecked.mockReturnValue(true);
    clearAlertSourceChecked.mockClear();
    clearAlertSourceChecked.mockReturnValue(true);
    log.info.mockClear();
    log.warn.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function markerPath(): string {
    return join(root, 'outbound-flood-incident.json');
  }

  function readMarker(): Record<string, unknown> {
    return JSON.parse(readFileSync(markerPath(), 'utf-8')) as Record<string, unknown>;
  }

  it('persists an acknowledged v2 marker when the trip emit is accepted', () => {
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);

    expect(lifecycle.hasPending()).toBe(false);
    const marker = readMarker();
    expect(marker['version']).toBe(2);
    expect(marker['acknowledged']).toBe(true);
  });

  it('persists an unacknowledged marker when the trip emit fails, leaving the incident pending', () => {
    emitAlertChecked.mockReturnValue(false);
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);

    expect(lifecycle.hasPending()).toBe(true);
    expect((readMarker())['acknowledged']).toBe(false);
  });

  it('retryPending returns false when no incident is open', () => {
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    expect(lifecycle.retryPending()).toBe(false);
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('retryPending returns false when the incident is already acknowledged', () => {
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);
    emitAlertChecked.mockClear();

    expect(lifecycle.retryPending()).toBe(false);
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('retryPending re-emits, acknowledges, and rewrites the marker on success', () => {
    emitAlertChecked.mockReturnValueOnce(false);
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);
    expect(lifecycle.hasPending()).toBe(true);

    emitAlertChecked.mockReturnValue(true);
    expect(lifecycle.retryPending()).toBe(true);
    expect(lifecycle.hasPending()).toBe(false);
    expect((readMarker())['acknowledged']).toBe(true);
  });

  it('retryPending keeps the incident pending when the retry emit is refused', () => {
    emitAlertChecked.mockReturnValue(false);
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);

    expect(lifecycle.retryPending()).toBe(false);
    expect(lifecycle.hasPending()).toBe(true);
    expect((readMarker())['acknowledged']).toBe(false);
  });

  it('warns instead of throwing when no stateRoot is configured', () => {
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: null, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);

    expect(log.warn).toHaveBeenCalledWith('outbound flood incident marker path unavailable; restart recovery is not durable');
    expect(existsSync(markerPath())).toBe(false);
  });

  it('restores a pending incident from an unacknowledged v2 marker', () => {
    writeFileSync(markerPath(), JSON.stringify({
      version: 2,
      instance: 'test',
      source: 'outbound_flood',
      openedAt: new Date().toISOString(),
      acknowledged: false,
    }), { mode: 0o600 });

    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    expect(lifecycle.hasPending()).toBe(true);
  });

  it('treats a v1 marker as acknowledged (pre-#2414 behavior)', () => {
    writeFileSync(markerPath(), JSON.stringify({
      version: 1,
      instance: 'test',
      source: 'outbound_flood',
      openedAt: new Date().toISOString(),
    }), { mode: 0o600 });

    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    expect(lifecycle.hasPending()).toBe(false);
  });

  it.each([
    ['unknown version', { version: 3, instance: 'test', source: 'outbound_flood', openedAt: new Date().toISOString() }],
    ['wrong instance', { version: 2, instance: 'other', source: 'outbound_flood', openedAt: new Date().toISOString() }],
    ['wrong source', { version: 2, instance: 'test', source: 'other_source', openedAt: new Date().toISOString() }],
    ['unparseable openedAt', { version: 2, instance: 'test', source: 'outbound_flood', openedAt: 'not-a-date' }],
  ])('ignores an invalid marker (%s) and stays closed', (_label, marker) => {
    writeFileSync(markerPath(), JSON.stringify(marker), { mode: 0o600 });

    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    expect(lifecycle.hasPending()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('ignored invalid outbound flood incident marker');
  });

  it('survives an unreadable marker file without opening', () => {
    writeFileSync(markerPath(), '{not json', { mode: 0o600 });

    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    expect(lifecycle.hasPending()).toBe(false);
  });

  it('reconcile retries a pending emit before evaluating recovery', () => {
    emitAlertChecked.mockReturnValue(false);
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);

    emitAlertChecked.mockReturnValue(true);
    lifecycle.reconcile(quietStats());

    expect(lifecycle.hasPending()).toBe(false);
    expect(emitAlertChecked).toHaveBeenCalledWith(
      'test',
      'outbound_flood',
      'outbound flood (retry pending)',
      '{"reason":"retry_pending"}',
      'critical',
    );
  });

  it('reconcile clears the incident and deletes the marker after a verified quiet window', () => {
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);
    expect(existsSync(markerPath())).toBe(true);

    lifecycle.reconcile(quietStats());

    expect(clearAlertSourceChecked).toHaveBeenCalled();
    expect(existsSync(markerPath())).toBe(false);
    expect(lifecycle.hasPending()).toBe(false);
  });

  it('reconcile leaves the incident open when the clear emission is refused', () => {
    clearAlertSourceChecked.mockReturnValue(false);
    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.emitTrip(tripResult, 'dest-hash', 600_000);

    lifecycle.reconcile(quietStats());

    expect(existsSync(markerPath())).toBe(true);
  });

  it('holds a freshly-restored incident until the quiet window has fully elapsed', () => {
    writeFileSync(markerPath(), JSON.stringify({
      version: 2,
      instance: 'test',
      source: 'outbound_flood',
      openedAt: new Date().toISOString(),
      acknowledged: true,
    }), { mode: 0o600 });

    const lifecycle = new OutboundFloodIncidentLifecycle({ instance: 'test', stateRoot: root, log });
    lifecycle.reconcile(quietStats());

    expect(clearAlertSourceChecked).not.toHaveBeenCalled();
    expect(existsSync(markerPath())).toBe(true);
  });
});
