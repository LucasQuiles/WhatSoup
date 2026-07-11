/**
 * Startup-ping idempotency marker (M1, introSent pattern).
 *
 * The generic '*Agent back online* ✓' startup notification persists a marker
 * BEFORE sending and clears it after a confirmed send. A fresh marker at boot
 * means a previous boot crashed around its ping — the new boot consumes the
 * marker and skips its own ping (at-most-once beats duplicate spam; this is
 * the same persist-before-send bias the introSent flag uses).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STARTUP_PING_MARKER,
  persistStartupPingMarker,
  consumeStartupPingMarker,
  clearStartupPingMarker,
} from '../../src/core/startup-ping-marker.ts';

describe('startup-ping marker', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'startup-ping-'));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('consume returns null when no marker exists (normal boot sends its ping)', () => {
    expect(consumeStartupPingMarker(dataRoot)).toBeNull();
  });

  it('persist-then-consume round-trips: the next boot sees the crashed attempt', () => {
    persistStartupPingMarker(dataRoot);
    const marker = consumeStartupPingMarker(dataRoot);
    expect(marker).not.toBeNull();
    expect(marker!.pid).toBe(process.pid);
  });

  it('consume is consume-once: the marker file is removed even when fresh', () => {
    persistStartupPingMarker(dataRoot);
    consumeStartupPingMarker(dataRoot);
    expect(existsSync(join(dataRoot, STARTUP_PING_MARKER))).toBe(false);
    expect(consumeStartupPingMarker(dataRoot)).toBeNull();
  });

  it('a stale marker does not suppress a fresh boot ping (returns null, file removed)', () => {
    const markerPath = join(dataRoot, STARTUP_PING_MARKER);
    writeFileSync(markerPath, JSON.stringify({
      timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
      pid: 1,
    }));

    expect(consumeStartupPingMarker(dataRoot)).toBeNull();
    expect(existsSync(markerPath)).toBe(false);
  });

  it('clear removes a persisted marker (post-send success path)', () => {
    persistStartupPingMarker(dataRoot);
    clearStartupPingMarker(dataRoot);
    expect(existsSync(join(dataRoot, STARTUP_PING_MARKER))).toBe(false);
    expect(consumeStartupPingMarker(dataRoot)).toBeNull();
  });

  it('clear on a missing marker is a no-op', () => {
    expect(() => clearStartupPingMarker(dataRoot)).not.toThrow();
  });
});
