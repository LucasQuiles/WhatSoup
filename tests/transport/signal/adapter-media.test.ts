// tests/transport/signal/adapter-media.test.ts
// media attachment support.
//
// Before this slice, the Signal adapter declared media.maxBytes: 0, the
// `media` extension was NOT in capabilities.extensions, and the bridge
// rejected sendMedia() with UnsupportedTransportOperationError. The spec
// (docs/superpowers/specs/2026-07-20-signal-and-imessage-transports-spec.md §3a)
// prescribes Signal's documented attachment cap (100MB) and MIME allowlist,
// and the signal-cli man page documents the `--attachment` flag and JSON-RPC
// `attachments` array shape (data:<MIME>;filename=<NAME>;base64,<DATA>).
//
// This file proves:
//   1. capabilities.media.maxBytes is non-zero and matches the spec
//   2. capabilities.media.mimeAllowlist covers the documented set
//   3. capabilities.extensions includes 'media' (isMediaCapable() → true)
//   4. adapter.sendMedia() converts MediaPayload → signal-cli send RPC
//   5. sendMedia validates against the allowlist BEFORE the RPC
//   6. sendMedia enforces the size cap BEFORE the RPC
//   7. bridge.sendMedia() routes to the adapter (no longer rejects)

import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { SignalConnection } from '../../../src/transport/signal/connection-bridge.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import { isMediaCapable } from '../../../src/transport/contract/extensions.ts';
import type { MediaPayload } from '../../../src/transport/contract/commands.ts';

describe('SignalAdapter — media capabilities', () => {
  it('declares media.maxBytes >= 100 MB (spec value: 104857600)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.capabilities.media.maxBytes).toBeGreaterThanOrEqual(100 * 1024 * 1024);
  });

  it('includes image/jpeg, image/png, image/gif, image/webp, video/mp4, application/pdf in the allowlist', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    const allow = adapter.capabilities.media.mimeAllowlist;
    // Spec §3a: at minimum these documented MIME types must be allowed.
    for (const expected of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'application/pdf']) {
      expect(allow).toContain(expected);
    }
  });

  it('declares the media extension (isMediaCapable returns true)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(isMediaCapable(adapter)).toBe(true);
  });
});

describe('SignalAdapter — sendMedia', () => {
  it('converts an image MediaPayload to the signal-cli send RPC with a base64 data URI attachment', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const payload: MediaPayload = {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mime: 'image/png',
      caption: 'a caption',
    };

    const result = await adapter.sendMedia(
      { channel: adapter.capabilities.channel, id: '+15551234567' },
      payload,
    );
    expect(result).toHaveProperty('id');

    // Inspect the args the mock port saw.
    expect(port.sent).toHaveLength(1);
    const sent = port.sent[0];
    expect(sent.recipient).toBe('+15551234567');
    expect(sent.attachments).toBeDefined();
    expect(sent.attachments?.length).toBe(1);
    // Per the signal-cli man page: data:<MIME>;filename=<NAME>;base64,<DATA>
    const att = sent.attachments?.[0] as string;
    expect(att).toMatch(/^data:image\/png;filename=[^;]+\.png;base64,/);
  });

  it('passes the caption through as the message body', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const payload: MediaPayload = {
      bytes: new Uint8Array([0xff, 0xd8]),
      mime: 'image/jpeg',
      caption: 'look at this',
    };
    await adapter.sendMedia({ channel: adapter.capabilities.channel, id: '+15551234567' }, payload);
    expect(port.sent[0].body).toBe('look at this');
  });

  it('omits the body when no caption is supplied', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const payload: MediaPayload = {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
      mime: 'application/pdf',
      filename: 'report.pdf',
    };
    await adapter.sendMedia({ channel: adapter.capabilities.channel, id: '+15551234567' }, payload);
    expect(port.sent[0].body).toBe('');
  });

  it('uses the caller-supplied filename for documents (preserved in the data URI)', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const payload: MediaPayload = {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mime: 'application/pdf',
      filename: 'invoice-2026.pdf',
    };
    await adapter.sendMedia({ channel: adapter.capabilities.channel, id: '+15551234567' }, payload);
    const att = port.sent[0].attachments?.[0] as string;
    expect(att).toMatch(/filename=invoice-2026\.pdf/);
  });

  it('rejects with a typed error when MIME is not on the allowlist (before any RPC)', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const payload: MediaPayload = {
      bytes: new Uint8Array([0x4d, 0x5a]),
      mime: 'application/x-msdownload', // not on the allowlist
      filename: 'evil.exe',
    };
    await expect(
      adapter.sendMedia({ channel: adapter.capabilities.channel, id: '+15551234567' }, payload),
    ).rejects.toThrow(/mime|allowlist|not supported/i);
    // Must NOT have reached the port — pre-validation.
    expect(port.sent).toHaveLength(0);
  });

  it('rejects with a typed error when payload exceeds the size cap (before any RPC)', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();
    const cap = adapter.capabilities.media.maxBytes;

    const oversized: MediaPayload = {
      bytes: new Uint8Array(cap + 1), // one byte over cap
      mime: 'image/png',
    };
    await expect(
      adapter.sendMedia({ channel: adapter.capabilities.channel, id: '+15551234567' }, oversized),
    ).rejects.toThrow(/size|maxBytes|too large|exceeds/i);
    expect(port.sent).toHaveLength(0);
  });

  it('routes to a group when the target id is a base64 V2 group id', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    // A plausible base64 V2 group id (60+ chars).
    const groupId = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
    const payload: MediaPayload = {
      bytes: new Uint8Array([0xff, 0xd8]),
      mime: 'image/jpeg',
    };
    await adapter.sendMedia({ channel: adapter.capabilities.channel, id: groupId }, payload);
    expect(port.sent[0].groupId).toBe(groupId);
    expect(port.sent[0].recipient).toBeUndefined();
  });
});

describe('SignalConnection (bridge) — sendMedia', () => {
  it('routes sendMedia to the adapter (does NOT reject with UnsupportedTransportOperationError)', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    const bridge = new SignalConnection(adapter, port, makeSignalConfig(), 'test-instance');

    const payload: MediaPayload = {
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mime: 'image/png',
    };
    const result = await bridge.sendMedia('+15551234567@signal', {
      type: 'image',
      mimetype: 'image/png',
      buffer: Buffer.from(payload.bytes),
    } as any);
    expect(result).toHaveProperty('waMessageId');
    expect(port.sent.length).toBeGreaterThan(0);
  });

  it('strips the synthetic @signal JID suffix before forwarding to the adapter', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    const bridge = new SignalConnection(adapter, port, makeSignalConfig(), 'test-instance');

    const result = await bridge.sendMedia('+15551234567@signal', {
      type: 'image',
      mimetype: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    } as any);
    expect(result).toHaveProperty('waMessageId');
    // The bridge strips @signal; the adapter sees the raw identifier.
    expect(port.sent[0].recipient).toBe('+15551234567');
  });
});
