// History sync silently dropped on every relink under Baileys 7.0.0-rc12.
//
// rc12 added a self-only guard in `processMessage`: protocol messages such as
// HISTORY_SYNC_NOTIFICATION are dropped unless `key.fromMe` is true. But
// `decodeMessageNode` only set `fromMe` for a one-to-one stanza when a
// `recipient` attribute was present. Our own primary phone delivers history
// sync as a peer-routed stanza — `from` is our own PN/LID device and there is
// no `recipient` — so it decoded as `fromMe=false` and the guard dropped it
// with a `warn` that our error-level Baileys logger never shows. The notification
// envelopes were stored, but `messaging-history.set` never fired, so messages
// sent while a line was unlinked were never backfilled.
//
// Upstream fixed the decoder in 5ddc231 ("mark peer-routed self stanzas as
// fromMe"), released as 7.0.0-rc13. These tests drive the REAL vendored
// decoder and processMessage so a regression in the pin is caught here, and
// they pin the guard's other side: stanzas from anyone else must still drop.

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { proto } from '@whiskeysockets/baileys';

import { decodeMessageNode } from '../../node_modules/@whiskeysockets/baileys/lib/Utils/decode-wa-message.js';
import processMessage from '../../node_modules/@whiskeysockets/baileys/lib/Utils/process-message.js';

// Synthetic identities only: our companion device and its primary phone.
const ME_PN_USER = '15550001111';
const ME_LID_USER = '11111110001';
const ME_ID = `${ME_PN_USER}:7@s.whatsapp.net`;
const ME_LID = `${ME_LID_USER}:7@lid`;
const OTHER_PN = '15550002222@s.whatsapp.net';
const OTHER_LID = '11111110002@lid';
const GROUP = '120000000000000001@g.us';

interface StanzaAttrs {
  from: string;
  recipient?: string;
  participant?: string;
}

function stanza(attrs: StanzaAttrs) {
  return {
    tag: 'message',
    attrs: { id: 'SYNTHETIC0001', t: '1790000000', ...attrs },
    content: [],
  };
}

function decodedFromMe(attrs: StanzaAttrs): boolean | null | undefined {
  return decodeMessageNode(stanza(attrs), ME_ID, ME_LID).fullMessage.key.fromMe;
}

const silentLogger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silentLogger;
  },
};

function historyNotificationFrom(attrs: StanzaAttrs) {
  const { fullMessage } = decodeMessageNode(stanza(attrs), ME_ID, ME_LID);
  const inline = deflateSync(
    proto.HistorySync.encode({
      syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
      conversations: [],
    }).finish(),
  );
  return {
    key: fullMessage.key,
    messageTimestamp: 1790000000,
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
        historySyncNotification: {
          syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
          initialHistBootstrapInlinePayload: inline,
        },
      },
    },
  };
}

async function emittedEvents(attrs: StanzaAttrs): Promise<string[]> {
  const events: string[] = [];
  // Only the members processMessage touches on the history path are stubbed;
  // the full socket context types (signal creds, LID store internals) are not
  // exercised by a history notification.
  const context = {
    shouldProcessHistoryMsg: true,
    placeholderResendCache: undefined,
    ev: {
      emit: (name: string) => {
        events.push(name);
        return true;
      },
    },
    creds: { me: { id: ME_ID, lid: ME_LID }, processedHistoryMessages: [] },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async () => null,
        storeLIDPNMappings: async () => {},
      },
    },
    keyStore: { get: async () => ({}), set: async () => {} },
    logger: silentLogger,
    options: {},
    getMessage: async () => undefined,
  } as unknown as Parameters<typeof processMessage>[1];
  await processMessage(historyNotificationFrom(attrs), context);
  return events;
}

describe('decodeMessageNode: peer-routed self stanzas (no recipient)', () => {
  it.each([
    ['our primary LID', `${ME_LID_USER}@lid`],
    ['our primary PN', `${ME_PN_USER}@s.whatsapp.net`],
    ['a device-qualified self LID', `${ME_LID_USER}:3@lid`],
    ['a device-qualified self PN', `${ME_PN_USER}:3@s.whatsapp.net`],
  ])('marks a stanza from %s as fromMe', (_label, from) => {
    expect(decodedFromMe({ from })).toBe(true);
  });

  it.each([
    ['another PN', OTHER_PN],
    ['another LID', OTHER_LID],
  ])('keeps a stanza from %s as not fromMe', (_label, from) => {
    expect(decodedFromMe({ from })).toBe(false);
  });
});

describe('decodeMessageNode: unchanged neighbouring branches', () => {
  it('marks a self stanza with a recipient as fromMe', () => {
    expect(decodedFromMe({ from: `${ME_LID_USER}@lid`, recipient: OTHER_LID })).toBe(true);
  });

  it('still rejects a recipient-bearing stanza that is not from us', () => {
    expect(() => decodeMessageNode(stanza({ from: OTHER_PN, recipient: OTHER_LID }), ME_ID, ME_LID)).toThrow(
      /not from me/,
    );
  });

  it('marks our own group participant as fromMe and others as not', () => {
    expect(decodedFromMe({ from: GROUP, participant: `${ME_LID_USER}@lid` })).toBe(true);
    expect(decodedFromMe({ from: GROUP, participant: OTHER_LID })).toBe(false);
  });
});

describe('processMessage: self-only guard on history sync notifications', () => {
  it('emits messaging-history.set for a history notification from our own primary (incident shape)', async () => {
    expect(await emittedEvents({ from: `${ME_LID_USER}@lid` })).toContain('messaging-history.set');
  });

  it('still drops a history notification spoofed from another sender', async () => {
    expect(await emittedEvents({ from: OTHER_LID })).not.toContain('messaging-history.set');
  });
});
