import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock: @whiskeysockets/baileys — mirror the conventions of the
// neighboring tests/core/message-parser.test.ts so isJidGroup /
// jidNormalizedUser are deterministic and filesystem-free.
// ---------------------------------------------------------------------------
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@whiskeysockets/baileys');
  return {
    ...original,
    isJidGroup: (jid: string) => jid.endsWith('@g.us'),
    jidNormalizedUser: (jid: string) => {
      const colonIdx = jid.indexOf(':');
      const atIdx = jid.indexOf('@');
      if (colonIdx !== -1 && atIdx !== -1 && colonIdx < atIdx) {
        return jid.slice(0, colonIdx) + jid.slice(atIdx);
      }
      return jid;
    },
  };
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { parseIncomingMessage } from '../../src/core/message-parser.ts';

// ---------------------------------------------------------------------------
// Helpers — repo-hygiene fixtures only (reserved JID ranges).
//   Group JID:  120363555555550NNN@g.us
//   User JID:   1555NNNN@s.whatsapp.net  /  1111111N@s.whatsapp.net
// ---------------------------------------------------------------------------

function makeMsg(overrides: Record<string, unknown> = {}): any {
  return {
    key: {
      id: 'msg-br-001',
      remoteJid: '15551234@s.whatsapp.net',
      fromMe: false,
      participant: undefined,
    },
    pushName: 'Alice',
    messageTimestamp: BigInt(1700000000),
    message: {},
    ...overrides,
  };
}

function msgWith(messagePayload: Record<string, unknown>, overrides: Record<string, unknown> = {}): any {
  return makeMsg({ message: messagePayload, ...overrides });
}

// ===========================================================================
// VIDEO without caption — nullish-coalescing FALSE arms (L91-95)
// Existing tests cover video-without-caption WITH seconds/width/height
// present (the LHS-truthy arm). These hit the `?? null` / `?? '?'` arms by
// omitting every metadata field.
// ===========================================================================

describe('parseIncomingMessage — video metadata fallbacks (branch arms L91-95)', () => {
  it('video without caption AND without seconds/width/height → JSON nulls + "?s" summary', () => {
    const msg = msgWith({ videoMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('video');
    const parsed = JSON.parse(result.content!);
    expect(parsed).toEqual({ type: 'video', duration: null, width: null, height: null });
    // vm.seconds ?? '?' → the '?' arm
    expect(result.contentText).toBe('Video: ?s');
  });
});

// ===========================================================================
// DOCUMENT without caption — nullish fallback FALSE arms (L107-111)
// Existing tests always supply fileName; here every field is absent so
// fileName ?? null, mimetype ?? null, pageCount ?? null AND fileName ?? 'file'
// all take their RHS.
// ===========================================================================

describe('parseIncomingMessage — document metadata fallbacks (branch arms L107-111)', () => {
  it('document without caption AND without fileName/mimetype/pageCount → JSON nulls + "file" summary', () => {
    const msg = msgWith({ documentMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('document');
    const parsed = JSON.parse(result.content!);
    expect(parsed).toEqual({ type: 'document', fileName: null, mimetype: null, pageCount: null });
    // dm.fileName ?? 'file' → the 'file' arm
    expect(result.contentText).toBe('Document: file');
  });
});

// ===========================================================================
// STICKER — isAnimated ?? false FALSE arm (L130)
// Existing sticker tests pass isAnimated explicitly. Omit it so the `?? false`
// default arm fires. Also exercises the emoji-ternary false arm (no emoji).
// ===========================================================================

describe('parseIncomingMessage — sticker isAnimated default (branch arm L130)', () => {
  it('sticker without isAnimated → isAnimated defaults to false', () => {
    const msg = msgWith({ stickerMessage: { mimetype: 'image/webp' } });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('sticker');
    const parsed = JSON.parse(result.content!);
    expect(parsed.isAnimated).toBe(false);
    expect(parsed.emoji).toBeNull();
    expect(result.contentText).toBe('Sticker');
  });
});

// ===========================================================================
// LOCATION — degrees/name/address/url ?? null FALSE arms (L138-141)
// Existing location tests always supply lat/lng. A bare locationMessage hits
// every `?? null` RHS and the `name || address || 'shared'` 'shared' arm.
// ===========================================================================

describe('parseIncomingMessage — location fallbacks (branch arms L138-141)', () => {
  it('bare location → all JSON fields null, contentText falls back to "shared"', () => {
    const msg = msgWith({ locationMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('location');
    const parsed = JSON.parse(result.content!);
    expect(parsed).toEqual({
      type: 'location',
      latitude: null,
      longitude: null,
      name: null,
      address: null,
      url: null,
    });
    // lm.name || lm.address || 'shared' → the 'shared' arm
    expect(result.contentText).toContain('Location: shared');
  });
});

// ===========================================================================
// LIVE LOCATION — lat/lng/accuracy ?? 0 FALSE arms (L148-150)
// Existing live-location test supplies all three. A bare liveLocationMessage
// drives every `?? 0` default.
// ===========================================================================

describe('parseIncomingMessage — live location fallbacks (branch arms L148-150)', () => {
  it('bare live location → lat/lng/accuracy default to 0', () => {
    const msg = msgWith({ liveLocationMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('live_location');
    expect(result.content).toBe('Live location: 0, 0 (accuracy: 0m)');
    expect(result.contentText).toBe('Live location: 0, 0 (accuracy: 0m)');
  });
});

// ===========================================================================
// GROUP INVITE — entire branch + groupName/caption fallbacks (L154-160)
// No existing test exercises groupInviteMessage at all.
// ===========================================================================

describe('parseIncomingMessage — group invite (branch arms L154-160)', () => {
  it('group invite with name + caption → both concatenated', () => {
    const msg = msgWith({
      groupInviteMessage: { groupName: 'Book Club', caption: 'join us' },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('group_invite');
    // caption truthy → ` - ${caption}` arm
    expect(result.content).toBe('Group invite: Book Club - join us');
    expect(result.isResponseWorthy).toBe(true);
  });

  it('group invite without name or caption → defaults + no caption suffix', () => {
    const msg = msgWith({ groupInviteMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('group_invite');
    // groupName ?? 'Unknown group' arm; caption ?? '' arm; caption falsy → no suffix
    expect(result.content).toBe('Group invite: Unknown group');
  });
});

// ===========================================================================
// PRODUCT — entire branch + every fallback/ternary arm (L161-167)
// No existing test exercises productMessage. Two cases cover both the
// product-nested shape and the bare-defaults shape, plus the price ternary.
// ===========================================================================

describe('parseIncomingMessage — product (branch arms L161-167)', () => {
  it('product with nested .product, full fields → title/description/price rendered', () => {
    const msg = msgWith({
      productMessage: {
        product: {
          title: 'Widget',
          description: 'a fine widget',
          currencyCode: 'USD',
          priceAmount1000: 12500,
        },
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('product');
    // priceAmount1000 != null → Number/1000 arm (12500 -> 12.5);
    // description truthy → ` - ` arm; currencyCode/price truthy → ` (...)` arm.
    // Template is ` (${currencyCode} ${priceAmount})`.trim() — the leading space
    // is trimmed away, so there is NO space between the description and the paren.
    expect(result.content).toBe('Product: Widget - a fine widget(USD 12.5)');
    expect(result.isResponseWorthy).toBe(true);
  });

  it('bare productMessage (no nested product, no fields) → all defaults, no price suffix', () => {
    // productMessage.product is undefined → `?? innerMessage.productMessage` arm.
    const msg = msgWith({ productMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('product');
    // title ?? 'Unknown product'; description ?? '' (falsy → no ` - `);
    // currencyCode ?? '' and priceAmount1000 == null → '' (falsy → no ` (...)`)
    expect(result.content).toBe('Product: Unknown product');
  });
});

// ===========================================================================
// PIN IN CHAT — entire branch (L170-173)
// ===========================================================================

describe('parseIncomingMessage — pin in chat (branch arm L170)', () => {
  it('pinInChatMessage → fixed "Pinned a message" content', () => {
    const msg = msgWith({ pinInChatMessage: { key: {}, type: 1 } });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('pin');
    expect(result.content).toBe('Pinned a message');
    expect(result.contentText).toBe('Pinned a message');
  });
});

// ===========================================================================
// INTERACTIVE — entire branch + body/type fallbacks (L174-178)
// ===========================================================================

describe('parseIncomingMessage — interactive (branch arms L174-178)', () => {
  it('interactive with body.text → uses body text', () => {
    const msg = msgWith({
      interactiveMessage: { body: { text: 'Choose an option' }, type: 'native_flow' },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('interactive');
    // bodyText truthy → bodyText arm of `bodyText || type`
    expect(result.content).toBe('Interactive: Choose an option');
  });

  it('interactive without body, with type → falls back to type', () => {
    const msg = msgWith({ interactiveMessage: { type: 'shop' } });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('interactive');
    // body?.text → null (bodyText ?? null arm); bodyText falsy → type arm
    expect(result.content).toBe('Interactive: shop');
  });

  it('interactive without body or type → "interactive" default', () => {
    const msg = msgWith({ interactiveMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('interactive');
    // im.type ?? 'interactive' arm; bodyText falsy → type ('interactive')
    expect(result.content).toBe('Interactive: interactive');
  });
});

// ===========================================================================
// CONTACT — displayName/vcard ?? null FALSE arms (L185-188)
// Existing contact tests always supply displayName + vcard. A bare
// contactMessage drives the `?? null` RHS arms and the "Unknown" fallback.
// ===========================================================================

describe('parseIncomingMessage — contact fallbacks (branch arms L185-188)', () => {
  it('bare contact → displayName/vcard null, contentText "Unknown"', () => {
    const msg = msgWith({ contactMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('contact');
    const parsed = JSON.parse(result.content!);
    expect(parsed).toEqual({ type: 'contact', displayName: null, vcard: null });
    // cm.displayName ?? 'Unknown' arm
    expect(result.contentText).toBe('Contact: Unknown');
  });
});

// ===========================================================================
// CONTACTS ARRAY — per-contact displayName/vcard ?? null (L191-193) + empty list
// Existing array test supplies full contacts. Cover the per-item `?? null`
// arms and the empty-contacts (`?? []`) default.
// ===========================================================================

describe('parseIncomingMessage — contacts array fallbacks (branch arms L191-193)', () => {
  it('contacts array with bare entries → per-item nulls', () => {
    const msg = msgWith({ contactsArrayMessage: { contacts: [{}] } });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('contact');
    const parsed = JSON.parse(result.content!);
    expect(parsed.contacts).toEqual([{ displayName: null, vcard: null }]);
  });

  it('contactsArrayMessage without contacts field → empty array default', () => {
    const msg = msgWith({ contactsArrayMessage: {} });
    const result = parseIncomingMessage(msg)!;
    const parsed = JSON.parse(result.content!);
    expect(parsed.contacts).toEqual([]);
    expect(result.contentText).toBe('Contacts: ');
  });
});

// ===========================================================================
// POLL — name/options/selectableCount ?? fallbacks (L203-210)
// Existing poll tests supply name + options + selectableOptionCount. A bare
// pollCreationMessage drives `options ?? []`, `name ?? null`,
// `selectableOptionCount ?? null`, and `name ?? 'Unnamed'`.
// ===========================================================================

describe('parseIncomingMessage — poll fallbacks (branch arms L203-210)', () => {
  it('bare poll → name null, options empty, selectableCount null, "Unnamed" summary', () => {
    const msg = msgWith({ pollCreationMessage: {} });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('poll');
    const parsed = JSON.parse(result.content!);
    expect(parsed).toEqual({ type: 'poll', name: null, options: [], selectableCount: null });
    // pm.name ?? 'Unnamed' arm + options.length (0)
    expect(result.contentText).toBe('Poll: Unnamed — 0 options');
  });
});

// ===========================================================================
// isFromMe / isGroup defaults (L278 binary-expr arm) + DM-fromMe sender path
// L278: isJidGroup(remoteJid) ?? false — DM remoteJid yields false (LHS),
// so the `?? false` RHS only fires if isJidGroup returns nullish. With our
// mock isJidGroup always returns a boolean, so see UNREACHABLE note below.
// This test still pins the fromMe DM sender-resolution path (L224-227),
// where rawSenderJid falls back to remoteJid.
// ===========================================================================

describe('parseIncomingMessage — fromMe DM sender resolution', () => {
  it('fromMe DM with no participant → senderJid falls back to remoteJid', () => {
    const msg = msgWith(
      { conversation: 'self note' },
      {
        key: {
          id: 'self-001',
          remoteJid: '15551234@s.whatsapp.net',
          fromMe: true,
          participant: undefined,
        },
      },
    );
    const result = parseIncomingMessage(msg)!;
    expect(result.isFromMe).toBe(true);
    expect(result.isGroup).toBe(false);
    expect(result.senderJid).toBe('15551234@s.whatsapp.net');
  });
});

// ===========================================================================
// senderName fallback — LID JID with no pushName (L233 condition)
// Existing test covers personal-JID phone fallback. Here a LID sender with no
// pushName must leave senderName null (isLidJid true → skip bareNumber).
// ===========================================================================

describe('parseIncomingMessage — LID sender name handling (branch arm L233)', () => {
  it('LID sender with no pushName → senderName stays null (no phone fallback)', () => {
    const msg = msgWith(
      { conversation: 'group hello' },
      {
        key: {
          id: 'lid-001',
          remoteJid: '120363555555550001@g.us',
          fromMe: false,
          participant: '11111111@lid',
        },
        pushName: undefined,
      },
    );
    const result = parseIncomingMessage(msg)!;
    // isLidJid(senderJid) true → bareNumber phone fallback skipped → name null,
    // while the LID itself is preserved as the resolved senderJid.
    expect({ senderName: result.senderName, senderJid: result.senderJid, isGroup: result.isGroup }).toEqual({
      senderName: null,
      senderJid: '11111111@lid',
      isGroup: true,
    });
  });
});

// ---------------------------------------------------------------------------
// UNREACHABLE branch arms flagged for /* v8 ignore */:
//
// 1. L237 `bareNumber(senderJid) ?? null` — RHS (arm#1) is UNREACHABLE.
//    bareNumber() (src/core/jid-constants.ts) ALWAYS returns a string (the
//    local part, or the whole input when no '@'); it never returns
//    null/undefined, so the `?? null` right-hand arm cannot fire.
//    // UNREACHABLE — recommend /* v8 ignore */: bareNumber never returns nullish.
//
// 2. L278 `isJidGroup(msg.key.remoteJid!) ?? false` — RHS (arm#1) is
//    UNREACHABLE in practice. Baileys' isJidGroup returns a boolean (the mock
//    also returns boolean), so `?? false` never takes its right arm.
//    // UNREACHABLE — recommend /* v8 ignore */: isJidGroup returns a boolean, never nullish.
// ---------------------------------------------------------------------------
