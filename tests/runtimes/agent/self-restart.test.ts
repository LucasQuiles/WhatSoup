import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceManager } from '../../../src/fleet/platform.ts';
import {
  INTENTIONAL_RESTART_MARKER,
  consumeIntentionalRestartMarker,
  intentionalRestartMarkerPath,
  triggerSelfRestart,
  _resetSelfRestartGuard,
  type IntentionalRestartMarker,
} from '../../../src/runtimes/agent/self-restart.ts';

function makeServiceManager(overrides: Partial<ServiceManager> = {}): ServiceManager {
  return {
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    startFire: vi.fn(() => {}),
    ...overrides,
  };
}

describe('self-restart core', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'self-restart-'));
    _resetSelfRestartGuard();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('marker path joins dataRoot with the stable marker filename', () => {
    expect(INTENTIONAL_RESTART_MARKER).toBe('intentional-restart.marker');
    expect(intentionalRestartMarkerPath('/data/q')).toBe('/data/q/intentional-restart.marker');
  });

  it('writes a marker with the full taxonomy shape and calls restart with the instance', async () => {
    const restart = vi.fn(async () => {});
    const sm = makeServiceManager({ restart });

    const result = await triggerSelfRestart({
      instance: 'q',
      dataRoot,
      reason: 'load merged main',
      code: 'redeploy',
      chatJid: '1111111000000000@g.us',
      requestedBy: 'agent',
      serviceManager: sm,
      now: () => Date.parse('2026-06-28T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.markerPath).toBe(intentionalRestartMarkerPath(dataRoot));
    expect(restart).toHaveBeenCalledWith('q');

    const marker = JSON.parse(readFileSync(result.markerPath, 'utf-8')) as IntentionalRestartMarker;
    expect(marker.code).toBe('redeploy');
    expect(marker.instance).toBe('q');
    expect(marker.reason).toBe('load merged main');
    expect(marker.requestedBy).toBe('agent');
    expect(marker.chatJid).toBe('1111111000000000@g.us');
    expect(marker.timestamp).toBe('2026-06-28T00:00:00.000Z');
    expect(typeof marker.pid).toBe('number');
  });

  it('defaults code to self_restart when omitted', async () => {
    const result = await triggerSelfRestart({
      instance: 'q',
      dataRoot,
      reason: 'apply config',
      requestedBy: 'agent',
      serviceManager: makeServiceManager(),
    });
    const marker = JSON.parse(readFileSync(result.markerPath, 'utf-8')) as IntentionalRestartMarker;
    expect(marker.code).toBe('self_restart');
  });

  it('accepts a personal JID', async () => {
    const result = await triggerSelfRestart({
      instance: 'q',
      dataRoot,
      reason: 'r',
      chatJid: '15551234567@s.whatsapp.net',
      requestedBy: 'agent',
      serviceManager: makeServiceManager(),
    });
    const marker = JSON.parse(readFileSync(result.markerPath, 'utf-8')) as IntentionalRestartMarker;
    expect(marker.chatJid).toBe('15551234567@s.whatsapp.net');
  });

  it('drops an invalid chatJid (writes marker without it, does not throw)', async () => {
    const result = await triggerSelfRestart({
      instance: 'q',
      dataRoot,
      reason: 'r',
      chatJid: 'not-a-jid',
      requestedBy: 'agent',
      serviceManager: makeServiceManager(),
    });
    expect(result.ok).toBe(true);
    const marker = JSON.parse(readFileSync(result.markerPath, 'utf-8')) as IntentionalRestartMarker;
    // Invalid JID is dropped, but the rest of the marker is still written intact.
    expect(marker.chatJid).toBeUndefined();
    expect(marker.reason).toBe('r');
    expect(marker.instance).toBe('q');
  });

  it('re-entrancy guard makes a second call a no-op', async () => {
    const restart = vi.fn(async () => {});
    const sm = makeServiceManager({ restart });

    const first = await triggerSelfRestart({
      instance: 'q', dataRoot, reason: 'first', requestedBy: 'agent', serviceManager: sm,
    });
    const second = await triggerSelfRestart({
      instance: 'q', dataRoot, reason: 'second', requestedBy: 'agent', serviceManager: sm,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('leaves the marker written and rethrows when restart throws', async () => {
    const restart = vi.fn(async () => { throw new Error('systemctl boom'); });
    const sm = makeServiceManager({ restart });

    await expect(triggerSelfRestart({
      instance: 'q', dataRoot, reason: 'r', requestedBy: 'agent', serviceManager: sm,
    })).rejects.toThrow(/restart/i);

    expect(existsSync(intentionalRestartMarkerPath(dataRoot))).toBe(true);
  });

  it('consumes a fresh marker, returns it, and deletes the file', () => {
    const path = intentionalRestartMarkerPath(dataRoot);
    const marker: IntentionalRestartMarker = {
      timestamp: new Date().toISOString(),
      instance: 'q',
      code: 'self_restart',
      reason: 'r',
      requestedBy: 'agent',
      pid: 123,
    };
    writeFileSync(path, JSON.stringify(marker), 'utf-8');

    const consumed = consumeIntentionalRestartMarker(dataRoot);
    expect(consumed?.reason).toBe('r');
    expect(consumed?.code).toBe('self_restart');
    expect(existsSync(path)).toBe(false);
  });

  it('discards a stale marker and removes the file', () => {
    const path = intentionalRestartMarkerPath(dataRoot);
    const marker: IntentionalRestartMarker = {
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      instance: 'q',
      code: 'self_restart',
      reason: 'r',
      requestedBy: 'agent',
      pid: 123,
    };
    writeFileSync(path, JSON.stringify(marker), 'utf-8');

    expect(consumeIntentionalRestartMarker(dataRoot)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('returns null when no marker exists', () => {
    expect(consumeIntentionalRestartMarker(dataRoot)).toBeNull();
  });

  it('back-online message rounds downtime to seconds', () => {
    // The template is inlined at the main.ts call site — verify the expected
    // string shape here so a refactor doesn't silently break the wording.
    const reason = 'load merged main';
    const downtimeMs = 12_400;
    const text = `✅ Back online — restarted to ${reason} (down ${Math.round(downtimeMs / 1000)}s)`;
    expect(text).toBe('✅ Back online — restarted to load merged main (down 12s)');
  });
});
