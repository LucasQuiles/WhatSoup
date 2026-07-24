// src/transport/twilio/connection-snapshot.ts
// Factory for the "not-applicable" ConnectionStateSnapshot produced by the SMS
// transport bridge. The SMS transport carries no Baileys connection or WhatsApp
// credential material, so every credential-lifecycle field is a static null /
// zero / placeholder. Extracted from connection-bridge.getConnectionState() so
// the ~90-line all-null literal lives in one place (BEAD-038/CQ-40).
//
// Behaviour-preserving: the returned object is byte-identical to the literal it
// replaces. Only the three runtime-derived values vary per call and are passed
// as overrides; everything else (including process.* environment capture, which
// is evaluated at call time exactly as before) is baked in here.

import type { ConnectionStateSnapshot } from '../connection.ts';

export interface EmptyConnectionStateSnapshotOverrides {
  /** True when adapter.state().state === 'connected'. */
  connected: boolean;
  /** ISO timestamp of adapter health.since — drives stateChangedAt/lastOpen/lastClose. */
  stateChangedAt: string;
  /** adapter health.reasonCode ?? null. */
  lastDisconnectReason: string | null;
}

/**
 * Build the SMS-transport ConnectionStateSnapshot. Reproduces exactly the object
 * previously hand-built in TwilioConnectionBridge.getConnectionState().
 */
export function emptyConnectionStateSnapshot(
  overrides: EmptyConnectionStateSnapshotOverrides,
): ConnectionStateSnapshot {
  const { connected, stateChangedAt, lastDisconnectReason } = overrides;
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
        policy: 'sms transport has no WhatsApp credential material; no secrets or phone numbers are exposed',
      },
      environment: {
        instance: 'twilio-sms',
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
        authDir: 'sms_transport_not_applicable',
        stateRoot: null,
        dataRoot: null,
        lockPath: 'sms_transport_not_applicable',
        healthPort: 0,
        provider: 'twilio-sms',
      },
      currentAuthBond: {
        status: 'missing',
        issues: ['sms_transport_no_whatsapp_auth_bond'],
        authDir: { path: 'sms_transport_not_applicable', exists: false, mode: null, size: null, mtime: null },
        creds: {
          path: 'sms_transport_not_applicable',
          exists: false,
          mode: null,
          size: null,
          mtime: null,
          hash: null,
          identityHash: null,
        },
        treeHash: null,
        fileCount: null,
        totalBytes: null,
        backup: {
          root: 'sms_transport_not_applicable',
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
      connectStartedAt: null,
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
      recentEvents: [],
    },
  };
}
