// tests/transport/signal/adapter-inbound-media.test.ts
// inbound attachment surface + fetchAttachment.
//
// Proves:
//   1. An inbound `data` envelope carrying signal-cli attachments produces an
//      InboundMessage whose `attachments` field is non-empty and well-formed
//      (AttachmentRef: id=path, kind, mime, sizeBytes, filename).
//   2. Outbound `sync` echoes carry attachments too (so the durability engine
//      can reconcile media sends the same way it does text).
//   3. The kind taxonomy is MIME-driven: image/png → 'image', video/mp4 →
//      'video', audio/mpeg → 'audio', application/pdf → 'document'.
//   4. fetchAttachment reads bytes from disk for a path inside the configured
//      attachmentsDataDir and returns them with the sniffed MIME.
//   5. fetchAttachment fails closed with PermanentProviderError when:
//        (a) attachmentsDataDir is unset
//        (b) the requested path escapes the data dir (path traversal)
//        (c) the file does not exist
//   6. signal-cli-port's normalizeEnvelope surfaces attachments on data+sync
//      envelopes (port-level InboundSignal.attachments is populated from the
//      raw RPC envelope's dataMessage.attachments / syncMessage.attachments).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import type { InboundMessage } from '../../../src/transport/contract/index.ts';
import type { InboundSignal, InboundAttachment } from '../../../src/transport/signal/port.ts';
import { isMediaCapable } from '../../../src/transport/contract/extensions.ts';
import { normalizeEnvelope } from '../../../src/transport/signal/signal-cli-port.ts';

function envelope(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    timestamp: 1000,
    source: '01234567-89ab-cdef-0123-456789abcdef',
    destination: 'fedcba98-7654-3210-fedc-ba9876543210',
    body: 'hello',
    fromMe: false,
    type: 'data',
    ...overrides,
  };
}

function att(overrides: Partial<InboundAttachment> = {}): InboundAttachment {
  return {
    storedFilename: '/tmp/signal-attachments/abc.png',
    contentType: 'image/png',
    size: 4096,
    ...overrides,
  };
}

describe('SignalAdapter — inbound attachments', () => {
  it('is media-capable (isMediaCapable → true)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(isMediaCapable(adapter)).toBe(true);
  });

  it('surfaces dataMessage.attachments on InboundMessage.attachments with correct AttachmentRef shape', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    const atts: InboundAttachment[] = [
      att({ storedFilename: '/data/dir/abc.png', contentType: 'image/png', size: 1024, filename: 'photo.png' }),
    ];
    adapter.handleInboundRecord(envelope({
      body: 'look',
      timestamp: 999,
      attachments: atts,
    }));

    expect(received).toHaveLength(1);
    expect(received[0].attachments).toHaveLength(1);
    const a = received[0].attachments[0];
    expect(a.id).toBe('/data/dir/abc.png');
    expect(a.kind).toBe('image');
    expect(a.mime).toBe('image/png');
    expect(a.sizeBytes).toBe(1024);
    expect(a.filename).toBe('photo.png');
    await adapter.disconnect();
  });

  it('maps video/mp4 → video kind', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({
      timestamp: 1001,
      attachments: [att({ storedFilename: '/data/x.mp4', contentType: 'video/mp4', size: 5 })],
    }));
    expect(received[0].attachments[0].kind).toBe('video');
    await adapter.disconnect();
  });

  it('maps audio/mpeg → audio kind', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({
      timestamp: 1002,
      attachments: [att({ storedFilename: '/data/x.mp3', contentType: 'audio/mpeg', size: 5 })],
    }));
    expect(received[0].attachments[0].kind).toBe('audio');
    await adapter.disconnect();
  });

  it('maps application/pdf → document kind', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({
      timestamp: 1003,
      attachments: [att({ storedFilename: '/data/x.pdf', contentType: 'application/pdf', size: 5 })],
    }));
    expect(received[0].attachments[0].kind).toBe('document');
    await adapter.disconnect();
  });

  it('carries attachments on outbound sync echoes too', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({
      timestamp: 1004,
      fromMe: true,
      type: 'sync',
      body: null,
      attachments: [att({ storedFilename: '/data/echo.jpg', contentType: 'image/jpeg', size: 9 })],
    }));
    expect(received).toHaveLength(1);
    expect(received[0].fromMe).toBe(true);
    expect(received[0].attachments).toHaveLength(1);
    expect(received[0].attachments[0].kind).toBe('image');
    await adapter.disconnect();
  });

  it('emits an empty attachments array when the envelope has no attachments', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    const received: InboundMessage[] = [];
    adapter.on('message', (m) => received.push(m));

    adapter.handleInboundRecord(envelope({ timestamp: 1005 }));
    expect(received[0].attachments).toEqual([]);
    await adapter.disconnect();
  });
});

describe('signal-cli-port normalizeEnvelope — attachments passthrough', () => {
  it('surfaces dataMessage.attachments on the data envelope', () => {
    const env = {
      sourceUuid: 'aaa',
      timestamp: 1,
      dataMessage: {
        message: 'hi',
        attachments: [
          { storedFilename: '/data/x.png', contentType: 'image/png', size: 10, filename: 'x.png' },
        ],
      },
    };
    const out = normalizeEnvelope(env as any, '+1555');
    expect(out).not.toBeNull();
    expect(out!.attachments).toHaveLength(1);
    expect(out!.attachments![0]).toEqual({
      storedFilename: '/data/x.png',
      contentType: 'image/png',
      size: 10,
      filename: 'x.png',
    });
  });

  it('surfaces syncMessage.sentMessage.attachments on the sync echo', () => {
    const env = {
      sourceUuid: 'self',
      timestamp: 2,
      syncMessage: {
        sentMessage: {
          message: null,
          timestamp: 2,
          attachments: [
            { storedFilename: '/data/y.jpg', contentType: 'image/jpeg', size: 20 },
          ],
        },
      },
    };
    const out = normalizeEnvelope(env as any, '+1555');
    expect(out).not.toBeNull();
    expect(out!.type).toBe('sync');
    expect(out!.fromMe).toBe(true);
    expect(out!.attachments).toHaveLength(1);
    expect(out!.attachments![0].storedFilename).toBe('/data/y.jpg');
  });

  it('drops malformed attachment entries (missing storedFilename)', () => {
    const env = {
      sourceUuid: 'aaa',
      timestamp: 3,
      dataMessage: {
        message: 'hi',
        attachments: [
          { storedFilename: '/data/ok.png', contentType: 'image/png', size: 1 },
          { contentType: 'image/png', size: 1 }, // no storedFilename → drop
        ],
      },
    };
    const out = normalizeEnvelope(env as any, '+1555');
    expect(out!.attachments).toHaveLength(1);
  });

  it('omits the attachments field when dataMessage has no attachments array', () => {
    const env = {
      sourceUuid: 'aaa',
      timestamp: 4,
      dataMessage: { message: 'plain text' },
    };
    const out = normalizeEnvelope(env as any, '+1555');
    expect(out!).not.toHaveProperty('attachments');
  });
});

describe('SignalAdapter — fetchAttachment', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'signal-att-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('reads bytes from disk for a path inside attachmentsDataDir and returns them with the sniffed MIME', async () => {
    const dir = join(tmpRoot, 'attachments');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'photo.png');
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(filePath, content);

    const adapter = new SignalAdapter(
      makeSignalConfig({ attachmentsDataDir: tmpRoot }),
      new MockSignalPort(),
    );
    await adapter.connect();

    const bytes = await adapter.fetchAttachment({
      id: filePath,
      kind: 'image',
      mime: 'image/png',
      sizeBytes: content.byteLength,
    });
    expect(bytes.bytes).toEqual(new Uint8Array(content));
    expect(bytes.mime).toBe('image/png');
    await adapter.disconnect();
  });

  it('fails closed with PermanentProviderError when attachmentsDataDir is unset', async () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    await adapter.connect();
    await expect(
      adapter.fetchAttachment({ id: '/tmp/whatever.png', kind: 'image', mime: 'image/png' }),
    ).rejects.toThrow(/attachmentsDataDir|signal-cli data dir/i);
    await adapter.disconnect();
  });

  it('fails closed with PermanentProviderError on path traversal (escapes attachmentsDataDir)', async () => {
    const adapter = new SignalAdapter(
      makeSignalConfig({ attachmentsDataDir: join(tmpRoot, 'safe') }),
      new MockSignalPort(),
    );
    await adapter.connect();
    // Try to escape via .. — the resolved path lands outside `safe`.
    await expect(
      adapter.fetchAttachment({
        id: join(tmpRoot, 'safe', '..', '..', 'etc', 'passwd'),
        kind: 'document',
        mime: 'text/plain',
      }),
    ).rejects.toThrow(/escapes attachmentsDataDir/i);
    await adapter.disconnect();
  });

  it('fails closed with PermanentProviderError when the file does not exist', async () => {
    const adapter = new SignalAdapter(
      makeSignalConfig({ attachmentsDataDir: tmpRoot }),
      new MockSignalPort(),
    );
    await adapter.connect();
    await expect(
      adapter.fetchAttachment({
        id: join(tmpRoot, 'missing.png'),
        kind: 'image',
        mime: 'image/png',
      }),
    ).rejects.toThrow(/failed to read attachment/i);
    await adapter.disconnect();
  });
});
