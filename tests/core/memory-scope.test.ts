import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../src/core/database.ts';
import { upsertLidMapping } from '../../src/core/lid-resolver.ts';
import {
  GroupMembershipCache,
  agentSessionIsolatedPerChat,
  foldChatAttribution,
  isDmLaneMembership,
  isGroupSharedRecord,
  memoryHitTier,
  memoryRecallRestrictive,
  memoryIdentityFold,
  resolveMemoryScope,
  chatRecallBoundary,
  instanceRecordVisibility,
  memorySourceAccount,
  narrowestVisibility,
  recordIdScope,
  ownerOnlyRecallAllowed,
  withVisibilityFilter,
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
  // directChat undefined: no transport classification, so no owner_only grant.
  const group = { tier: 'chat-scoped', conversationKey: GROUP_KEY, deliveryJid: GROUP_JID, directChat: undefined };

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

  it('classifies a direct chat by the contact scope, with every spelling of the chat', async () => {
    const scope = await resolveMemoryScope(
      {
        tier: 'chat-scoped', conversationKey: MEMBER, deliveryJid: `${MEMBER}@s.whatsapp.net`, operatorInstance: false,
        actorJid: `${MEMBER}@s.whatsapp.net`, directChat: undefined,
      },
      deps(),
    );
    expect(scope.kind).toBe('dm_chat');
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
    const chat = await resolveMemoryScope({ tier: 'chat-scoped', operatorInstance: false, directChat: undefined }, deps());
    expect(chat.kind).toBe('no_context');
    const global = await resolveMemoryScope({ tier: 'global', operatorInstance: false, directChat: undefined }, deps());
    expect(global).toMatchObject({ kind: 'dm', chatKey: undefined });
  });
});

describe('memoryHitTier', () => {
  const fold = () => memoryIdentityFold(db);

  it('ranks this chat, other chats, then untagged for a whole-instance dm', async () => {
    const scope = await resolveMemoryScope(
      { tier: 'chat-scoped', conversationKey: MEMBER, operatorInstance: false, actorJid: `${MEMBER}@s.whatsapp.net`, directChat: undefined },
      deps({ contactRecallScopes: { [MEMBER]: 'instance' } }),
    );
    expect(memoryHitTier({ chat_jid: `${MEMBER_LID}@lid` }, scope, fold())).toBe(0);
    expect(memoryHitTier({ chat_jid: GROUP_JID }, scope, fold())).toBe(1);
    expect(memoryHitTier({}, scope, fold())).toBe(2);
    expect(memoryHitTier({ chat_jid: '' }, scope, fold())).toBe(2);
  });

  it('gives a configurable group its shared records and the sender\'s own records only', async () => {
    const scope = await resolveMemoryScope(
      {
        tier: 'chat-scoped', conversationKey: GROUP_KEY, deliveryJid: GROUP_JID, operatorInstance: false,
        actorJid: `${MEMBER_LID}@lid`, directChat: undefined,
      },
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

describe('direct-chat contact scope', () => {
  const dm = (actorJid: string) => ({
    tier: 'chat-scoped', conversationKey: MEMBER, deliveryJid: `${MEMBER}@s.whatsapp.net`, operatorInstance: false, actorJid,
    directChat: undefined,
  });

  it('holds a non-admin direct chat to this chat by default', async () => {
    const scope = await resolveMemoryScope(dm(`${MEMBER}@s.whatsapp.net`), deps());
    expect(scope).toMatchObject({ kind: 'dm_chat', reason: 'contact_scope_chat' });
    const f = memoryIdentityFold(db);
    expect(memoryHitTier({ chat_jid: `${MEMBER_LID}@lid` }, scope, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: `${OWNER}@s.whatsapp.net` }, scope, f)).toBeNull();
    expect(memoryHitTier({ chat_jid: GROUP_JID }, scope, f)).toBeNull();
    expect(memoryHitTier({}, scope, f)).toBe(2);
  });

  it('gives a contact configured as instance the whole instance, matched through its LID', async () => {
    const scope = await resolveMemoryScope(
      dm(`${MEMBER_LID}@lid`),
      deps({ contactRecallScopes: { [`+${MEMBER}`]: 'instance' } }),
    );
    expect(scope).toMatchObject({ kind: 'dm', reason: 'contact_scope_instance' });
  });

  it('ignores an instance setting for an unauthenticated sender, and an unknown value', async () => {
    const spoofed = await resolveMemoryScope(dm(`+${MEMBER}@sms`), deps({ contactRecallScopes: { [MEMBER]: 'instance' } }));
    expect(spoofed.kind).toBe('dm_chat');
    const unknown = await resolveMemoryScope(dm(`${MEMBER}@s.whatsapp.net`), deps({ contactRecallScopes: { [MEMBER]: 'everything' } }));
    expect(unknown.kind).toBe('dm_chat');
  });

  it('keeps an admin and the operator instance whole-instance', async () => {
    const admin = await resolveMemoryScope(
      { ...dm(`${OWNER}@s.whatsapp.net`), conversationKey: OWNER, deliveryJid: `${OWNER}@s.whatsapp.net` },
      deps(),
    );
    expect(admin.kind).toBe('unrestricted');
    const operator = await resolveMemoryScope({ ...dm(`${MEMBER}@s.whatsapp.net`), operatorInstance: true }, deps());
    expect(operator.kind).toBe('unrestricted');
  });
});

describe('chatRecallBoundary (chat runtime)', () => {
  // Built per test: `db` is opened in beforeEach.
  let base: { adminPhones: Set<string>; db: Database; operatorInstance: boolean; sharedWorkflowGroups: string[] };
  beforeEach(() => {
    base = { adminPhones: identities.adminPhones, db, operatorInstance: false, sharedWorkflowGroups: [] };
  });

  it('is open for the operator instance, a verified admin, and a contact configured as instance', () => {
    expect(chatRecallBoundary({ ...base, operatorInstance: true, chatJid: GROUP_JID, senderJid: `${MEMBER}@s.whatsapp.net` })).toBe('open');
    expect(chatRecallBoundary({ ...base, chatJid: GROUP_JID, senderJid: `${OWNER}@s.whatsapp.net` })).toBe('open');
    expect(chatRecallBoundary({
      ...base, chatJid: `${MEMBER}@s.whatsapp.net`, senderJid: `${MEMBER}@s.whatsapp.net`, contactRecallScopes: { [MEMBER]: 'instance' },
    })).toBe('open');
  });

  it('holds a default direct chat and a shared-workflow group to this chat', () => {
    expect(chatRecallBoundary({ ...base, chatJid: `${MEMBER}@s.whatsapp.net`, senderJid: `${MEMBER}@s.whatsapp.net` })).toBe('this_chat');
    expect(chatRecallBoundary({
      ...base, sharedWorkflowGroups: [GROUP_KEY], chatJid: GROUP_JID, senderJid: `${MEMBER}@s.whatsapp.net`,
    })).toBe('this_chat');
  });

  it('applies the group rule to any other group sender', () => {
    expect(chatRecallBoundary({ ...base, chatJid: GROUP_JID, senderJid: `${MEMBER}@s.whatsapp.net` })).toBe('group');
    expect(chatRecallBoundary({ ...base, chatJid: GROUP_JID, senderJid: `+${OWNER}@sms` })).toBe('group');
  });
});

describe('owner_only visibility', () => {
  const TRUSTED = '15550000055';
  const OWNER_ONLY = { chat_jid: `${MEMBER}@s.whatsapp.net`, visibility: 'owner_only', source_instance: 'line-a' };
  const dmWith = (phone: string, actorJid = `${phone}@s.whatsapp.net`) => ({
    tier: 'chat-scoped', conversationKey: phone, deliveryJid: `${phone}@s.whatsapp.net`, operatorInstance: false, actorJid,
    directChat: true as boolean | undefined,
  });
  const withTrusted = (overrides: Partial<MemoryScopeDeps> = {}) => deps({
    trustedOperatorPhones: [TRUSTED], ownerOnlySources: new Set(['line-a']), ...overrides,
  });

  it('the verified owner and a configured trusted operator read owner_only records in a direct chat', async () => {
    const f = memoryIdentityFold(db);
    const owner = await resolveMemoryScope(dmWith(OWNER), withTrusted());
    expect(owner.ownerOnlyAccess).toBe(true);
    expect(memoryHitTier(OWNER_ONLY, owner, f)).toBe(1);
    const trusted = await resolveMemoryScope(dmWith(TRUSTED), withTrusted());
    expect(trusted.ownerOnlyAccess).toBe(true);
    // (1) an owner_only record from ANOTHER chat reaches a trusted operator.
    expect(memoryHitTier(OWNER_ONLY, trusted, f)).toBe(1);
    expect(memoryHitTier({ ...OWNER_ONLY, chat_jid: `${TRUSTED}@s.whatsapp.net` }, trusted, f)).toBe(0);
  });

  it('(2) a trusted operator keeps the contact boundary for chat_scoped and legacy records', async () => {
    const f = memoryIdentityFold(db);
    const trusted = await resolveMemoryScope(dmWith(TRUSTED), withTrusted());
    expect(trusted).toMatchObject({ kind: 'dm_chat', ownerOnlyAccess: true });
    expect(memoryHitTier({ chat_jid: `${MEMBER}@s.whatsapp.net`, visibility: 'chat_scoped' }, trusted, f)).toBeNull();
    expect(memoryHitTier({ chat_jid: `${MEMBER}@s.whatsapp.net` }, trusted, f)).toBeNull();
    expect(memoryHitTier({ chat_jid: GROUP_JID, visibility: 'chat_scoped' }, trusted, f)).toBeNull();
    expect(chatRecallBoundary({
      adminPhones: identities.adminPhones, db, operatorInstance: false,
      chatJid: `${TRUSTED}@s.whatsapp.net`, senderJid: `${TRUSTED}@s.whatsapp.net`,
    })).toBe('this_chat');
  });

  it('(4) the verified admin keeps its unchanged whole-instance scope for chat_scoped records', async () => {
    const f = memoryIdentityFold(db);
    const owner = await resolveMemoryScope(dmWith(OWNER), withTrusted());
    expect(owner).toMatchObject({ kind: 'unrestricted', reason: 'admin_sender' });
    expect(memoryHitTier({ chat_jid: `${OWNER}@s.whatsapp.net`, visibility: 'chat_scoped' }, owner, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: `${MEMBER}@s.whatsapp.net`, visibility: 'chat_scoped' }, owner, f)).toBe(1);
    expect(memoryHitTier({ chat_jid: GROUP_JID }, owner, f)).toBe(1);
    expect(memoryHitTier({}, owner, f)).toBe(2);
  });

  it('an ordinary contact never receives an owner_only record, even from its own chat', async () => {
    const f = memoryIdentityFold(db);
    for (const scopes of [undefined, { [MEMBER]: 'instance' }]) {
      const contact = await resolveMemoryScope(dmWith(MEMBER), withTrusted({ contactRecallScopes: scopes }));
      expect(contact.ownerOnlyAccess).toBe(false);
      expect(memoryHitTier(OWNER_ONLY, contact, f)).toBeNull();
    }
  });

  it('a group where the admin participates gets no owner_only records', async () => {
    const f = memoryIdentityFold(db);
    const group = await resolveMemoryScope(
      {
        tier: 'chat-scoped', conversationKey: GROUP_KEY, deliveryJid: GROUP_JID, operatorInstance: false,
        actorJid: `${OWNER}@s.whatsapp.net`, directChat: undefined,
      },
      withTrusted({ membership: reader([{ id: `${OWNER}@s.whatsapp.net` }, { id: `${MEMBER}@s.whatsapp.net` }]) }),
    );
    expect(group.kind).toBe('unrestricted');
    expect(group.ownerOnlyAccess).toBe(false);
    expect(memoryHitTier({ chat_jid: GROUP_JID, sender_jid: '', visibility: 'owner_only' }, group, f)).toBeNull();
    expect(memoryHitTier({ ...OWNER_ONLY, chat_jid: GROUP_JID }, group, f)).toBeNull();
  });

  it('unverified callers, the operator instance and a global session without a conversation are denied', async () => {
    const spoofed = await resolveMemoryScope(dmWith(OWNER, `+${OWNER}@sms`), withTrusted());
    expect(spoofed.ownerOnlyAccess).toBe(false);
    const noActor = await resolveMemoryScope({ ...dmWith(OWNER), actorJid: undefined }, withTrusted());
    expect(noActor.ownerOnlyAccess).toBe(false);
    const noDb = await resolveMemoryScope(dmWith(OWNER), { ...withTrusted(), db: null });
    expect(noDb.ownerOnlyAccess).toBe(false);
    const operator = await resolveMemoryScope({ ...dmWith(MEMBER), operatorInstance: true }, withTrusted());
    expect(operator.kind).toBe('unrestricted');
    expect(operator.ownerOnlyAccess).toBe(false);
    const global = await resolveMemoryScope(
      { tier: 'global', operatorInstance: false, actorJid: `${OWNER}@s.whatsapp.net`, directChat: undefined },
      withTrusted(),
    );
    expect(global.ownerOnlyAccess).toBe(false);
  });

  it('records with no visibility field (written before visibility existed) recall exactly as before', async () => {
    const f = memoryIdentityFold(db);
    const contact = await resolveMemoryScope(dmWith(MEMBER), withTrusted());
    expect(memoryHitTier({ chat_jid: `${MEMBER}@s.whatsapp.net` }, contact, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: `${MEMBER}@s.whatsapp.net`, visibility: 'chat_scoped' }, contact, f)).toBe(0);
    expect(memoryHitTier({}, contact, f)).toBe(2);
  });

  it('the chat runtime predicate: owner or trusted operator in a direct chat only', () => {
    const input = { adminPhones: identities.adminPhones, trustedOperatorPhones: [TRUSTED], db, directChat: true };
    expect(ownerOnlyRecallAllowed({ ...input, actorJid: `${OWNER}@s.whatsapp.net`, conversationKey: `${OWNER}@s.whatsapp.net` })).toBe(true);
    expect(ownerOnlyRecallAllowed({ ...input, actorJid: `${TRUSTED}@s.whatsapp.net`, conversationKey: `${TRUSTED}@s.whatsapp.net` })).toBe(true);
    expect(ownerOnlyRecallAllowed({ ...input, actorJid: `${OWNER}@s.whatsapp.net`, conversationKey: GROUP_JID })).toBe(false);
    expect(ownerOnlyRecallAllowed({ ...input, actorJid: `${MEMBER}@s.whatsapp.net`, conversationKey: `${MEMBER}@s.whatsapp.net` })).toBe(false);
    expect(ownerOnlyRecallAllowed({ ...input, actorJid: `+${OWNER}@sms`, conversationKey: `+${OWNER}@sms` })).toBe(false);
    expect(ownerOnlyRecallAllowed({ ...input, db: null, actorJid: `${OWNER}@s.whatsapp.net`, conversationKey: OWNER })).toBe(false);
  });

  it('grants only on an affirmative transport direct-chat classification, never by the absence of a group marker', () => {
    // The `_at_imessage` entries are the grant resolver's identities for
    // `<phone>@imessage`, so both senders below are verified: the refusals come
    // from the conversation kind alone.
    const input = {
      adminPhones: new Set([...identities.adminPhones, `${OWNER}_at_imessage`]),
      trustedOperatorPhones: [TRUSTED, `${TRUSTED}_at_imessage`],
      db,
    };
    // An iMessage group's chat id carries no group marker: only the transport knows.
    const imessageGroup = 'chat000111222333@imessage';
    for (const actorJid of [`${OWNER}@imessage`, `${TRUSTED}@imessage`]) {
      const inGroup = { ...input, actorJid, conversationKey: imessageGroup, deliveryJid: imessageGroup };
      expect(ownerOnlyRecallAllowed({ ...inGroup, directChat: false })).toBe(false);
      expect(ownerOnlyRecallAllowed({ ...inGroup, directChat: undefined })).toBe(false);
      expect(ownerOnlyRecallAllowed({ ...inGroup, directChat: true })).toBe(true);
    }
    // An unknown conversation kind is refused even for a WhatsApp direct chat.
    const ownerDm = { ...input, actorJid: `${OWNER}@s.whatsapp.net`, conversationKey: OWNER, deliveryJid: `${OWNER}@s.whatsapp.net` };
    expect(ownerOnlyRecallAllowed({ ...ownerDm, directChat: undefined })).toBe(false);
    // A flag that says direct never overrides a recognized group.
    expect(ownerOnlyRecallAllowed({ ...ownerDm, conversationKey: GROUP_KEY, deliveryJid: GROUP_JID, directChat: true })).toBe(false);
  });

  it('resolveMemoryScope grants owner_only access only when the request classifies a direct chat', async () => {
    expect((await resolveMemoryScope({ ...dmWith(OWNER), directChat: undefined }, withTrusted())).ownerOnlyAccess).toBe(false);
    expect((await resolveMemoryScope({ ...dmWith(OWNER), directChat: false }, withTrusted())).ownerOnlyAccess).toBe(false);
    expect((await resolveMemoryScope(dmWith(OWNER), withTrusted())).ownerOnlyAccess).toBe(true);
  });

  it('an agent session is isolated per chat only with sessionScope per_chat or sandboxPerChat', () => {
    expect(agentSessionIsolatedPerChat('per_chat', false)).toBe(true);
    expect(agentSessionIsolatedPerChat('per_chat', undefined)).toBe(true);
    expect(agentSessionIsolatedPerChat(undefined, true)).toBe(true);
    for (const scope of ['shared', 'single', 'global', undefined, 'per-chat', '']) {
      expect(agentSessionIsolatedPerChat(scope, false)).toBe(false);
      expect(agentSessionIsolatedPerChat(scope, undefined)).toBe(false);
    }
  });

  it('builds the pre-query filter: exclusion keeps records with no visibility field', () => {
    const exclusion = { $or: [{ visibility: { $exists: false } }, { visibility: { $ne: 'owner_only' } }] };
    expect(withVisibilityFilter(undefined, false)).toEqual(exclusion);
    expect(withVisibilityFilter({}, false)).toEqual(exclusion);
    expect(withVisibilityFilter({ chat_jid: { $eq: 'c' } }, false)).toEqual({ chat_jid: { $eq: 'c' }, ...exclusion });
    const disjunction = { $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] };
    expect(withVisibilityFilter(disjunction, false)).toEqual({ $and: [disjunction, exclusion] });
    expect(withVisibilityFilter({ chat_jid: { $eq: 'c' } }, true)).toEqual({ chat_jid: { $eq: 'c' } });
    expect(withVisibilityFilter(undefined, true)).toBeUndefined();
    // Restrictive recall, caller without access: chat_scoped records only.
    expect(withVisibilityFilter({ chat_jid: { $eq: 'c' } }, false, true))
      .toEqual({ chat_jid: { $eq: 'c' }, visibility: { $eq: 'chat_scoped' } });
    expect(withVisibilityFilter(undefined, false, true)).toEqual({ visibility: { $eq: 'chat_scoped' } });
    expect(withVisibilityFilter({ chat_jid: { $eq: 'c' } }, true, true)).toEqual({ chat_jid: { $eq: 'c' } });
  });
});

describe('instance-scoped recall boundary (memory.pinecone.instanceScopedIds on)', () => {
  const dm = {
    tier: 'chat-scoped', conversationKey: MEMBER, deliveryJid: `${MEMBER}@s.whatsapp.net`, operatorInstance: false, directChat: true,
  };

  // What runtime and knowledge_search pass with the option on: this instance,
  // the reader's own account, and restrictive recall.
  const lineA = { source_instance: 'line-a', source_account: 'acct-a', visibility: 'chat_scoped' };
  const scoped = (overrides: Partial<MemoryScopeDeps> = {}): MemoryScopeDeps =>
    deps({ instanceScope: 'line-a', sourceAccount: 'acct-a', restrictive: true, ...overrides } as Partial<MemoryScopeDeps>);

  it('the same chat_jid from another instance or another account is another conversation', async () => {
    const f = memoryIdentityFold(db);
    const chat = `${MEMBER}@s.whatsapp.net`;
    const contact = await resolveMemoryScope({ ...dm, actorJid: chat }, scoped());
    expect(memoryHitTier({ chat_jid: chat, ...lineA }, contact, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: chat, ...lineA, source_instance: 'line-b' }, contact, f)).toBeNull();
    // Same instance name under another account (the instance reconnected as
    // another account): another conversation.
    expect(memoryHitTier({ chat_jid: chat, ...lineA, source_account: 'acct-b' }, contact, f)).toBeNull();
    // A missing instance or account ties the record to no instance, so a caller
    // without owner_only access does not get it.
    expect(memoryHitTier({ chat_jid: chat, visibility: 'chat_scoped' }, contact, f)).toBeNull();
    expect(memoryHitTier({ chat_jid: chat, visibility: 'chat_scoped', source_instance: 'line-a' }, contact, f)).toBeNull();
    // A record written before provenance existed no longer reaches a contact.
    expect(memoryHitTier({ chat_jid: chat }, contact, f)).toBeNull();

    const ownerChat = `${OWNER}@s.whatsapp.net`;
    const ownerDm = { ...dm, conversationKey: OWNER, deliveryJid: ownerChat, actorJid: ownerChat };
    const owner = await resolveMemoryScope(ownerDm, scoped());
    expect(memoryHitTier({ chat_jid: ownerChat, source_instance: 'line-b' }, owner, f)).toBeNull();
    // With owner_only access an unstamped record of this chat still counts as this instance's.
    expect(memoryHitTier({ chat_jid: ownerChat }, owner, f)).toBe(0);
    // A line-b owner_only record reaches the line-a owner only when line-a lists line-b.
    const lineBOwnerOnly = { chat_jid: ownerChat, source_instance: 'line-b', visibility: 'owner_only' };
    expect(memoryHitTier(lineBOwnerOnly, owner, f)).toBeNull();
    const listing = await resolveMemoryScope(ownerDm, scoped({ ownerOnlySources: new Set(['line-a', 'line-b']) }));
    expect(memoryHitTier(lineBOwnerOnly, listing, f)).toBe(1);
  });

  it.each(['acct-a', ''])('instance contact recall gates source before ranking and untagged shortcuts with account "%s"', async (account) => {
    const contact = await resolveMemoryScope({ ...dm, actorJid: `${MEMBER}@s.whatsapp.net` }, scoped({
      sourceAccount: account, contactRecallScopes: { [MEMBER]: 'instance' },
    }));
    expect(contact.ownerOnlyAccess).toBe(false);
    const f = memoryIdentityFold(db);
    for (const [chat_jid, tier] of [['', 2], [`${MEMBER}@s.whatsapp.net`, 0], ['other-chat', 1]] as const) {
      expect(memoryHitTier({ ...lineA, chat_jid, source_account: 'acct-b' }, contact, f)).toBeNull();
      expect(memoryHitTier({ visibility: 'chat_scoped', source_instance: 'line-a', chat_jid }, contact, f)).toBeNull();
      expect(memoryHitTier({ ...lineA, chat_jid }, contact, f)).toBe(account ? tier : null);
    }
  });

  it('an ordinary contact cannot recall an untagged foreign or unstamped chat_scoped record', async () => {
    const contact = await resolveMemoryScope({ ...dm, actorJid: `${MEMBER}@s.whatsapp.net` }, scoped());
    const f = memoryIdentityFold(db);
    expect(memoryHitTier(lineA, contact, f)).toBe(2);
    expect(memoryHitTier({ ...lineA, source_account: 'acct-b' }, contact, f)).toBeNull();
    expect(memoryHitTier({ visibility: 'chat_scoped' }, contact, f)).toBeNull();
  });

  it('owner access crosses accounts only for owner_only records from listed sources', async () => {
    const ownerChat = `${OWNER}@s.whatsapp.net`;
    const owner = await resolveMemoryScope({ ...dm, conversationKey: OWNER, deliveryJid: ownerChat, actorJid: ownerChat }, scoped({
      ownerOnlySources: new Set(['line-a', 'line-b']),
    }));
    expect(owner.ownerOnlyAccess).toBe(true);
    const foreign = { chat_jid: ownerChat, ...lineA, source_account: 'acct-b' };
    const f = memoryIdentityFold(db);
    expect(memoryHitTier(foreign, owner, f)).toBeNull();
    expect(memoryHitTier({ ...foreign, visibility: 'owner_only', source_instance: 'line-b' }, owner, f)).toBe(1);
    expect(memoryHitTier({ ...foreign, visibility: 'owner_only', source_instance: 'line-c' }, owner, f)).toBeNull();
    expect(memoryHitTier({ ...foreign, source_instance: undefined }, owner, f)).toBeNull();
  });

  it('a reader whose own account is unknown matches no stamped record', async () => {
    const f = memoryIdentityFold(db);
    const chat = `${MEMBER}@s.whatsapp.net`;
    const contact = await resolveMemoryScope({ ...dm, actorJid: chat }, scoped({ sourceAccount: '' } as Partial<MemoryScopeDeps>));
    expect(memoryHitTier({ chat_jid: chat, ...lineA }, contact, f)).toBeNull();
    expect(memoryHitTier({ chat_jid: chat, ...lineA, source_account: '' }, contact, f)).toBeNull();
  });

  it('restrictive recall with the option off: chat_scoped records only, no instance or account boundary', async () => {
    const f = memoryIdentityFold(db);
    const chat = `${MEMBER}@s.whatsapp.net`;
    const restrictive = deps({ restrictive: true } as Partial<MemoryScopeDeps>);
    const contact = await resolveMemoryScope({ ...dm, actorJid: chat }, restrictive);
    expect(memoryHitTier({ chat_jid: chat, visibility: 'chat_scoped', source_instance: 'line-b' }, contact, f)).toBe(0);
    expect(memoryHitTier({ chat_jid: chat }, contact, f)).toBeNull();
    const ownerChat = `${OWNER}@s.whatsapp.net`;
    const owner = await resolveMemoryScope(
      { ...dm, conversationKey: OWNER, deliveryJid: ownerChat, actorJid: ownerChat }, restrictive,
    );
    expect(memoryHitTier({ chat_jid: ownerChat }, owner, f)).toBe(0);
  });

  it('recall is restrictive with instanceScopedIds, an owner_only recordVisibility, or a passive line', () => {
    expect(memoryRecallRestrictive(undefined, undefined, undefined)).toBe(false);
    expect(memoryRecallRestrictive('chat', 'chat_scoped', false)).toBe(false);
    expect(memoryRecallRestrictive('chat', undefined, true)).toBe(true);
    expect(memoryRecallRestrictive('chat', 'owner_only', false)).toBe(true);
    expect(memoryRecallRestrictive('passive', undefined, false)).toBe(true);
  });

  it('off (no instance scope) keeps matching on chat alone', async () => {
    const f = memoryIdentityFold(db);
    const contact = await resolveMemoryScope({ ...dm, actorJid: `${MEMBER}@s.whatsapp.net` }, deps());
    expect(memoryHitTier({ chat_jid: `${MEMBER}@s.whatsapp.net`, source_instance: 'line-b' }, contact, f)).toBe(0);
  });
});

describe('record provenance helpers', () => {
  it('a passive line is always owner_only; others follow config, defaulting to chat_scoped', () => {
    expect(instanceRecordVisibility('passive', 'chat_scoped')).toBe('owner_only');
    expect(instanceRecordVisibility('passive', undefined)).toBe('owner_only');
    expect(instanceRecordVisibility('agent', 'owner_only')).toBe('owner_only');
    expect(instanceRecordVisibility('agent', undefined)).toBe('chat_scoped');
    expect(instanceRecordVisibility('chat', 'something-else')).toBe('chat_scoped');
  });

  it('record id scope is the instance name only when instance-scoped ids are on', () => {
    expect(recordIdScope('line-a', true)).toBe('line-a');
    expect(recordIdScope('line-a', false)).toBeNull();
    expect(recordIdScope('line-a', undefined)).toBeNull();
    expect(recordIdScope('', true)).toBeNull();
  });

  it('narrowest visibility never widens an owner_only input', () => {
    expect(narrowestVisibility('chat_scoped', 'owner_only')).toBe('owner_only');
    expect(narrowestVisibility('owner_only', undefined)).toBe('owner_only');
    expect(narrowestVisibility('chat_scoped', undefined, 'bogus')).toBe('chat_scoped');
  });

  it('source account: configured scope id wins; a JID is hashed, never stored raw; unknown is empty', () => {
    expect(memorySourceAccount('scope:line-alpha', BOT_JID)).toBe('scope:line-alpha');
    const hashed = memorySourceAccount(undefined, BOT_JID);
    expect(hashed).toMatch(/^acct:[0-9a-f]{24}$/);
    expect(hashed).not.toContain('15550000099');
    expect(memorySourceAccount(undefined, '15550000099:12@s.whatsapp.net')).toBe(hashed);
    expect(memorySourceAccount(undefined, null)).toBe('');
    expect(memorySourceAccount('', '')).toBe('');
  });
});
