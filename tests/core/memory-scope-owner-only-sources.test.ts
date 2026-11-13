import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../src/core/database.ts';
import {
  memoryHitTier,
  memoryIdentityFold,
  ownerOnlyRecordServable,
  ownerOnlySourceSet,
  resolveMemoryScope,
  type InstanceIdentities,
  type MemoryScopeDeps,
} from '../../src/core/memory-scope.ts';

// owner_only records bound to their source instance: the allowed set is this
// instance plus memory.pinecone.ownerOnlySources, independent of
// instanceScopedIds (whose scope.sourceInstance is unset when the option is off).

const OWNER = '15550000001';
const MEMBER = '15550000002';

const identities: InstanceIdentities = {
  adminPhones: new Set([OWNER]),
  siblingPhones: new Set(),
  botJid: '15550000099@s.whatsapp.net',
  botLid: null,
};

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
});

afterEach(() => {
  db.close();
});

function deps(overrides: Partial<MemoryScopeDeps> = {}): MemoryScopeDeps {
  return { db, identities, membership: null, sharedWorkflowGroups: [], ...overrides };
}

const ownerDm = {
  tier: 'chat-scoped',
  conversationKey: OWNER,
  deliveryJid: `${OWNER}@s.whatsapp.net`,
  actorJid: `${OWNER}@s.whatsapp.net`,
  operatorInstance: false,
  directChat: true as boolean | undefined,
};
const contactDm = {
  ...ownerDm,
  conversationKey: MEMBER,
  deliveryJid: `${MEMBER}@s.whatsapp.net`,
  actorJid: `${MEMBER}@s.whatsapp.net`,
};

/** An owner_only record from another chat, stamped with `source`. */
const ownerOnlyFrom = (source: unknown): Record<string, unknown> => ({
  chat_jid: `${MEMBER}@s.whatsapp.net`,
  visibility: 'owner_only',
  source_instance: source,
});

describe('owner_only records are bound to their source instance', () => {
  it('the allowed set is this instance plus memory.pinecone.ownerOnlySources', () => {
    expect([...ownerOnlySourceSet('line-a', ['line-b'])].sort()).toEqual(['line-a', 'line-b']);
    expect([...ownerOnlySourceSet('line-a', undefined)]).toEqual(['line-a']);
    expect([...ownerOnlySourceSet('line-a', ['', 7, null, 'line-c'])].sort()).toEqual(['line-a', 'line-c']);
    expect([...ownerOnlySourceSet(undefined, 'line-b')]).toEqual([]);
  });

  it('serves an owner_only record only to a caller with access, and only from a listed source', () => {
    const sources = ownerOnlySourceSet('line-a', ['line-b']);
    expect(ownerOnlyRecordServable({ source_instance: 'line-a' }, true, sources)).toBe(true);
    expect(ownerOnlyRecordServable({ source_instance: 'line-b' }, true, sources)).toBe(true);
    expect(ownerOnlyRecordServable({ source_instance: 'line-c' }, true, sources)).toBe(false);
    expect(ownerOnlyRecordServable({ source_instance: 'line-a' }, false, sources)).toBe(false);
    expect(ownerOnlyRecordServable({ source_instance: 'line-a' }, true, undefined)).toBe(false);
  });

  it('never serves an owner_only record with a missing or invalid source_instance', () => {
    const sources = ownerOnlySourceSet('line-a', []);
    for (const fields of [{}, { source_instance: '' }, { source_instance: '  ' }, { source_instance: 42 },
      { source_instance: null }, { source_instance: ['line-a'] }]) {
      expect(ownerOnlyRecordServable(fields, true, sources)).toBe(false);
    }
  });

  it('with instanceScopedIds OFF, a line-b owner_only record reaches the line-a owner only when line-a lists line-b', async () => {
    const f = memoryIdentityFold(db);
    const unlisted = await resolveMemoryScope(ownerDm, deps({ ownerOnlySources: ownerOnlySourceSet('line-a', []) }));
    expect(unlisted.ownerOnlyAccess).toBe(true);
    expect(unlisted.sourceInstance).toBeUndefined();
    expect(memoryHitTier(ownerOnlyFrom('line-a'), unlisted, f)).toBe(1);
    expect(memoryHitTier(ownerOnlyFrom('line-b'), unlisted, f)).toBeNull();

    const listed = await resolveMemoryScope(ownerDm, deps({ ownerOnlySources: ownerOnlySourceSet('line-a', ['line-b']) }));
    expect(memoryHitTier(ownerOnlyFrom('line-b'), listed, f)).toBe(1);
    expect(memoryHitTier(ownerOnlyFrom('line-c'), listed, f)).toBeNull();
  });

  it('with instanceScopedIds ON the same binding holds', async () => {
    const f = memoryIdentityFold(db);
    const unlisted = await resolveMemoryScope(
      ownerDm, deps({ instanceScope: 'line-a', ownerOnlySources: ownerOnlySourceSet('line-a', []) }),
    );
    expect(unlisted.sourceInstance).toBe('line-a');
    expect(memoryHitTier(ownerOnlyFrom('line-b'), unlisted, f)).toBeNull();
    const listed = await resolveMemoryScope(
      ownerDm, deps({ instanceScope: 'line-a', ownerOnlySources: ownerOnlySourceSet('line-a', ['line-b']) }),
    );
    expect(memoryHitTier(ownerOnlyFrom('line-b'), listed, f)).toBe(1);
  });

  it('an owner_only record with a missing or invalid source_instance is refused, even from this chat', async () => {
    const f = memoryIdentityFold(db);
    const scope = await resolveMemoryScope(ownerDm, deps({ ownerOnlySources: ownerOnlySourceSet('line-a', ['line-b']) }));
    const thisChat = { chat_jid: `${OWNER}@s.whatsapp.net`, visibility: 'owner_only' };
    expect(memoryHitTier(thisChat, scope, f)).toBeNull();
    expect(memoryHitTier({ ...thisChat, source_instance: '' }, scope, f)).toBeNull();
    expect(memoryHitTier({ visibility: 'owner_only', source_instance: 42 }, scope, f)).toBeNull();
    expect(memoryHitTier({ ...thisChat, source_instance: 'line-a' }, scope, f)).toBe(0);
  });

  it('without an allowed set nothing owner_only is served, and access is still required', async () => {
    const f = memoryIdentityFold(db);
    const noSet = await resolveMemoryScope(ownerDm, deps());
    expect(noSet.ownerOnlyAccess).toBe(true);
    expect(memoryHitTier(ownerOnlyFrom('line-a'), noSet, f)).toBeNull();

    const contact = await resolveMemoryScope(contactDm, deps({ ownerOnlySources: ownerOnlySourceSet('line-a', []) }));
    expect(contact.ownerOnlyAccess).toBe(false);
    expect(memoryHitTier(ownerOnlyFrom('line-a'), contact, f)).toBeNull();
  });
});
