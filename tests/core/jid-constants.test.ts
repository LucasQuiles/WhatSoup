/**
 * Direct unit coverage for src/core/jid-constants.ts.
 *
 * Centralized WhatsApp JID domain constants and low-level JID utilities.
 * Eight exported helpers plus six domain/suffix constants. No prior direct
 * test mirror; existing tests reference these symbols incidentally via
 * higher-level resolvers (lid-phone-resolution.test.ts) but do not pin
 * the contract.
 *
 * Synthetic JIDs only — no real phone numbers / contacts.
 */
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_PERSONAL,
  DOMAIN_LID,
  DOMAIN_GROUP,
  JID_PERSONAL,
  JID_LID,
  JID_GROUP,
  toPersonalJid,
  toLidJid,
  isLidJid,
  isPnJid,
  isGroupJid,
  bareNumber,
  normalizeLid,
  DOMAIN_SMS,
  JID_SMS,
  toSmsJid,
  fromSmsJid,
  smsJidToPhone,
  isSmsJid,
  DOMAIN_IMESSAGE,
  JID_IMESSAGE,
  toImessageJid,
  fromImessageJid,
  isImessageJid,
  isWhatsAppAuthenticatedJid,
  isAuthenticatedSenderJid,
  isSignalJid,
  toSignalJid,
  fromSignalJid,
  parseWhatsAppDeliveryNamespace,
  resolveConfiguredAdminJid,
} from '../../src/core/jid-constants.ts';

describe('domain constants', () => {
  it('exports bare-domain constants without @ prefix', () => {
    expect(DOMAIN_PERSONAL).toBe('s.whatsapp.net');
    expect(DOMAIN_LID).toBe('lid');
    expect(DOMAIN_GROUP).toBe('g.us');
  });

  it('@-prefixed suffixes are derived from bare domains', () => {
    expect(JID_PERSONAL).toBe(`@${DOMAIN_PERSONAL}`);
    expect(JID_LID).toBe(`@${DOMAIN_LID}`);
    expect(JID_GROUP).toBe(`@${DOMAIN_GROUP}`);
    expect(JID_PERSONAL).toBe('@s.whatsapp.net');
    expect(JID_LID).toBe('@lid');
    expect(JID_GROUP).toBe('@g.us');
  });
});

describe('parseWhatsAppDeliveryNamespace', () => {
  it.each([
    ['15551234567@s.whatsapp.net', DOMAIN_PERSONAL],
    ['81536414179557@lid', DOMAIN_LID],
    ['synthetic-group@g.us', DOMAIN_GROUP],
  ])('accepts canonical delivery JID %s', (jid, namespace) => {
    expect(parseWhatsAppDeliveryNamespace(jid)).toBe(namespace);
  });

  it.each([
    'status@broadcast',
    'a@b@lid',
    '@lid',
    '15551234567@LID',
    ' 15551234567@lid',
  ])('rejects non-canonical or unsupported JID %s', (jid) => {
    expect(parseWhatsAppDeliveryNamespace(jid)).toBeNull();
  });
});

describe('toPersonalJid', () => {
  it('appends @s.whatsapp.net to a number', () => {
    expect(toPersonalJid('15551234567')).toBe('15551234567@s.whatsapp.net');
  });

  it('passes the local part through verbatim (no validation)', () => {
    expect(toPersonalJid('')).toBe('@s.whatsapp.net');
    expect(toPersonalJid('abc')).toBe('abc@s.whatsapp.net');
  });
});

describe('toLidJid', () => {
  it('appends @lid to a number', () => {
    expect(toLidJid('98765')).toBe('98765@lid');
  });

  it('passes the local part through verbatim', () => {
    expect(toLidJid('')).toBe('@lid');
    expect(toLidJid('abc:01')).toBe('abc:01@lid');
  });
});

describe('isLidJid', () => {
  it('returns true for @lid-suffixed JIDs', () => {
    expect(isLidJid('12345@lid')).toBe(true);
    expect(isLidJid('12345:67@lid')).toBe(true);
  });

  it('returns false for non-LID JIDs', () => {
    expect(isLidJid('15551234567@s.whatsapp.net')).toBe(false);
    expect(isLidJid('group@g.us')).toBe(false);
    expect(isLidJid('plain-number')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isLidJid(null)).toBe(false);
    expect(isLidJid(undefined)).toBe(false);
    expect(isLidJid('')).toBe(false);
  });
});

describe('isPnJid', () => {
  it('returns true for @s.whatsapp.net JIDs', () => {
    expect(isPnJid('15551234567@s.whatsapp.net')).toBe(true);
  });

  it('returns false for non-PN JIDs', () => {
    expect(isPnJid('12345@lid')).toBe(false);
    expect(isPnJid('group@g.us')).toBe(false);
    expect(isPnJid('plain')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isPnJid(null)).toBe(false);
    expect(isPnJid(undefined)).toBe(false);
    expect(isPnJid('')).toBe(false);
  });
});

describe('isWhatsAppAuthenticatedJid (QR-143)', () => {
  it('returns true for WhatsApp-authenticated transports (personal + LID)', () => {
    expect(isWhatsAppAuthenticatedJid('15551234567@s.whatsapp.net')).toBe(true);
    expect(isWhatsAppAuthenticatedJid('1111111234567@lid')).toBe(true);
  });

  it('returns false for a spoofable SMS transport (QR-143 admin-spoof guard)', () => {
    expect(isWhatsAppAuthenticatedJid('15551234567@sms')).toBe(false);
    expect(isWhatsAppAuthenticatedJid('+15551234567@sms')).toBe(false);
  });

  it('returns false for group JIDs and null/undefined/empty', () => {
    expect(isWhatsAppAuthenticatedJid('group@g.us')).toBe(false);
    expect(isWhatsAppAuthenticatedJid(null)).toBe(false);
    expect(isWhatsAppAuthenticatedJid(undefined)).toBe(false);
    expect(isWhatsAppAuthenticatedJid('')).toBe(false);
  });
});

describe('isGroupJid', () => {
  it('returns true for @g.us JIDs', () => {
    expect(isGroupJid('test-group-id@g.us')).toBe(true);
  });

  it('recognizes only base64 Signal group addresses as groups', () => {
    expect(isGroupJid('Z3JvdXAtY29udmVyc2F0aW9u@signal')).toBe(true);
    expect(isGroupJid('+155500000000001@signal')).toBe(false);
    expect(isGroupJid('01234567-89ab-cdef-0123-456789abcdef@signal')).toBe(false);
  });

  it('returns false for non-group JIDs', () => {
    expect(isGroupJid('15551234567@s.whatsapp.net')).toBe(false);
    expect(isGroupJid('12345@lid')).toBe(false);
    expect(isGroupJid('plain-number')).toBe(false);
  });
});

describe('bareNumber', () => {
  it('returns the local part of a JID', () => {
    expect(bareNumber('15551234567@s.whatsapp.net')).toBe('15551234567');
    expect(bareNumber('12345@lid')).toBe('12345');
    expect(bareNumber('test-group-id@g.us')).toBe('test-group-id');
  });

  it('returns the input unchanged when no @ is present', () => {
    expect(bareNumber('plain-number')).toBe('plain-number');
    expect(bareNumber('')).toBe('');
  });

  it('returns the local part of LIDs with colon-device suffix unchanged', () => {
    // bareNumber strips only @-suffix, not :device. normalizeLid strips that.
    expect(bareNumber('12345:67@lid')).toBe('12345:67');
  });
});

describe('normalizeLid', () => {
  it('strips colon-device suffix from a bare LID', () => {
    expect(normalizeLid('12345:67')).toBe('12345');
    expect(normalizeLid('98765:0')).toBe('98765');
  });

  it('is a no-op when no colon is present', () => {
    expect(normalizeLid('12345')).toBe('12345');
    expect(normalizeLid('')).toBe('');
  });

  it('preserves multiple-colon inputs by stripping at the first colon', () => {
    expect(normalizeLid('12345:67:extra')).toBe('12345');
  });
});

// ---------------------------------------------------------------------------
// SMS JID helpers (DOMAIN_SMS / JID_SMS / toSmsJid / fromSmsJid /
// smsJidToPhone / isSmsJid)
// ---------------------------------------------------------------------------

describe('SMS JID helpers', () => {
  it('toSmsJid appends the @sms suffix and is idempotent', () => {
    expect(toSmsJid('+15551230000')).toBe('+15551230000@sms');
    expect(toSmsJid('+15551230000@sms')).toBe('+15551230000@sms');
  });

  it('fromSmsJid strips the suffix and tolerates bare addresses', () => {
    expect(fromSmsJid('+15551230000@sms')).toBe('+15551230000');
    expect(fromSmsJid('+15551230000')).toBe('+15551230000');
  });

  it('smsJidToPhone yields digits without the leading plus (phone-subject convention)', () => {
    expect(smsJidToPhone('+15551230000@sms')).toBe('15551230000');
    expect(smsJidToPhone('+15551230000')).toBe('15551230000');
    expect(smsJidToPhone('15551230000')).toBe('15551230000');
  });

  it('isSmsJid detects only @sms-suffixed ids', () => {
    expect(isSmsJid('+15551230000@sms')).toBe(true);
    expect(isSmsJid('+15551230000')).toBe(false);
    expect(isSmsJid('15551230000@s.whatsapp.net')).toBe(false);
  });

  it('round-trip composes with the JID constants', () => {
    expect(JID_SMS).toBe('@sms');
    expect(DOMAIN_SMS).toBe('sms');
    expect(fromSmsJid(toSmsJid('+15551230000'))).toBe('+15551230000');
  });
});

describe('isAuthenticatedSenderJid (S6 — signal/imessage parity)', () => {
  it('returns true for WhatsApp PN/LID (unchanged)', () => {
    expect(isAuthenticatedSenderJid('15551234567@s.whatsapp.net')).toBe(true);
    expect(isAuthenticatedSenderJid('1111111234567@lid')).toBe(true);
  });

  it('returns true for Signal Protocol-verified senders', () => {
    expect(isAuthenticatedSenderJid('a1b2c3d4-1234-1234-1234-a1b2c3d4e5f6@signal')).toBe(true);
    expect(isAuthenticatedSenderJid('+15559990000@signal')).toBe(true);
  });

  it('returns true for AppleID-verified iMessage senders', () => {
    expect(isAuthenticatedSenderJid('user@heal.internal@imessage')).toBe(true);
    expect(isAuthenticatedSenderJid('iMessage;+;chatABC@imessage')).toBe(true);
  });

  it('returns false for spoofable/unauthenticated forms', () => {
    expect(isAuthenticatedSenderJid('15551234567@sms')).toBe(false);
    expect(isAuthenticatedSenderJid('group@g.us')).toBe(false);
    expect(isAuthenticatedSenderJid(null)).toBe(false);
    expect(isAuthenticatedSenderJid('')).toBe(false);
  });

  it('the old name is an alias (back-compat for in-flight callers)', () => {
    expect(isWhatsAppAuthenticatedJid).toBe(isAuthenticatedSenderJid);
  });
});

describe('Signal/iMessage JID helpers', () => {
  it('toSignalJid / fromSignalJid round-trip and idempotence', () => {
    expect(toSignalJid('a1b2c3d4-1234-1234-1234-a1b2c3d4e5f6')).toBe('a1b2c3d4-1234-1234-1234-a1b2c3d4e5f6@signal');
    expect(toSignalJid('a@signal')).toBe('a@signal');
    expect(fromSignalJid('a1b2c3d4@signal')).toBe('a1b2c3d4');
    expect(fromSignalJid('bare')).toBe('bare');
  });

  it('isSignalJid detects only @signal-suffixed ids', () => {
    expect(isSignalJid('a@signal')).toBe(true);
    expect(isSignalJid('a@sms')).toBe(false);
    expect(isSignalJid(null)).toBe(false);
  });

  it('toImessageJid / fromImessageJid round-trip and idempotence', () => {
    expect(toImessageJid('user@heal.internal')).toBe('user@heal.internal@imessage');
    expect(toImessageJid('a@imessage')).toBe('a@imessage');
    expect(fromImessageJid('user@heal.internal@imessage')).toBe('user@heal.internal');
    expect(fromImessageJid('bare')).toBe('bare');
  });

  it('isImessageJid detects only @imessage-suffixed ids', () => {
    expect(isImessageJid('a@imessage')).toBe(true);
    expect(isImessageJid('a@signal')).toBe(false);
    expect(isImessageJid(null)).toBe(false);
  });
});

describe('resolveConfiguredAdminJid', () => {
  it.each([
    ['baileys', '15551230000', '15551230000@s.whatsapp.net'],
    ['signal', 'a1b2c3d4-1234-1234-1234-a1b2c3d4e5f6', 'a1b2c3d4-1234-1234-1234-a1b2c3d4e5f6@signal'],
    ['twilio', '15551230000', '+15551230000@sms'],
    ['imessage', 'owner@example.test', 'owner@example.test@imessage'],
    ['imessage', '+15551230000', '+15551230000@imessage'],
  ] as const)('routes configured %s admin identity %s to %s', (transport, identity, expected) => {
    expect(resolveConfiguredAdminJid(transport, identity)).toBe(expected);
  });
});
