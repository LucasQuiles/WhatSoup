import { describe, expect, it } from 'vitest';
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
