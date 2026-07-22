import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    transport: 'baileys',
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
import { config } from '../../src/config.ts';
import type { IncomingMessage } from '../../src/core/types.ts';
import type { Database } from '../../src/core/database.ts';

// Minimal mock DB for resolvePhoneFromJid -- lid_mappings table queries
function makeMockDb(lidMap: Record<string, string> = {}): Database {
  return {
    raw: {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn((lid: string) => {
          if (sql.includes('lid_mappings') && lidMap[lid]) {
            return { phone_jid: `${lidMap[lid]}@s.whatsapp.net` };
          }
          return undefined;
        }),
        run: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}
const mockDb = makeMockDb();

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
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isAdminMessage
// ---------------------------------------------------------------------------

describe('isAdminMessage -- positive', () => {
  it('returns true when senderJid matches adminPhones and message is a DM', () => {
    const msg = makeIncomingMsg({ senderJid: '15550100001@s.whatsapp.net', isGroup: false });
    expect(isAdminMessage(msg, mockDb)).toBe(true);
  });

  it('returns true for LID-format admin phone when LID is mapped', async () => {
    const { config } = await import('../../src/config.ts');
    config.adminPhones.add('15550100002');
    // Create a DB that maps the LID to the admin phone
    const dbWithLid = makeMockDb({ '99999999999': '15550100002' });
    const msg = makeIncomingMsg({ senderJid: '99999999999@lid', isGroup: false });
    expect(isAdminMessage(msg, dbWithLid)).toBe(true);
    config.adminPhones.delete('15550100002');
  });
});

describe('isAdminMessage -- QR-143 cross-transport admin spoof guard', () => {
  it('rejects an @sms sender whose bare number equals an admin phone (spoofable transport)', () => {
    // The Twilio-bridged sender resolves to the same bare phone ('15550100001')
    // as the WhatsApp admin, but its SMS sender-ID is spoofable — must NOT be admin.
    const msg = makeIncomingMsg({ senderJid: '15550100001@sms', isGroup: false });
    expect(isAdminMessage(msg, mockDb)).toBe(false);
  });

  it('still accepts the same admin number over the WhatsApp-authenticated transport (no regression)', () => {
    const msg = makeIncomingMsg({ senderJid: '15550100001@s.whatsapp.net', isGroup: false });
    expect(isAdminMessage(msg, mockDb)).toBe(true);
  });

  it('accepts an exact configured Signal UUID and rejects a prefixed lookalike', async () => {
    const { config } = await import('../../src/config.ts');
    const uuid = '01234567-8901-2345-6789-012345678901';
    config.adminPhones.add(uuid);
    const mutableConfig = config as unknown as { transport: string };
    const originalTransport = mutableConfig.transport;
    mutableConfig.transport = 'signal';
    try {
      expect(isAdminMessage(makeIncomingMsg({
        senderJid: `${uuid}@signal`,
        isGroup: false,
      }), mockDb)).toBe(true);
      expect(isAdminMessage(makeIncomingMsg({
        senderJid: `x${uuid}@signal`,
        isGroup: false,
      }), mockDb)).toBe(false);
    } finally {
      mutableConfig.transport = originalTransport;
      config.adminPhones.delete(uuid);
    }
  });

  it.each([
    ['baileys', '+1-555-010-0001@s.whatsapp.net', new Set(['15550100001'])],
    ['signal', '+1-555-010-0001@signal', new Set(['+15550100001'])],
    ['imessage', '+1-555-010-0001@imessage', new Set(['+15550100001'])],
  ])('rejects malformed admin locals for %s', (transport, senderJid, adminPhones) => {
    const previousTransport = config.transport;
    const previousAdmins = config.adminPhones;
    (config as unknown as { transport: string }).transport = transport;
    (config as unknown as { adminPhones: Set<string> }).adminPhones = adminPhones;
    try {
      expect(isAdminMessage(makeIncomingMsg({ senderJid, isGroup: false }), mockDb)).toBe(false);
    } finally {
      (config as unknown as { transport: string }).transport = previousTransport;
      (config as unknown as { adminPhones: Set<string> }).adminPhones = previousAdmins;
    }
  });
});

describe('isAdminMessage -- negative', () => {
  it('returns false for non-admin phone DM', () => {
    const msg = makeIncomingMsg({ senderJid: '15559998888@s.whatsapp.net', isGroup: false });
    expect(isAdminMessage(msg, mockDb)).toBe(false);
  });

  it('returns false when admin phone sends from a group', () => {
    const msg = makeIncomingMsg({ senderJid: '15550100001@s.whatsapp.net', isGroup: true });
    expect(isAdminMessage(msg, mockDb)).toBe(false);
  });

  it('returns false for completely different sender', () => {
    const msg = makeIncomingMsg({ senderJid: '15550001111@s.whatsapp.net', isGroup: false });
    expect(isAdminMessage(msg, mockDb)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand -- phone subjects
// ---------------------------------------------------------------------------

describe('parseAdminCommand -- phone positive', () => {
  it('parses ALLOW command', () => {
    expect(parseAdminCommand('ALLOW 15551230008')).toEqual({ action: 'allow', subjectType: 'phone', subjectId: '15551230008' });
  });

  it('parses BLOCK command', () => {
    expect(parseAdminCommand('BLOCK 15551230008')).toEqual({ action: 'block', subjectType: 'phone', subjectId: '15551230008' });
  });

  it('is case insensitive', () => {
    expect(parseAdminCommand('allow 15551230008')).toEqual({ action: 'allow', subjectType: 'phone', subjectId: '15551230008' });
    expect(parseAdminCommand('Block 15551230008')).toEqual({ action: 'block', subjectType: 'phone', subjectId: '15551230008' });
  });

  it('handles trailing whitespace', () => {
    expect(parseAdminCommand('ALLOW 15551230008   ')).toEqual({ action: 'allow', subjectType: 'phone', subjectId: '15551230008' });
  });

  it('parses Signal E.164 and UUID subjects without changing their identity', async () => {
    expect(parseAdminCommand('ALLOW +15551230008')).toEqual({
      action: 'allow', subjectType: 'phone', subjectId: '+15551230008',
    });
    const { config } = await import('../../src/config.ts');
    const mutableConfig = config as unknown as { transport: string };
    const originalTransport = mutableConfig.transport;
    mutableConfig.transport = 'signal';
    try {
      expect(parseAdminCommand('BLOCK a1b2c3d4-1234-4abc-8def-a1b2c3d4e5f6')).toEqual({
        action: 'block', subjectType: 'phone', subjectId: 'a1b2c3d4-1234-4abc-8def-a1b2c3d4e5f6',
      });
    } finally {
      mutableConfig.transport = originalTransport;
    }
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand -- group subjects
// ---------------------------------------------------------------------------

// @check CHK-078
// @traces REQ-013.AC-05
describe('parseAdminCommand -- group positive', () => {
  // Use test-safe group JIDs that do not match real-shaped WhatsApp group JID patterns.
  const GROUP_A = '111111123456789@g.us';
  const GROUP_B = '111111987654321@g.us';
  const GROUP_C = '111111100000000@g.us';

  it('parses ALLOW GROUP command', () => {
    expect(parseAdminCommand(`ALLOW GROUP ${GROUP_A}`)).toEqual({
      action: 'allow',
      subjectType: 'group',
      subjectId: GROUP_A,
    });
  });

  it('parses BLOCK GROUP command', () => {
    expect(parseAdminCommand(`BLOCK GROUP ${GROUP_B}`)).toEqual({
      action: 'block',
      subjectType: 'group',
      subjectId: GROUP_B,
    });
  });

  it('is case insensitive for GROUP keyword', () => {
    expect(parseAdminCommand(`allow group ${GROUP_C}`)).toEqual({
      action: 'allow',
      subjectType: 'group',
      subjectId: GROUP_C,
    });
  });

  it('handles trailing whitespace for GROUP command', () => {
    expect(parseAdminCommand(`ALLOW GROUP ${GROUP_C}   `)).toEqual({
      action: 'allow',
      subjectType: 'group',
      subjectId: GROUP_C,
    });
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand -- negative
// ---------------------------------------------------------------------------

describe('parseAdminCommand -- negative', () => {
  it('returns null for no phone', () => { expect(parseAdminCommand('ALLOW')).toBeNull(); });
  it('returns null for empty string', () => { expect(parseAdminCommand('')).toBeNull(); });
  it('returns null for unknown command', () => { expect(parseAdminCommand('REVOKE 123')).toBeNull(); });
  it('returns null for non-digits in phone', () => { expect(parseAdminCommand('ALLOW +1-518')).toBeNull(); });
  it('returns null for random text', () => { expect(parseAdminCommand('hello world')).toBeNull(); });
  it('returns null for GROUP with no jid', () => { expect(parseAdminCommand('ALLOW GROUP')).toBeNull(); });
});

// ---------------------------------------------------------------------------
// parseAdminCommand -- fallback positive
// ---------------------------------------------------------------------------

describe('parseAdminCommand -- fallback positive', () => {
  it('parses FALLBACK ON (default, no duration)', () => {
    expect(parseAdminCommand('FALLBACK ON')).toEqual({ action: 'fallback', sub: 'on' });
  });

  it('parses fallback on 90m (minutes)', () => {
    expect(parseAdminCommand('fallback on 90m')).toEqual({ action: 'fallback', sub: 'on', durationMs: 90 * 60_000 });
  });

  it('parses Fallback On 2h (hours)', () => {
    expect(parseAdminCommand('Fallback On 2h')).toEqual({ action: 'fallback', sub: 'on', durationMs: 2 * 3_600_000 });
  });

  it('parses FALLBACK OFF', () => {
    expect(parseAdminCommand('FALLBACK OFF')).toEqual({ action: 'fallback', sub: 'off' });
  });

  it('parses fallback status (lowercase)', () => {
    expect(parseAdminCommand('fallback status')).toEqual({ action: 'fallback', sub: 'status' });
  });

  it('parses FALLBACK HELP', () => {
    expect(parseAdminCommand('FALLBACK HELP')).toEqual({ action: 'fallback', sub: 'help' });
  });

  it('parses fallback help (lowercase)', () => {
    expect(parseAdminCommand('fallback help')).toEqual({ action: 'fallback', sub: 'help' });
  });

  it('parses bare FALLBACK as help', () => {
    expect(parseAdminCommand('FALLBACK')).toEqual({ action: 'fallback', sub: 'help' });
  });

  it('parses bare fallback with trailing spaces as help', () => {
    expect(parseAdminCommand('fallback  ')).toEqual({ action: 'fallback', sub: 'help' });
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand -- fallback negative
// ---------------------------------------------------------------------------

describe('parseAdminCommand -- fallback negative', () => {
  it('returns null for FALLBACK ON 0m (zero is not a positive integer)', () => {
    expect(parseAdminCommand('FALLBACK ON 0m')).toBeNull();
  });

  it('returns null for FALLBACK ON 0h', () => {
    expect(parseAdminCommand('FALLBACK ON 0h')).toBeNull();
  });

  it('returns null for FALLBACK ON tomorrow (non-numeric)', () => {
    expect(parseAdminCommand('FALLBACK ON tomorrow')).toBeNull();
  });

  it('returns null for FALLBACK ON 5d (unsupported unit)', () => {
    expect(parseAdminCommand('FALLBACK ON 5d')).toBeNull();
  });

  it('returns null for FALLBACK MAYBE (unrecognised sub-command)', () => {
    expect(parseAdminCommand('FALLBACK MAYBE')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand -- grant positive
// ---------------------------------------------------------------------------

describe('parseAdminCommand -- grant positive', () => {
  it('parses GRANT <group> (arm, no duration)', () => {
    expect(parseAdminCommand('GRANT camera')).toEqual({ action: 'grant', sub: 'arm', group: 'camera' });
  });

  it('parses grant camera 30m (minutes)', () => {
    expect(parseAdminCommand('grant camera 30m')).toEqual({ action: 'grant', sub: 'arm', group: 'camera', durationMs: 30 * 60_000 });
  });

  it('parses Grant Writes 2h (hours, case-insensitive, group lowercased)', () => {
    expect(parseAdminCommand('Grant Writes 2h')).toEqual({ action: 'grant', sub: 'arm', group: 'writes', durationMs: 2 * 3_600_000 });
  });

  it('parses GRANT DISARM as control, NOT arming a group named "disarm"', () => {
    expect(parseAdminCommand('GRANT DISARM')).toEqual({ action: 'grant', sub: 'disarm' });
  });

  it('parses grant status (lowercase)', () => {
    expect(parseAdminCommand('grant status')).toEqual({ action: 'grant', sub: 'status' });
  });

  it('parses GRANT HELP', () => {
    expect(parseAdminCommand('GRANT HELP')).toEqual({ action: 'grant', sub: 'help' });
  });

  it('parses bare GRANT as help', () => {
    expect(parseAdminCommand('GRANT')).toEqual({ action: 'grant', sub: 'help' });
  });
});

// ---------------------------------------------------------------------------
// parseAdminCommand -- grant negative
// ---------------------------------------------------------------------------

describe('parseAdminCommand -- grant negative', () => {
  it('returns null for GRANT camera 0m (zero is not a positive integer)', () => {
    expect(parseAdminCommand('GRANT camera 0m')).toBeNull();
  });

  it('returns null for GRANT camera 5d (unsupported unit)', () => {
    expect(parseAdminCommand('GRANT camera 5d')).toBeNull();
  });

  it('returns null for a multi-word tail (grant me access)', () => {
    expect(parseAdminCommand('grant me access')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-admin gate
// ---------------------------------------------------------------------------

describe('Non-admin cannot trigger admin commands', () => {
  it('isAdminMessage rejects non-admin sender', () => {
    expect(isAdminMessage(makeIncomingMsg({ senderJid: '15550000000@s.whatsapp.net', isGroup: false }), mockDb)).toBe(false);
  });

  it('isAdminMessage rejects group messages from admin', () => {
    expect(isAdminMessage(makeIncomingMsg({ senderJid: '15550100001@s.whatsapp.net', isGroup: true }), mockDb)).toBe(false);
  });
});
