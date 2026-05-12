import { describe, expect, it } from 'vitest';
import {
  DOMAIN_GROUP,
  DOMAIN_LID,
  DOMAIN_PERSONAL,
  JID_GROUP,
  JID_LID,
  JID_PERSONAL,
  bareNumber,
  isGroupJid,
  isLidJid,
  isPnJid,
  normalizeLid,
  toLidJid,
  toPersonalJid,
} from '../../src/core/jid-constants.ts';

describe('jid constants and helpers', () => {
  it('derives JID suffixes from the bare domains', () => {
    expect(JID_PERSONAL).toBe(`@${DOMAIN_PERSONAL}`);
    expect(JID_LID).toBe(`@${DOMAIN_LID}`);
    expect(JID_GROUP).toBe(`@${DOMAIN_GROUP}`);
  });

  it('builds personal and LID JIDs from local identifiers', () => {
    expect(toPersonalJid('15551234567')).toBe('15551234567@s.whatsapp.net');
    expect(toLidJid('12345')).toBe('12345@lid');
  });

  it('detects personal, LID, and group JIDs by suffix', () => {
    expect(isPnJid('15551234567@s.whatsapp.net')).toBe(true);
    expect(isPnJid('12345@lid')).toBe(false);
    expect(isLidJid('12345@lid')).toBe(true);
    expect(isLidJid(undefined)).toBe(false);
    expect(isGroupJid('111111100000000001@g.us')).toBe(true);
    expect(isGroupJid('15551234567@s.whatsapp.net')).toBe(false);
  });

  it('extracts the local part before the first @', () => {
    expect(bareNumber('15551234567@s.whatsapp.net')).toBe('15551234567');
    expect(bareNumber('no-domain')).toBe('no-domain');
  });

  it('normalizes LID device suffixes without touching plain identifiers', () => {
    expect(normalizeLid('12345:67')).toBe('12345');
    expect(normalizeLid('12345')).toBe('12345');
  });
});
