import { describe, expect, it } from 'vitest';
import { reconstructReplayableInbound } from '../../../src/runtimes/agent/inbound-replay.ts';
import type { ReplayableInboundRow } from '../../../src/core/durability.ts';

function row(overrides: Partial<ReplayableInboundRow> = {}): ReplayableInboundRow {
  return {
    seq: 41,
    message_id: 'msg-41',
    conversation_key: '15551234567',
    chat_jid: '15551234567@s.whatsapp.net',
    processing_status: 'pending',
    routed_to: 'agentruntime',
    received_at: '2026-07-22 18:00:00',
    sender_jid: '15551234567@s.whatsapp.net',
    sender_name: 'Owner',
    content: 'continue the active lane',
    content_text: null,
    content_type: 'text',
    timestamp: 1_784_744_000,
    quoted_message_id: null,
    raw_message: null,
    ...overrides,
  };
}

describe('agent inbound restart reconstruction', () => {
  it('re-enters pending input through full preprocessing with its original journal identity', () => {
    expect(reconstructReplayableInbound(row())).toStrictEqual({
      messageId: 'msg-41',
      chatJid: '15551234567@s.whatsapp.net',
      senderJid: '15551234567@s.whatsapp.net',
      senderName: 'Owner',
      content: 'continue the active lane',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: 1_784_744_000,
      quotedMessageId: null,
      isResponseWorthy: true,
      rawMessage: undefined,
      durableAdmission: 'pending',
      inboundSeq: 41,
    });
  });

  it('marks queued input as a prepared replay so preprocessing is not duplicated', () => {
    expect(reconstructReplayableInbound(row({ processing_status: 'queued' })))
      .toMatchObject({ durableAdmission: 'queued_replay', inboundSeq: 41 });
  });

  it('fails closed for prepared media and corrupt pending raw envelopes', () => {
    expect(() => reconstructReplayableInbound(row({
      processing_status: 'queued',
      content_type: 'image',
    }))).toThrow(/cannot be reconstructed exactly/);
    expect(() => reconstructReplayableInbound(row({
      processing_status: 'pending',
      content_type: 'image',
      raw_message: '{broken',
    }))).toThrow(SyntaxError);
  });
});
