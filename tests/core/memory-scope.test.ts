import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../src/core/database.ts';
import { upsertLidMapping } from '../../src/core/lid-resolver.ts';
import {
  GroupMembershipCache,
  foldChatAttribution,
  isDmLaneMembership,
  isGroupSharedRecord,
  memoryHitTier,
  memoryIdentityFold,
  resolveMemoryScope,
  senderRecallCrossesChats,
  type GroupParticipantInfo,
  type InstanceIdentities,
  type MemoryScopeDeps,
} from '../../src/core/memory-scope.ts';

const OWNER = '15550000001';
const MEMBER = '15550000002';
const SIBLING = '15550000077';
const BOT_JID = '15550000099@s.whatsapp.net';
const GROUP_JID = '111111100000123@g.us';
const GROUP_KEY = '111111100000123_at_g.us';
const MEMBER_LID = '11111110001';

const identities: InstanceIdentities = {
  adminPhones: new Set([OWNER]),
  siblingPhones: new Set([SIBLING]),
  botJid: BOT_JID,
  botLid: '11111110999@lid',
};

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  upsertLidMapping(db, MEMBER_LID, `${MEMBER}@s.whatsapp.net`);
});

afterEach(() => {
  db.close();
});

function reader(participants: GroupParticipantInfo[] | null) {
  return { participants: vi.fn(async () => participants) };
}

function deps(overrides: Partial<MemoryScopeDeps> = {}): MemoryScopeDeps {
  return { db, identities, membership: null, sharedWorkflowGroups: [], ...overrides };
}

describe('identity folding', () => {
  it('folds both group spellings and a mapped LID chat to one key', () => {
    expect(foldChatAttribution(GROUP_JID, db)).toBe(GROUP_KEY);
    expect(foldChatAttribution(GROUP_KEY, db)).toBe(GROUP_KEY);
    expect(foldChatAttribution(`${MEMBER_LID}@lid`, db)).toBe(MEMBER);
    expect(foldChatAttribution(`${MEMBER}@s.whatsapp.net`, db)).toBe(MEMBER);
    expect(foldChatAttribution(MEMBER, db)).toBe(MEMBER);
    expect(foldChatAttribution('', db)).toBe('');
  });

  it('folds a LID sender to its phone', () => {
    const fold = memoryIdentityFold(db);
    expect(fold.sender(`${MEMBER_LID}@lid`)).toBe(MEMBER);
    expect(fold.sender(`${MEMBER}:4@s.whatsapp.net`)).toBe(MEMBER);
  });
});

describe('DM-lane membership', () => {
  it('is a DM lane when every member is the owner or a bot account', () => {
    expect(isDmLaneMembership([
      { id: `${OWNER}@s.whatsapp.net` },
      { id: BOT_JID },
      { id: `${SIBLING}@s.whatsapp.net` },
    ], identities, db)).toBe(true);
  });

  it('matches the bot by LID and the owner by a participant phoneNumber', () => {
    expect(isDmLaneMembership([
      { id: '11111110123@lid', phoneNumber: `${OWNER}@s.whatsapp.net` },
      { id: '11111110999@lid' },
    ], identities, db)).toBe(true);
  });

  it('is not a DM lane once anyone else is a member', () => {
    expect(isDmLaneMembership([
      { id: `${OWNER}@s.whatsapp.net` },
      { id: BOT_JID },
      { id: `${MEMBER}@s.whatsapp.net` },
    ], identities, db)).toBe(false);
  });

  it('is not a DM lane when a member LID cannot be resolved, or there are no members', () => {
    expect(isDmLaneMembership([{ id: BOT_JID }, { id: '11111110777@lid' }], identities, db)).toBe(false);
    expect(isDmLaneMembership([], identities, db)).toBe(false);
  });
});

describe('GroupMembershipCache', () => {
  it('serves from cache, re-reads after invalidate or TTL, and reports a failed read as unknown', async () => {
    let now = 0;
    let members: GroupParticipantInfo[] = [{ id: BOT_JID }];
    const fetch = vi.fn(async () => members);
    const cache = new GroupMembershipCache(fetch, { ttlMs: 1000, now: () => now });

    expect(await cache.participants(GROUP_JID)).toEqual([{ id: BOT_JID }]);
    members = [{ id: BOT_JID }, { id: `${MEMBER}@s.whatsapp.net` }];
    expect(await cache.participants(GROUP_JID)).toHaveLength(1);
    cache.invalidate(GROUP_JID);
    expect(await cache.participants(GROUP_JID)).toHaveLength(2);
    members = [{ id: BOT_JID }];
    now = 1000;
    expect(await cache.participants(GROUP_JID)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    const failing = new GroupMembershipCache(async () => { throw new Error('offline'); });
    expect(await failing.participants(GROUP_JID)).toBeNull();
  });
});

describe('resolveMemoryScope', () => {
  const group = { tier: 'chat-scoped', conversationKey: GROUP_KEY, deliveryJid: GROUP_JID };

  it('treats the operator instance as unrestricted', async () => {
    const scope = await resolveMemoryScope(
      { ...group, operatorInstance: true, actorJid: `${MEMBER}@s.whatsapp.net` },
      deps(),
    );
    expect(scope).toMatchObject({ kind: 'unrestricted', reason: 'operator_instance', chatKey: GROUP_KEY });
  });

  it('treats a verified admin sender as unrestricted, but not the same phone over SMS', async () => {
    const admin = await resolveMemoryScope({ ...group, operatorInstance: false, actorJid: `${OWNER}@s.whatsapp.net` }, deps());
    expect(admin.kind).toBe('unrestricted');
    const spoofed = await resolveMemoryScope({ ...group, operatorInstance: false, actorJid: `+${OWNER}@sms` }, deps());
    expect(spoofed).toMatchObject({ kind: 'configurable_group', reason: 'group_membership_unproven' });
    expect('verifiedSender' in spoofed).toBe(false);
  });

  it('classifies a direct chat as dm', async () => {
    const scope = await resolveMemoryScope(
      { tier: 'chat-scoped', conversationKey: MEMBER, deliveryJid: `${MEMBER}@s.whatsapp.net`, operatorInstance: false, actorJid: `${MEMBER}@s.whatsapp.net` },
      deps(),
    );
    expect(scope.kind).toBe('dm');
    expect(scope.chatSpellings).toEqual(expect.arrayContaining([MEMBER, `${MEMBER}@s.whatsapp.net`, `${MEMBER_LID}@lid`]));
  });

  it('classifies an owner-and-bots group as a DM lane for a non-admin bot sender', async () => {
    const scope = await resolveMemoryScope(
      { ...group, operatorInstance: false, actorJid: `${SIBLING}@s.whatsapp.net` },
      deps({ membership: reader([{ id: `${OWNER}@s.whatsapp.net` }, { id: BOT_JID }, { id: `${SIBLING}@s.whatsapp.net` }]) }),
    );
    expect(scope.kind).toBe('dm_lane');
  });

  it('fails closed to configurable_group when membership cannot be read', async () => {
    const scope = await resolveMemoryScope(
      { ...group, operatorInstance: false, actorJid: `${SIBLING}@s.whatsapp.net` },
      deps({ membership: reader(null) }),
    );
    expect(scope).toMatchObject({ kind: 'configurable_group', reason: 'group_membership_unproven', verifiedSender: SIBLING });
  });

  it('marks a group listed in sharedWorkflowGroups under either spelling', async () => {
    for (const listed of [GROUP_JID, GROUP_KEY]) {
      const scope = await resolveMemoryScope(
        { ...group, operatorInstance: false, actorJid: `${MEMBER}@s.whatsapp.net` },
        deps({ sharedWorkflowGroups: [listed] }),
      );
      expect(scope.sharedWorkflow).toBe(true);
    }
  });

  it('fails closed for a chat session with no conversation, and gives a global session the instance', async () => {
    const chat = await resolveMemoryScope({ tier: 'chat-scoped', operatorInstance: false }, deps());
    expect(chat.kind).toBe('no_context');
    const global = await resolveMemoryScope({ tier: 'global', operatorInstance: false }, deps());
    expect(global).toMatchObject({ kind: 'dm', chatKey: undefined });
  });
});

describe('memoryHitTier', () => {
  const fold = () => memoryIdentityFold(db);

  it('ranks this chat, other chats, then untagged for a dm', async () => {
    const scope = await resolveMemoryScope(
      { tier: 'chat-scoped', conversationKey: MEMBER, operatorInstance: false, actorJid: `${MEMBER}@s.whatsapp.net` },
      deps(),
    );
    expect(memoryHitTier({ chat_jid: `${MEMBER_LID}@lid` }, scope, fold())).toBe(0);
    expect(memoryHitTier({ chat_jid: GROUP_JID }, scope, fold())).toBe(1);
    expect(memoryHitTier({}, scope, fold())).toBe(2);
    expect(memoryHitTier({ chat_jid: '' }, scope, fold())).toBe(2);
  });

  it('gives a configurable group its shared records and the sender\'s own records only', async () => {
    const scope = await resolveMemoryScope(
      { tier: 'chat-scoped', conversationKey: GROUP_KEY, deliveryJid: GROUP_JID, operatorInstance: false, actorJid: `${MEMBER_LID}@lid` },
      deps(),
    );
    const f = fold();
    expect(memoryHitTier({ chat_jid: GROUP_JID, sender_jid: '' }, scope, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: GROUP_KEY, sender_jid: `${SIBLING}@s.whatsapp.net`, memory_type: 'group_context' }, scope, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: GROUP_KEY, sender_jid: `${MEMBER}@s.whatsapp.net`, memory_type: 'user_fact' }, scope, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: GROUP_KEY, sender_jid: `${SIBLING}@s.whatsapp.net`, memory_type: 'user_fact' }, scope, f)).toBeNull();
    expect(memoryHitTier({ chat_jid: MEMBER, sender_jid: `${MEMBER}@s.whatsapp.net` }, scope, f)).toBeNull();
    expect(memoryHitTier({ sender_jid: `${MEMBER}@s.whatsapp.net` }, scope, f)).toBeNull();
  });

  it('defines shared as group_context or no sender', () => {
    expect(isGroupSharedRecord({ memory_type: 'group_context', sender_jid: 'x@s.whatsapp.net' })).toBe(true);
    expect(isGroupSharedRecord({ memory_type: 'user_fact', sender_jid: '' })).toBe(true);
    expect(isGroupSharedRecord({ memory_type: 'user_fact' })).toBe(true);
    expect(isGroupSharedRecord({ memory_type: 'user_fact', sender_jid: 'x@s.whatsapp.net' })).toBe(false);
  });
});

describe('senderRecallCrossesChats (chat runtime)', () => {
  // Built per test: `db` is opened in beforeEach.
  let base: { adminPhones: Set<string>; db: Database; operatorInstance: boolean };
  beforeEach(() => {
    base = { adminPhones: identities.adminPhones, db, operatorInstance: false };
  });

  it('crosses chats in a direct chat, for the operator instance and for a verified admin', () => {
    expect(senderRecallCrossesChats({ ...base, chatJid: `${MEMBER}@s.whatsapp.net`, senderJid: `${MEMBER}@s.whatsapp.net` })).toBe(true);
    expect(senderRecallCrossesChats({ ...base, operatorInstance: true, chatJid: GROUP_JID, senderJid: `${MEMBER}@s.whatsapp.net` })).toBe(true);
    expect(senderRecallCrossesChats({ ...base, chatJid: GROUP_JID, senderJid: `${OWNER}@s.whatsapp.net` })).toBe(true);
  });

  it('stays in the group for any other group sender', () => {
    expect(senderRecallCrossesChats({ ...base, chatJid: GROUP_JID, senderJid: `${MEMBER}@s.whatsapp.net` })).toBe(false);
    expect(senderRecallCrossesChats({ ...base, chatJid: GROUP_JID, senderJid: `+${OWNER}@sms` })).toBe(false);
  });
});
