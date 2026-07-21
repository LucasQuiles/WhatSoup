// tests/transport/signal/connection-snapshot.test.ts
// Signal-specific connection state snapshot.
//
// Before this slice, Signal's getConnectionState() borrowed Twilio's
// emptyConnectionStateSnapshot() factory, which hardcodes "twilio-sms" as the
// provider, "sms_transport_not_applicable" for paths, and
// "sms_transport_no_whatsapp_auth_bond" as the auth-bond issue. Ops dashboards
// reading health.json could not distinguish a Signal instance from an SMS
// instance — and the auth-bond issue text actively lied about the transport.
//
// This file exercises the new Signal-specific snapshot factory.

import { describe, it, expect } from 'vitest';
import { signalConnectionStateSnapshot } from '../../../src/transport/signal/connection-snapshot.ts';

describe('signalConnectionStateSnapshot', () => {
  const baseConfig = {
    instance: 'ops-signal',
    account: 'ops-signal',
    phoneNumber: '+15551234567',
    socketPath: '/tmp/signalc.sock',
  };

  it('reports provider as "signal" (not "twilio-sms")', () => {
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: null,
    });
    expect(snap.credentialLifecycle.environment.provider).toBe('signal');
  });

  it('reports the instance name (not hardcoded "twilio-sms")', () => {
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: null,
    });
    expect(snap.credentialLifecycle.environment.instance).toBe('ops-signal');
  });

  it('exposes the daemon socket path in authDir (Signal credentials live out-of-band)', () => {
    // Pairing/registration happens out-of-band via `signal-cli link` /
    // `signal-cli register`. The daemon owns the credential material at its
    // data dir. health.json should say WHERE (signal-cli data dir / socket),
    // not pretend it does not exist.
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: null,
      signalCliDataDir: '/var/lib/signal-cli',
    });
    expect(snap.credentialLifecycle.environment.authDir).toMatch(/signal/i);
    expect(snap.credentialLifecycle.environment.authDir).not.toBe('sms_transport_not_applicable');
  });

  it('exposes the daemon socket path / TCP target in environment.lockPath', () => {
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: null,
    });
    expect(snap.credentialLifecycle.environment.lockPath).toBe('/tmp/signalc.sock');
  });

  it('uses TCP target as lockPath when no socket path configured', () => {
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      socketPath: undefined,
      tcpHost: '127.0.0.1',
      tcpPort: 7583,
      connected: false,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: 'daemon-unreachable',
    });
    expect(snap.credentialLifecycle.environment.lockPath).toBe('127.0.0.1:7583');
  });

  it('reports auth bond status as "missing" with signal-specific issue text', () => {
    // The status "missing" matches the SMS precedent (from WhatSoup's POV the
    // credentials ARE missing — signal-cli owns them out-of-band). The issue
    // text names the real model so dashboards don't read "missing" as "broken".
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: false,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: null,
    });
    expect(snap.credentialLifecycle.currentAuthBond.status).toBe('missing');
    expect(snap.credentialLifecycle.currentAuthBond.issues).not.toContain(
      'sms_transport_no_whatsapp_auth_bond',
    );
    expect(snap.credentialLifecycle.currentAuthBond.issues.some((i) => /signal/i.test(i))).toBe(true);
  });

  it('reflects adapter connected state in lastOpenAt / lastCloseAt', () => {
    const connected = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T10:00:00.000Z',
      lastDisconnectReason: null,
    });
    expect(connected.credentialLifecycle.lastOpenAt).toBe('2026-07-21T10:00:00.000Z');
    expect(connected.credentialLifecycle.lastCloseAt).toBeNull();

    const disconnected = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: false,
      stateChangedAt: '2026-07-21T11:00:00.000Z',
      lastDisconnectReason: 'daemon-unreachable',
    });
    expect(disconnected.credentialLifecycle.lastOpenAt).toBeNull();
    expect(disconnected.credentialLifecycle.lastCloseAt).toBe('2026-07-21T11:00:00.000Z');
  });

  it('carries the disconnect reason into recentEvents when disconnected', () => {
    // The whole point of the lifecycle event stream is giving ops a timeline.
    // A disconnect with a reason should produce at least one recentEvent.
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: false,
      stateChangedAt: '2026-07-21T11:00:00.000Z',
      lastDisconnectReason: 'daemon-unreachable',
    });
    expect(snap.credentialLifecycle.recentEvents.length).toBeGreaterThan(0);
    const last = snap.credentialLifecycle.recentEvents[snap.credentialLifecycle.recentEvents.length - 1];
    expect(last.event).toBe('connection_close');
    expect(last.reason).toBe('daemon-unreachable');
  });

  it('emits a connect_start + connection_open pair when connected', () => {
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T10:00:00.000Z',
      lastDisconnectReason: null,
    });
    const events = snap.credentialLifecycle.recentEvents.map((e) => e.event);
    expect(events).toContain('connect_start');
    expect(events).toContain('connection_open');
  });

  it('preserves the redaction policy notice (Signal carries no creds in-process, but the policy text is still emitted for consistent dashboards)', () => {
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: null,
    });
    expect(snap.credentialLifecycle.redaction.policy).toMatch(/signal/i);
  });

  it('carries the phone number redaction note (Signal uses E.164 phone numbers as identifiers)', () => {
    // Sanity: phoneNumber is part of the snapshot environment only when the
    // caller passes it; it is not auto-derived. We never log it raw.
    const snap = signalConnectionStateSnapshot({
      ...baseConfig,
      connected: true,
      stateChangedAt: '2026-07-21T00:00:00.000Z',
      lastDisconnectReason: null,
    });
    // The snapshot MUST NOT leak the raw phone number into environment fields.
    const env = snap.credentialLifecycle.environment as unknown as Record<string, unknown>;
    const json = JSON.stringify(env);
    expect(json).not.toContain('+15551234567');
  });
});
