/**
 * QR-020 — dedicated unit tests for emptyConnectionStateSnapshot.
 *
 * The factory builds the SMS-transport ConnectionStateSnapshot: every
 * credential-lifecycle field is a static "not applicable" placeholder (the SMS
 * transport carries no Baileys connection / WhatsApp creds), and only three
 * runtime-derived values vary per call via overrides. It was extracted from
 * TwilioConnectionBridge.getConnectionState() (BEAD-038/CQ-40) to be
 * behaviour-preserving, but had NO dedicated test — only the bridge's own tests
 * touched it transitively. These pin the override wiring (the part that varies,
 * and the one place a regression could flip lastOpen/lastClose) plus the static
 * "no WhatsApp credential material" contract.
 */
import { describe, it, expect } from 'vitest';
import { emptyConnectionStateSnapshot } from '../../../src/transport/twilio/connection-snapshot.ts';

const AT = '2026-06-30T12:00:00.000Z';

describe('emptyConnectionStateSnapshot', () => {
  it('connected=true → connected state with lastOpenAt set and lastCloseAt null', () => {
    const snap = emptyConnectionStateSnapshot({
      connected: true,
      stateChangedAt: AT,
      lastDisconnectReason: null,
    });
    expect(snap.state).toBe('connected');
    expect(snap.connected).toBe(true);
    expect(snap.stateChangedAt).toBe(AT);
    // When connected, lastCloseAt clears and lastOpenAt takes the change time.
    expect(snap.credentialLifecycle.lastCloseAt).toBeNull();
    expect(snap.credentialLifecycle.lastOpenAt).toBe(AT);
  });

  it('connected=false → disconnected state with lastCloseAt set and lastOpenAt null', () => {
    const snap = emptyConnectionStateSnapshot({
      connected: false,
      stateChangedAt: AT,
      lastDisconnectReason: 'carrier_unreachable',
    });
    expect(snap.state).toBe('disconnected');
    expect(snap.connected).toBe(false);
    expect(snap.credentialLifecycle.lastOpenAt).toBeNull();
    expect(snap.credentialLifecycle.lastCloseAt).toBe(AT);
  });

  it('lastDisconnectReason override is passed through verbatim (including null)', () => {
    expect(
      emptyConnectionStateSnapshot({ connected: false, stateChangedAt: AT, lastDisconnectReason: 'X' })
        .lastDisconnectReason,
    ).toBe('X');
    expect(
      emptyConnectionStateSnapshot({ connected: true, stateChangedAt: AT, lastDisconnectReason: null })
        .lastDisconnectReason,
    ).toBeNull();
  });

  it('credential-lifecycle fields are the static "no WhatsApp auth bond" placeholders', () => {
    const snap = emptyConnectionStateSnapshot({ connected: false, stateChangedAt: AT, lastDisconnectReason: null });
    const cl = snap.credentialLifecycle;
    expect(cl.currentAuthBond.status).toBe('missing');
    expect(cl.currentAuthBond.issues).toContain('sms_transport_no_whatsapp_auth_bond');
    expect(cl.currentAuthBond.creds.exists).toBe(false);
    expect(cl.currentAuthBond.authDir.exists).toBe(false);
    expect(cl.environment.provider).toBe('twilio-sms');
    expect(cl.environment.authDir).toBe('sms_transport_not_applicable');
    expect(cl.credsUpdateCount).toBe(0);
    expect(cl.authSnapshotCaptureCount).toBe(0);
    expect(cl.recentEvents).toEqual([]);
  });

  it('connection-health counters/fields are the zeroed not-applicable defaults', () => {
    const snap = emptyConnectionStateSnapshot({ connected: true, stateChangedAt: AT, lastDisconnectReason: null });
    expect(snap.reconnectAttempts).toBe(0);
    expect(snap.reconnectPhase).toBeNull();
    expect(snap.firstFailureAt).toBeNull();
    expect(snap.lastPingAt).toBeNull();
    expect(snap.lastPongAt).toBeNull();
    expect(snap.recentDisconnects.count).toBe(0);
    expect(snap.recentDisconnects.byReason).toEqual({});
  });

  it('captures the live process environment in the snapshot (evaluated at call time)', () => {
    const snap = emptyConnectionStateSnapshot({ connected: true, stateChangedAt: AT, lastDisconnectReason: null });
    // pid/version/platform are real process values — assert they match the runtime,
    // proving the factory reads them at call time rather than baking a literal.
    expect(snap.credentialLifecycle.environment.pid).toBe(process.pid);
    expect(snap.credentialLifecycle.environment.nodeVersion).toBe(process.version);
    expect(snap.credentialLifecycle.environment.platform).toBe(process.platform);
  });
});
