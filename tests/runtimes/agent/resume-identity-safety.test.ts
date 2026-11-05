import { describe, expect, it } from 'vitest';
import { parseDeliveryNamespace } from '../../../src/core/jid-constants.ts';
import {
  resolveResumeIdentity,
  type PersistedResumeIdentity,
} from '../../../src/runtimes/agent/resume-identity.ts';

const PHONE_IDENTITY: PersistedResumeIdentity = {
  scope: 'per_chat',
  conversationKey: '15550100001',
  deliveryJid: '15550100001@s.whatsapp.net',
  deliveryNamespace: 's.whatsapp.net',
  inboundSeq: 41,
  logicalTurnId: 'turn-41',
  managerId: 'manager-phone',
  generation: 3,
};

describe('resume identity safety', () => {
  it.each([
    ['+15550100001@sms', '+15550100001_at_sms', 'sms'],
    ['+15550100001@signal', '+15550100001_at_signal', 'signal'],
    ['c174e550-3036-4f0d-9ad5-b40a75a9d101@signal', 'c174e550-3036-4f0d-9ad5-b40a75a9d101_at_signal', 'signal'],
    ['Z3JvdXAtY29udmVyc2F0aW9u@signal', 'Z3JvdXAtY29udmVyc2F0aW9u_at_signal', 'signal'],
    ['+15550100001@imessage', '+15550100001_at_imessage', 'imessage'],
    ['person@example.test@imessage', 'person_at_example.test@imessage', 'imessage'],
  ])('resumes canonical transport identity %s without changing its conversation key', (deliveryJid, conversationKey, deliveryNamespace) => {
    const candidate = { ...PHONE_IDENTITY, deliveryJid, conversationKey, deliveryNamespace };
    expect(resolveResumeIdentity(candidate)).toEqual(candidate);
    expect(resolveResumeIdentity({ ...candidate, conversationKey: PHONE_IDENTITY.conversationKey })).toBeNull();
    expect(resolveResumeIdentity({ ...candidate, deliveryNamespace: 's.whatsapp.net' })).toBeNull();
  });

  it.each([
    '+15550100001@unknown', '15550100001@sms', '+15550100001@SMS',
    'peer@signal', 'a@b@signal', '@imessage', 'person@example.test@imessage@imessage',
    'Person@Example.test@imessage', 'iMessage;+;@imessage', 'iMessage;-;@imessage',
    'iMessage;+;chat123@imessage', 'iMessage;-;chat123@imessage',
    'person@example.test\u0000@imessage', '+15550100001 @signal',
  ])('rejects unsupported or noncanonical transport identity %s', (deliveryJid) => {
    expect(parseDeliveryNamespace(deliveryJid)).toBeNull();
    expect(resolveResumeIdentity({ ...PHONE_IDENTITY, deliveryJid })).toBeNull();
  });

  it.each([
    {
      name: 'phone resume',
      candidate: PHONE_IDENTITY,
      expectedDeliveryJid: '15550100001@s.whatsapp.net',
    },
    {
      name: 'mapped LID mismatch fails closed',
      candidate: {
        ...PHONE_IDENTITY,
        conversationKey: '15550100001',
        deliveryJid: '81536414179557@lid',
        deliveryNamespace: 'lid',
      },
      expectedDeliveryJid: null,
    },
    {
      name: 'unmapped LID resume',
      candidate: {
        ...PHONE_IDENTITY,
        conversationKey: '81536414179557',
        deliveryJid: '81536414179557@lid',
        deliveryNamespace: 'lid',
      },
      expectedDeliveryJid: '81536414179557@lid',
    },
    {
      name: 'device-suffixed resume',
      candidate: {
        ...PHONE_IDENTITY,
        deliveryJid: '15550100001:7@s.whatsapp.net',
      },
      expectedDeliveryJid: '15550100001:7@s.whatsapp.net',
    },
    {
      name: 'migrated identity mismatch fails closed',
      candidate: {
        ...PHONE_IDENTITY,
        conversationKey: '15550100002',
      },
      expectedDeliveryJid: null,
    },
    {
      name: 'shared latest checkpoint identity is validated',
      candidate: {
        ...PHONE_IDENTITY,
        scope: 'shared',
        conversationKey: '15550100003',
        deliveryJid: '15550100003@s.whatsapp.net',
        inboundSeq: 504,
        logicalTurnId: 'shared-turn-504',
        managerId: 'shared-manager',
        generation: 9,
      },
      expectedDeliveryJid: '15550100003@s.whatsapp.net',
    },
  ])('$name', ({ candidate, expectedDeliveryJid }) => {
    const resolved = resolveResumeIdentity(candidate);

    expect(resolved?.deliveryJid ?? null).toBe(expectedDeliveryJid);
    if (resolved !== null) {
      expect(resolved).toEqual(candidate);
      expect(resolved).not.toBe(candidate);
    }
  });

  it.each([
    ['phone JID recorded as LID', { ...PHONE_IDENTITY, deliveryNamespace: 'lid' }],
    ['LID recorded as phone', {
      ...PHONE_IDENTITY,
      conversationKey: '81536414179557',
      deliveryJid: '81536414179557@lid',
      deliveryNamespace: 's.whatsapp.net',
    }],
    ['unsupported namespace', {
      ...PHONE_IDENTITY,
      conversationKey: 'status',
      deliveryJid: 'status@broadcast',
      deliveryNamespace: 'broadcast',
    }],
  ])('fails closed on namespace tamper: %s', (_name, candidate) => {
    expect(resolveResumeIdentity(candidate)).toBeNull();
  });

  it.each([
    ['scope', { ...PHONE_IDENTITY, scope: undefined }],
    ['conversation key', { ...PHONE_IDENTITY, conversationKey: '' }],
    ['delivery JID', { ...PHONE_IDENTITY, deliveryJid: undefined }],
    ['delivery namespace', { ...PHONE_IDENTITY, deliveryNamespace: null }],
    ['inbound sequence', { ...PHONE_IDENTITY, inboundSeq: null }],
    ['logical turn ID', { ...PHONE_IDENTITY, logicalTurnId: ' ' }],
    ['manager ID', { ...PHONE_IDENTITY, managerId: undefined }],
    ['generation', { ...PHONE_IDENTITY, generation: 0 }],
  ])('fails closed when the persisted tuple lacks %s', (_name, candidate) => {
    expect(resolveResumeIdentity(candidate)).toBeNull();
  });

  it.each([
    ['fractional inbound sequence', { ...PHONE_IDENTITY, inboundSeq: 1.5 }],
    ['negative inbound sequence', { ...PHONE_IDENTITY, inboundSeq: -1 }],
    ['unsafe inbound sequence', { ...PHONE_IDENTITY, inboundSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional generation', { ...PHONE_IDENTITY, generation: 1.5 }],
    ['negative generation', { ...PHONE_IDENTITY, generation: -1 }],
    ['unsafe generation', { ...PHONE_IDENTITY, generation: Number.MAX_SAFE_INTEGER + 1 }],
  ])('fails closed on %s', (_name, candidate) => {
    expect(resolveResumeIdentity(candidate)).toBeNull();
  });

  it.each([
    null,
    undefined,
    {},
    {
      conversationKey: PHONE_IDENTITY.conversationKey,
      sessionId: 'legacy-session-without-identity-provenance',
    },
  ])('fails closed on legacy or ambiguous checkpoint %#', (candidate) => {
    expect(resolveResumeIdentity(candidate)).toBeNull();
  });

  it('rejects malformed JIDs instead of throwing during startup resume', () => {
    expect(resolveResumeIdentity({ ...PHONE_IDENTITY, deliveryJid: 'not-a-jid' })).toBeNull();
    expect(resolveResumeIdentity({ ...PHONE_IDENTITY, deliveryJid: '@s.whatsapp.net' })).toBeNull();
    expect(resolveResumeIdentity({
      ...PHONE_IDENTITY,
      conversationKey: 'a',
      deliveryJid: 'a@b@lid',
      deliveryNamespace: 'lid',
    })).toBeNull();
  });
});
