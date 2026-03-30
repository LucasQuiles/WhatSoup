import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['18459780919']),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
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

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import type { IncomingMessage } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIncomingMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-001',
    chatJid: '15551234567@s.whatsapp.net',
    senderJid: '15551234567@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: 1700000000,
    quotedMessageId: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isAdminMessage
// ---------------------------------------------------------------------------

describe('isAdminMessage — positive', () => {
  it('returns true when senderJid matches adminPhones and message is a DM', () => {
    const msg = makeIncomingMsg({ senderJid: '18459780919@s.whatsapp.net', isGroup: false });
    expect(isAdminMessage(msg)).toBe(true);
  });

  it('returns true for LID-format admin phone', async () => {
    // The mock config uses a Set — add a LID number for this test
    const { config } = await import('../../src/config.ts');
    config.adminPhones.add('16566225768547');
    const msg = makeIncomingMsg({ senderJid: '16566225768547@lid', isGroup: false });
    expect(isAdminMessage(msg)).toBe(true);
    config.adminPhones.delete('16566225768547');
  });
});

describe('isAdminMessage — negative', () => {
  it('returns false for non-admin phone DM', () => {
    const msg = makeIncomingMsg({ senderJid: '15559998888@s.whatsapp.net', isGroup: false });
    expect(isAdminMessage(msg)).toBe(false);
  });

  it('returns false when admin phone sends from a group', () => {
    const msg = makeIncomingMsg({ senderJid: '18459780919@s.whatsapp.net', isGroup: true });
    expect(isAdminMessage(msg)).toBe(false);
  });

  it('returns false for completely different sender', () => {
    const msg = makeIncomingMsg({ senderJid: '15550001111@s.whatsapp.net', isGroup: false });
    expect(isAdminMessage(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand — phone subjects
// ---------------------------------------------------------------------------

describe('parseAdminCommand — phone positive', () => {
  it('parses ALLOW command', () => {
    expect(parseAdminCommand('ALLOW 15184194479')).toEqual({ action: 'allow', subjectType: 'phone', subjectId: '15184194479' });
  });

  it('parses BLOCK command', () => {
    expect(parseAdminCommand('BLOCK 15184194479')).toEqual({ action: 'block', subjectType: 'phone', subjectId: '15184194479' });
  });

  it('is case insensitive', () => {
    expect(parseAdminCommand('allow 15184194479')).toEqual({ action: 'allow', subjectType: 'phone', subjectId: '15184194479' });
    expect(parseAdminCommand('Block 15184194479')).toEqual({ action: 'block', subjectType: 'phone', subjectId: '15184194479' });
  });

  it('handles trailing whitespace', () => {
    expect(parseAdminCommand('ALLOW 15184194479   ')).toEqual({ action: 'allow', subjectType: 'phone', subjectId: '15184194479' });
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand — group subjects
// ---------------------------------------------------------------------------

// @check CHK-078
// @traces REQ-013.AC-05
describe('parseAdminCommand — group positive', () => {
  it('parses ALLOW GROUP command', () => {
    expect(parseAdminCommand('ALLOW GROUP 120363123456789@g.us')).toEqual({
      action: 'allow',
      subjectType: 'group',
      subjectId: '120363123456789@g.us',
    });
  });

  it('parses BLOCK GROUP command', () => {
    expect(parseAdminCommand('BLOCK GROUP 120363987654321@g.us')).toEqual({
      action: 'block',
      subjectType: 'group',
      subjectId: '120363987654321@g.us',
    });
  });

  it('is case insensitive for GROUP keyword', () => {
    expect(parseAdminCommand('allow group 120363111111@g.us')).toEqual({
      action: 'allow',
      subjectType: 'group',
      subjectId: '120363111111@g.us',
    });
  });

  it('handles trailing whitespace for GROUP command', () => {
    expect(parseAdminCommand('ALLOW GROUP 120363111111@g.us   ')).toEqual({
      action: 'allow',
      subjectType: 'group',
      subjectId: '120363111111@g.us',
    });
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand — negative
// ---------------------------------------------------------------------------

describe('parseAdminCommand — negative', () => {
  it('returns null for no phone', () => { expect(parseAdminCommand('ALLOW')).toBeNull(); });
  it('returns null for empty string', () => { expect(parseAdminCommand('')).toBeNull(); });
  it('returns null for unknown command', () => { expect(parseAdminCommand('GRANT 123')).toBeNull(); });
  it('returns null for non-digits in phone', () => { expect(parseAdminCommand('ALLOW +1-518')).toBeNull(); });
  it('returns null for random text', () => { expect(parseAdminCommand('hello world')).toBeNull(); });
  it('returns null for GROUP with no jid', () => { expect(parseAdminCommand('ALLOW GROUP')).toBeNull(); });
});

// ---------------------------------------------------------------------------
// Non-admin gate
// ---------------------------------------------------------------------------

describe('Non-admin cannot trigger admin commands', () => {
  it('isAdminMessage rejects non-admin sender', () => {
    expect(isAdminMessage(makeIncomingMsg({ senderJid: '15550000000@s.whatsapp.net', isGroup: false }))).toBe(false);
  });

  it('isAdminMessage rejects group messages from admin', () => {
    expect(isAdminMessage(makeIncomingMsg({ senderJid: '18459780919@s.whatsapp.net', isGroup: true }))).toBe(false);
  });
});
