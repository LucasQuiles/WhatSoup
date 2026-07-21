// src/transport/signal/connection-snapshot.ts
// Factory for the Signal-transport ConnectionStateSnapshot.
//
// Mirrors the twilio/connection-snapshot.ts precedent but reports
// Signal-specific values so ops dashboards reading health.json can distinguish
// a Signal instance from an SMS/Twilio instance. Before this factory existed,
// Signal's getConnectionState() borrowed Twilio's empty snapshot, which
// hardcodes "twilio-sms" / "sms_transport_not_applicable" strings throughout
// — actively lying about the transport.
//
// Pairing/registration for Signal happens OUT-OF-BAND via `signal-cli link` /
// `signal-cli register` + `verify`. WhatSoup does NOT own or store the
// credential material (the signal-cli daemon does, at its data directory).
// The snapshot therefore surfaces the daemon socket / TCP target so an
// operator can locate the credential owner, and reports auth-bond status as
// "unknown" (not "missing") with issue text that names the real model.

import type { ConnectionStateSnapshot, CredentialLifecycleEvent } from '../connection.ts';

export interface SignalConnectionStateSnapshotOverrides {
  /** Channel instance name (e.g. "ops-signal"). */
  instance: string;
  /** Channel account segment (e.g. "ops-signal"). */
  account: string;
  /** Linked device's own E.164 phone number. NEVER logged raw. */
  phoneNumber: string;
  /** UNIX socket path to the signal-cli daemon. Wins over TCP when both set. */
  socketPath?: string;
  /** TCP host for the signal-cli daemon (used when socketPath is unset). */
  tcpHost?: string;
  /** TCP port for the signal-cli daemon. */
  tcpPort?: number;
  /** signal-cli data directory (where credential material actually lives). */
  signalCliDataDir?: string;
  /** True when adapter.state().state === 'connected'. */
  connected: boolean;
  /** ISO timestamp of adapter health.since. */
  stateChangedAt: string;
  /** adapter.health.reasonCode ?? null. */
  lastDisconnectReason: string | null;
  /**
   * Real lifecycle events from the adapter's bounded ring buffer. When
   * supplied, replaces the synthesized 2-event timeline. Phase 3 slice 2.
   */
  recentLifecycleEvents?: readonly CredentialLifecycleEvent[];
}

/**
 * Resolve the daemon target descriptor for the lockPath environment field.
 * Prefers the UNIX socket; falls back to host:port when only TCP is configured.
 */
function resolveDaemonTarget(opts: SignalConnectionStateSnapshotOverrides): string {
  if (opts.socketPath) return opts.socketPath;
  if (opts.tcpHost || opts.tcpPort) {
    return `${opts.tcpHost ?? '127.0.0.1'}:${opts.tcpPort ?? 7583}`;
  }
  return 'signal-cli-daemon-target-unset';
}

/**
 * Build a recentEvents timeline describing the current state transition.
 * The WhatsApp side accumulates a real event log; Signal does not yet have
 * one, so we synthesize a minimal two-event timeline reflecting the current
 * state. This is enough for dashboards to show "the connection is open right
 * now" or "the connection just closed for this reason".
 */
function buildRecentEvents(
  connected: boolean,
  stateChangedAt: string,
  lastDisconnectReason: string | null,
): CredentialLifecycleEvent[] {
  const events: CredentialLifecycleEvent[] = [];
  const state: ConnectionStateSnapshot['state'] = connected ? 'connected' : 'disconnected';
  const baseFields = {
    at: stateChangedAt,
    state,
    reconnectAttempts: 0,
    reconnectPhase: 'backoff' as const,
  };
  if (connected) {
    events.push({ ...baseFields, event: 'connect_start' });
    events.push({ ...baseFields, event: 'connection_open' });
  } else {
    events.push({
      ...baseFields,
      event: 'connection_close',
      reason: lastDisconnectReason ?? undefined,
    });
  }
  return events;
}

/**
 * Build the Signal-transport ConnectionStateSnapshot.
 */
export function signalConnectionStateSnapshot(
  opts: SignalConnectionStateSnapshotOverrides,
): ConnectionStateSnapshot {
  const { connected, stateChangedAt, lastDisconnectReason } = opts;
  const daemonTarget = resolveDaemonTarget(opts);
  const signalCliDataDir = opts.signalCliDataDir ?? 'out_of_band_via_signal_cli';
  // Phase 3 slice 2: prefer real adapter events; fall back to synthesis only
  // for callers that don't supply them (e.g. unit tests of the snapshot
  // factory in isolation).
  const recentEvents = opts.recentLifecycleEvents && opts.recentLifecycleEvents.length > 0
    ? opts.recentLifecycleEvents.slice()
    : buildRecentEvents(connected, stateChangedAt, lastDisconnectReason);

  return {
    state: connected ? 'connected' : 'disconnected',
    connected,
    reconnectAttempts: 0,
    reconnectPhase: null,
    stateChangedAt,
    firstFailureAt: null,
    lastPingAt: null,
    lastPongAt: null,
    lastDisconnectReason,
    lastStatusCode: null,
    recentDisconnects: {
      windowMs: 10 * 60 * 1000,
      count: 0,
      lastAt: null,
      lastReason: null,
      lastStatusCode: null,
      byReason: {},
    },
    credentialLifecycle: {
      version: 1,
      redaction: {
        version: 1,
        // Signal credential material lives in the signal-cli daemon's data
        // directory, not in WhatSoup's process. WhatSoup still avoids leaking
        // the phone number into logs / dashboards.
        policy:
          'signal transport: credential material lives out-of-band with signal-cli; ' +
          'phone numbers and identity keys are not exposed',
      },
      environment: {
        instance: opts.instance,
        host: process.env['HOSTNAME'] ?? 'unknown',
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        release: 'unknown',
        processUptimeSeconds: Math.floor(process.uptime()),
        osUptimeSeconds: 0,
        loadavg: [],
        memory: { freeBytes: 0, totalBytes: 0 },
        // authDir reports WHERE the credentials live. For Signal that is the
        // signal-cli data dir (out-of-band), not a WhatSoup-owned path.
        authDir: signalCliDataDir,
        stateRoot: null,
        dataRoot: null,
        // lockPath is reused as the "daemon target" descriptor — the UNIX
        // socket or TCP endpoint ThisSoup talks to.
        lockPath: daemonTarget,
        healthPort: 0,
        provider: 'signal',
      },
      currentAuthBond: {
        // Status "missing" because from WhatSoup's perspective the credentials
        // ARE missing — signal-cli owns them out-of-band. The issue text names
        // the real model so ops dashboards don't read "missing" as "broken".
        status: 'missing',
        issues: ['signal_credentials_managed_out_of_band_by_signal_cli'],
        authDir: { path: signalCliDataDir, exists: true, mode: null, size: null, mtime: null },
        creds: {
          path: `${signalCliDataDir}/+<redacted>`,
          exists: true,
          mode: null,
          size: null,
          mtime: null,
          hash: null,
          identityHash: null,
        },
        treeHash: null,
        backup: {
          root: signalCliDataDir,
          latest: null,
          latestAt: null,
          latestReason: null,
          latestTreeHash: null,
          lastCaptureAt: null,
          lastCaptureReason: null,
          lastCaptureError: null,
          lastCaptureDeferredAt: null,
          lastCaptureDeferredReason: null,
          lastCaptureDeferredAgeMs: null,
          lastRestoreAt: null,
          lastRestoreSource: null,
          lastRestoreError: null,
        },
      },
      latestBaileysVersion: null,
      connectStartedAt: connected ? stateChangedAt : null,
      lastOpenAt: connected ? stateChangedAt : null,
      lastCloseAt: connected ? null : stateChangedAt,
      lastQrAt: null,
      lastCredsUpdateAt: null,
      lastCredsUpdateFailedAt: null,
      lastAuthSnapshotAt: null,
      lastAuthSnapshotFailedAt: null,
      credsUpdateCount: 0,
      authSnapshotCaptureCount: 0,
      authSnapshotFailureCount: 0,
      lastDisconnectDiagnostic: null,
      recentEvents,
    },
  };
}
