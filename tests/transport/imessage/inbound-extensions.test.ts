// tests/transport/imessage/inbound-extensions.test.ts
//
// Coverage for inbound tapback-reaction routing — mirrors Signal's
// inbound-extensions.test.ts pattern. Before this change the iMessage
// adapter dropped every non-text envelope silently even though the
// `on('reaction')` listener was plumbed (adapter.ts:441) and the OUTBOUND
// port.sendReaction path was implemented (bluebubbles-port.ts:218).
//
// Read receipts and typing indicators remain out of scope here: read receipts
// ride on the original outbound message's `dateRead` field (needs cross-poll
// state diffing), typing indicators are push-only via BlueBubbles socket/SSE
// events and not surfaced by `/message/query`. Both deferred until streaming.

import { describe, it, expect } from 'vitest';
import {
  BlueBubblesPort,
  type BlueBubblesHttpClient,
  type BlueBubblesHttpRequest,
} from '../../../src/transport/imessage/bluebubbles-port.ts';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig, peerConversationRef } from './mock-port.ts';
import { makeChannelId, type ChannelId, type MessageRef } from '../../../src/core/transport-refs.ts';
import type { ImessageConfig } from '../../../src/transport/imessage/types.ts';
import type { InboundImessage } from '../../../src/transport/imessage/port.ts';
import type { ReactionEvent } from '../../../src/transport/contract/events.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ImessageConfig> = {}): ImessageConfig {
  return {
    ...makeImessageConfig(),
    backend: 'bluebubbles',
    bluebubblesUrl: 'https://bb.example.test',
    bluebubblesPassword: 'pw',
    sender: 'me@users.noreply.github.com',
    ...overrides,
  };
}

class MockHttpClient {
  readonly calls: BlueBubblesHttpRequest[] = [];
  private handler: ((req: BlueBubblesHttpRequest) => unknown) | null = null;

  reply(handler: (req: BlueBubblesHttpRequest) => unknown): this {
    this.handler = handler;
    return this;
  }

  client: BlueBubblesHttpClient = async (req) => {
    this.calls.push(req);
    if (!this.handler) throw new Error('no handler set');
    return this.handler(req);
  };
}

function bbMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: 'msg-1',
    text: 'hello',
    isFromMe: false,
    handle: { address: 'friend@users.noreply.github.com' },
    dateCreated: 1000,
    ...overrides,
  };
}

function peerMessageRef(channelId: ChannelId, peerId: string, guid: string): MessageRef {
  return { channel: channelId, conversation: peerId, id: guid };
}

// ---------------------------------------------------------------------------
// Port: BlueBubbles reaction surfacing
// ---------------------------------------------------------------------------

describe('BlueBubblesPort — reaction envelope surfacing', () => {
  it('surfaces an associated-message record with a string reactionType as kind:"reaction"', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'tap-1',
          text: null,
          associatedMessageGuid: 'orig-1',
          associatedMessageType: 'love',
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      guid: 'tap-1',
      kind: 'reaction',
      body: null,
      reactionEmoji: '❤️',
      reactionRemove: false,
      reactionTargetGuid: 'orig-1',
    });
  });

  it('maps the 6 named string reactionTypes to their canonical tapback emoji', async () => {
    const cases: Array<[string, string]> = [
      ['love', '❤️'],
      ['like', '👍'],
      ['dislike', '👎'],
      ['laugh', '😂'],
      ['emphasize', '‼️'],
      ['question', '❓'],
    ];
    for (const [typeName, emoji] of cases) {
      const mock = new MockHttpClient();
      mock.reply(() => ({
        data: [
          bbMsg({
            guid: `tap-${typeName}`,
            text: null,
            associatedMessageGuid: 'orig-x',
            associatedMessageType: typeName,
          }),
        ],
      }));
      const port = new BlueBubblesPort(makeConfig(), mock.client);
      const out = await port.listInboundSince(new Date(0));
      expect(out[0]?.kind, `reactionType ${typeName} should surface`).toBe('reaction');
      expect(out[0]?.reactionEmoji, `reactionType ${typeName} should map to ${emoji}`).toBe(emoji);
      expect(out[0]?.reactionRemove).toBe(false);
    }
  });

  it('treats a "-"-prefixed string reactionType as a removal tapback', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'tap-remove',
          text: null,
          associatedMessageGuid: 'orig-1',
          associatedMessageType: '-like',
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]).toMatchObject({
      kind: 'reaction',
      reactionEmoji: '👍',
      reactionRemove: true,
      reactionTargetGuid: 'orig-1',
    });
  });

  it('maps numeric iMessage chat.db associatedMessageType codes (2000-2005 add)', async () => {
    // Numeric codes from iMessage chat.db SUBMESSAGES_TYPE_TABLE.
    // 2000=love, 2001=like, 2002=dislike, 2003=laugh, 2004=emphasize, 2005=question.
    const cases: Array<[number, string]> = [
      [2000, '❤️'],
      [2001, '👍'],
      [2002, '👎'],
      [2003, '😂'],
      [2004, '‼️'],
      [2005, '❓'],
    ];
    for (const [code, emoji] of cases) {
      const mock = new MockHttpClient();
      mock.reply(() => ({
        data: [
          bbMsg({
            guid: `tap-${code}`,
            text: null,
            associatedMessageGuid: 'orig-x',
            associatedMessageType: code,
          }),
        ],
      }));
      const port = new BlueBubblesPort(makeConfig(), mock.client);
      const out = await port.listInboundSince(new Date(0));
      expect(out[0]?.kind, `code ${code} should surface as reaction`).toBe('reaction');
      expect(out[0]?.reactionEmoji, `code ${code} should map to ${emoji}`).toBe(emoji);
      expect(out[0]?.reactionRemove).toBe(false);
    }
  });

  it('maps numeric removal codes (3000-3005) with reactionRemove:true', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'tap-3000',
          text: null,
          associatedMessageGuid: 'orig-1',
          associatedMessageType: 3000, // love removal
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]).toMatchObject({
      kind: 'reaction',
      reactionEmoji: '❤️',
      reactionRemove: true,
    });
  });

  // Per the authoritative BlueBubbles MessageResponse (github.com/
  // BlueBubblesApp/bluebubbles-server README): associatedMessageType is
  // surfaced as `number | null` — NOT string. The string-form parsing
  // branches are defensive only and never execute against production data.
  it('treats associatedMessageType:0 as a non-reaction (code 0 is not in the tapback range)', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'msg-0',
          text: 'hi',
          associatedMessageGuid: 'orig-1',
          associatedMessageType: 0,
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.kind).toBe('text');
    expect(out[0]?.reactionTargetGuid).toBeUndefined();
  });

  it('treats null associatedMessageType as a non-reaction (per MessageResponse type)', async () => {
    // MessageResponse declares associatedMessageType as `number | null`.
    // null is the common case for non-reaction associated messages.
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'msg-null',
          text: 'associated but not a reaction',
          associatedMessageGuid: 'orig-1',
          associatedMessageType: null,
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.kind).toBe('text');
  });

  it('rejects non-integer numeric codes (corrupt data — schema is integer-only)', async () => {
    // The iMessage chat.db SUBMESSAGES_TYPE_TABLE is integer-only; a
    // fractional value is corrupt data. The parser must NOT misclassify
    // 2000.5 as reaction code 2000 (love) — it must fall through to text.
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'msg-float',
          text: 'corrupt',
          associatedMessageGuid: 'orig-1',
          associatedMessageType: 2000.5,
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.kind).toBe('text');
    expect(out[0]?.reactionTargetGuid).toBeUndefined();
  });

  it('rejects NaN associatedMessageType (corrupt data)', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'msg-nan',
          text: 'corrupt',
          associatedMessageGuid: 'orig-1',
          associatedMessageType: Number.NaN,
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.kind).toBe('text');
  });

  it('rejects negative associatedMessageType (no negative codes in the schema)', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'msg-neg',
          text: 'corrupt',
          associatedMessageGuid: 'orig-1',
          associatedMessageType: -2000,
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.kind).toBe('text');
  });

  it('rejects out-of-range high codes (e.g. 4000 — past the removal range)', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'msg-4000',
          text: 'unknown code',
          associatedMessageGuid: 'orig-1',
          associatedMessageType: 4000,
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.kind).toBe('text');
  });

  it('rejects associatedMessageType boundary values just outside the add range (1999 and 2006)', async () => {
    // Boundary integrity: 1999 < 2000 (excluded from add); 2006 > 2005 (excluded).
    for (const code of [1999, 2006, 2999, 3006]) {
      const mock = new MockHttpClient();
      mock.reply(() => ({
        data: [
          bbMsg({
            guid: `msg-${code}`,
            text: 'boundary',
            associatedMessageGuid: 'orig-1',
            associatedMessageType: code,
          }),
        ],
      }));
      const port = new BlueBubblesPort(makeConfig(), mock.client);
      const out = await port.listInboundSince(new Date(0));
      expect(out[0]?.kind, `code ${code} should NOT be a reaction`).toBe('text');
    }
  });

  it('falls back to text surfacing when associatedMessageGuid is set but associatedMessageType is unrecognized', async () => {
    // BlueBubbles sets associatedMessageGuid on a few non-reaction associations
    // (thread identifiers, etc.). These must NOT surface as reactions.
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [
        bbMsg({
          guid: 'thread-msg',
          text: 'thread reply',
          associatedMessageGuid: 'orig-1',
          associatedMessageType: 'thread',
        }),
      ],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]?.kind).toBe('text');
    expect(out[0]?.reactionTargetGuid).toBeUndefined();
  });

  it('still surfaces plain-text messages with kind:"text" (regression guard)', async () => {
    const mock = new MockHttpClient();
    mock.reply(() => ({
      data: [bbMsg({ guid: 'plain-1', text: 'hi' })],
    }));
    const port = new BlueBubblesPort(makeConfig(), mock.client);
    const out = await port.listInboundSince(new Date(0));
    expect(out[0]).toMatchObject({ guid: 'plain-1', kind: 'text', body: 'hi' });
    expect(out[0]?.reactionEmoji).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adapter: routing to on('reaction')
// ---------------------------------------------------------------------------

describe('ImessageAdapter — inbound reaction routing', () => {
  function makeAdapter(port: MockImessagePort = new MockImessagePort()) {
    const adapter = new ImessageAdapter(makeConfig(), port);
    return { adapter, port, channelId: makeChannelId('imessage', 'test') };
  }

  function reactionRecord(overrides: Partial<InboundImessage> = {}): InboundImessage {
    return {
      guid: 'tap-1',
      from: 'friend@users.noreply.github.com',
      to: '',
      chatGuid: undefined,
      body: null,
      fromMe: false,
      kind: 'reaction',
      timestamp: 1000,
      reactionEmoji: '❤️',
      reactionRemove: false,
      reactionTargetGuid: 'orig-1',
      ...overrides,
    };
  }

  it('routes a reaction record to the on("reaction") listener as a ReactionEvent', async () => {
    const { adapter, channelId } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    adapter.handleInboundRecord(reactionRecord());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      target: peerMessageRef(channelId, 'friend@users.noreply.github.com', 'orig-1'),
      actor: { channel: channelId, id: 'friend@users.noreply.github.com' },
      emoji: '❤️',
      removed: false,
    });
    expect(events[0]?.at).toEqual(new Date(1000));
    await adapter.disconnect();
  });

  it('does NOT emit a message event for a reaction record', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const messages: unknown[] = [];
    adapter.on('message', (m) => messages.push(m));

    adapter.handleInboundRecord(reactionRecord());

    expect(messages).toHaveLength(0);
    await adapter.disconnect();
  });

  it('projects a removal tapback as removed:true', async () => {
    const { adapter, channelId } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    adapter.handleInboundRecord(reactionRecord({ reactionRemove: true, reactionEmoji: '👍' }));

    expect(events[0]).toMatchObject({ emoji: '👍', removed: true });
    expect(events[0]?.target).toEqual(peerMessageRef(channelId, 'friend@users.noreply.github.com', 'orig-1'));
    await adapter.disconnect();
  });

  it('uses our own sender id for the actor when the reaction is an outbound echo (fromMe=true)', async () => {
    const { adapter, channelId } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    adapter.handleInboundRecord(
      reactionRecord({
        fromMe: true,
        from: '',
        to: 'friend@users.noreply.github.com',
      }),
    );

    expect(events).toHaveLength(1);
    // actor.id should be our own selfRef id (not the empty `from` field).
    expect(events[0]?.actor).toMatchObject({ channel: channelId });
    expect(events[0]?.actor.id).not.toBe('');
    await adapter.disconnect();
  });

  it('keys the reaction target by chat guid for group reactions', async () => {
    const { adapter, channelId } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    adapter.handleInboundRecord(
      reactionRecord({
        from: 'member-a@example.com',
        chatGuid: 'iMessage;+;chatGRP',
      }),
    );

    expect(events[0]?.target.conversation).toBe('iMessage;+;chatGRP');
    expect(events[0]?.target).toEqual(peerMessageRef(channelId, 'iMessage;+;chatGRP', 'orig-1'));
    await adapter.disconnect();
  });

  it('does not emit a reaction event when kind:"reaction" lacks reactionTargetGuid', async () => {
    // Defensive: a port that surfaces kind:"reaction" without the payload
    // fields (e.g. the imsg daemon in a future revision) should NOT trigger
    // a malformed ReactionEvent emit.
    const { adapter } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    adapter.handleInboundRecord(reactionRecord({ reactionTargetGuid: undefined }));

    expect(events).toHaveLength(0);
    await adapter.disconnect();
  });

  it('respects the dedupe set: the same reaction guid is never emitted twice', async () => {
    const { adapter } = makeAdapter();
    await adapter.connect();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    const rec = reactionRecord();
    adapter.handleInboundRecord(rec);
    adapter.handleInboundRecord(rec); // duplicate guid

    expect(events).toHaveLength(1);
    await adapter.disconnect();
  });

  it('drops reaction records when the adapter is disconnected', async () => {
    const { adapter } = makeAdapter();
    const events: ReactionEvent[] = [];
    adapter.on('reaction', (e) => events.push(e));

    await adapter.connect();
    await adapter.disconnect();
    adapter.handleInboundRecord(reactionRecord());

    expect(events).toHaveLength(0);
  });
});
