// tests/transport/signal/adapter-voice.test.ts
// voice notes (SupportsVoiceNotes).
//
// The spec (signal-and-imessage-transports-spec.md §3a) marks voice-notes
// as "deferred" with the rationale "Signal voice is opus-only". This is true
// of the official Signal clients, but signal-cli's `send` RPC accepts any
// MIME allowlisted as an attachment — including audio/opus, audio/aac, and
// audio/mpeg. We surface voice-notes as an audio attachment with a derived
// `.opus` filename and treat ptt (push-to-talk) as the default (Signal voice
// notes are always ptt-style).
//
// This file proves:
//   1. capabilities.extensions includes 'voice-notes' (isVoiceCapable → true)
//   2. sendVoiceNote encodes audio as a signal-cli attachment with audio MIME
//   3. sendVoiceNote rejects with a typed error when MIME is not audio/*
//   4. sendVoiceNote rejects when payload exceeds the media size cap

import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import { isVoiceCapable } from '../../../src/transport/contract/extensions.ts';
import type { VoicePayload } from '../../../src/transport/contract/commands.ts';

describe('SignalAdapter — voice-notes capabilities', () => {
  it('declares the voice-notes extension (isVoiceCapable → true)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(isVoiceCapable(adapter)).toBe(true);
    expect(adapter.capabilities.extensions.has('voice-notes')).toBe(true);
  });
});

describe('SignalAdapter — sendVoiceNote', () => {
  it('encodes an opus VoicePayload as an audio attachment', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const audio: VoicePayload = {
      bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), // 'OggS' magic
      mime: 'audio/opus',
      durationSec: 5,
    };
    const result = await adapter.sendVoiceNote(
      { channel: adapter.capabilities.channel, id: '+15551234567' },
      audio,
    );
    expect(result).toHaveProperty('id');
    expect(port.sent).toHaveLength(1);
    const att = port.sent[0].attachments?.[0] as string;
    expect(att).toMatch(/^data:audio\/opus;filename=[^;]+\.opus;base64,/);
  });

  it('rejects with a typed error when MIME is not audio/*', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const bad: VoicePayload = {
      bytes: new Uint8Array([0xff, 0xd8]),
      mime: 'image/jpeg',
    };
    await expect(
      adapter.sendVoiceNote({ channel: adapter.capabilities.channel, id: '+15551234567' }, bad),
    ).rejects.toThrow(/audio|voice|not.*audio/i);
    expect(port.sent).toHaveLength(0);
  });

  it('rejects when payload exceeds the media size cap', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();
    const cap = adapter.capabilities.media.maxBytes;

    const oversized: VoicePayload = {
      bytes: new Uint8Array(cap + 1),
      mime: 'audio/opus',
    };
    await expect(
      adapter.sendVoiceNote({ channel: adapter.capabilities.channel, id: '+15551234567' }, oversized),
    ).rejects.toThrow(/size|maxBytes|too large|exceeds/i);
    expect(port.sent).toHaveLength(0);
  });

  it('routes to a group when target id is a base64 V2 group id', async () => {
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig(), port);
    await adapter.connect();

    const groupId = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
    const audio: VoicePayload = { bytes: new Uint8Array([0x4f, 0x67]), mime: 'audio/opus' };
    await adapter.sendVoiceNote({ channel: adapter.capabilities.channel, id: groupId }, audio);
    expect(port.sent[0].groupId).toBe(groupId);
    expect(port.sent[0].recipient).toBeUndefined();
  });
});
