import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { canonicalConversationKey } from '../../src/core/access-list.ts';
import { createChatResolver, seedChatAliases } from '../../src/core/chats-resolver.ts';
import {
  CLIENT_OUTPUT_POLICY_REDACTION,
  parseClientOutputPolicies,
  projectClientOutputPolicyConfig,
  resolveClientOutputPolicy,
  selectClientOutputPolicy,
} from '../../src/core/client-output-policy-config.ts';

const DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SYNTHETIC_PHONE = ['1555', '010', '0001'].join('');
const SYNTHETIC_LID = ['1111', '010', '0002'].join('');
const SYNTHETIC_GROUP = ['120363', '999', '000000000'].join('');
const PHONE_JID = [SYNTHETIC_PHONE, 's.whatsapp.net'].join('@');
const LID_JID = [SYNTHETIC_LID, 'lid'].join('@');
const GROUP_JID = [SYNTHETIC_GROUP, 'g.us'].join('@');
const GROUP_CONVERSATION_KEY = `${SYNTHETIC_GROUP}_at_g.us`;

function syntheticPublicKey(seed = 7): string {
  return Buffer.concat([DER_PREFIX, Buffer.alloc(32, seed)]).toString('base64url');
}

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationKey: 'synthetic-conversation',
    maxCodePoints: 500,
    maxQuestionMarks: 1,
    blockedTerms: [{ value: 'restricted', match: 'whole_word', caseSensitive: false }],
    rejectInternalArtifacts: true,
    rejectWhatsAppJids: true,
    authorization: {
      keyId: 'synthetic-key.1',
      publicKey: syntheticPublicKey(),
      requiredActions: ['send_message', 'reply_message'],
    },
    ...overrides,
  };
}

function expectIssue(value: unknown, field: string): void {
  const parsed = parseClientOutputPolicies(value);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('expected client-output policy configuration to fail');
  expect(parsed.error.field).toBe(field);
}

describe('parseClientOutputPolicies', () => {
  it('accepts a closed valid policy and builds a deeply frozen exact-key registry', () => {
    const parsed = parseClientOutputPolicies([policy()]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected valid client-output policy configuration');

    const active = resolveClientOutputPolicy(parsed.registry, 'synthetic-conversation');
    expect(active).toBeDefined();
    expect(resolveClientOutputPolicy(parsed.registry, 'SYNTHETIC-CONVERSATION')).toBeUndefined();
    expect(parsed.registry).not.toHaveProperty('set');
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active!.blockedTerms)).toBe(true);
    expect(Object.isFrozen(active!.blockedTerms[0])).toBe(true);
    expect(Object.isFrozen(active!.authorization)).toBe(true);
    expect(Object.isFrozen(active!.authorization!.requiredActions)).toBe(true);
  });

  it('treats an absent field as an empty immutable registry but rejects explicit null', () => {
    const absent = parseClientOutputPolicies(undefined);
    expect(absent.ok).toBe(true);
    if (!absent.ok) throw new Error('expected absent policy configuration to be inert');
    expect(absent.registry.size).toBe(0);
    expectIssue(null, 'clientOutputPolicies');
  });

  it('enforces policy count, policy closure, and unique exact conversation keys', () => {
    expectIssue(Array.from({ length: 33 }, (_, index) => policy({ conversationKey: `key-${index}` })), 'clientOutputPolicies');
    expectIssue([{ ...policy(), unknown: true }], 'clientOutputPolicies[0]');
    expectIssue([policy(), policy()], 'clientOutputPolicies[1].conversationKey');
  });

  it.each([
    ['', 'clientOutputPolicies[0].conversationKey'],
    [' surrounded ', 'clientOutputPolicies[0].conversationKey'],
    ['__global__', 'clientOutputPolicies[0].conversationKey'],
    [`control\u0000key`, 'clientOutputPolicies[0].conversationKey'],
    [`control\u0085key`, 'clientOutputPolicies[0].conversationKey'],
    ['_at_g.us', 'clientOutputPolicies[0].conversationKey'],
    ['x'.repeat(513), 'clientOutputPolicies[0].conversationKey'],
  ])('rejects an invalid canonical conversation key', (conversationKey, field) => {
    expectIssue([policy({ conversationKey })], field);
  });

  it.each([
    ['personal', PHONE_JID],
    ['LID', LID_JID],
    ['group', GROUP_JID],
  ])('rejects a raw WhatsApp %s delivery JID before it can select a policy', (_kind, rawJid) => {
    const parsed = parseClientOutputPolicies([policy({ conversationKey: rawJid })]);

    if (parsed.ok) {
      expect(selectClientOutputPolicy(
        parsed.registry,
        { status: 'resolved', canonicalConversationKey: rawJid },
      )).not.toMatchObject({ status: 'configured' });
    }
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toEqual({
        field: 'clientOutputPolicies[0].conversationKey',
        reason: expect.not.stringContaining(rawJid),
      });
    }
  });

  it.each([
    ['bare numeric direct-or-LID key', SYNTHETIC_PHONE],
    ['another bare numeric direct-or-LID key', SYNTHETIC_LID],
    ['encoded group key', GROUP_CONVERSATION_KEY],
  ])('accepts and selects a canonical %s', (_kind, conversationKey) => {
    const parsed = parseClientOutputPolicies([policy({ conversationKey })]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected canonical conversation key to be accepted');
    expect(selectClientOutputPolicy(
      parsed.registry,
      { status: 'resolved', canonicalConversationKey: conversationKey },
    )).toMatchObject({ status: 'configured' });
  });

  it('accepts a trimmed non-JID canonical key at the exact 512-code-point bound', () => {
    const parsed = parseClientOutputPolicies([policy({ conversationKey: '😀'.repeat(512) })]);
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ['maxCodePoints', 0],
    ['maxCodePoints', 4001],
    ['maxCodePoints', 1.5],
    ['maxQuestionMarks', -1],
    ['maxQuestionMarks', 21],
    ['maxQuestionMarks', 1.5],
  ])('rejects out-of-contract numeric bound %s=%s', (field, value) => {
    expectIssue([policy({ [field]: value })], `clientOutputPolicies[0].${field}`);
  });

  it('enforces term closure, count, NFC, whitespace, code-point bounds, enums, and booleans', () => {
    expectIssue([policy({ blockedTerms: Array.from({ length: 65 }, () => ({ value: 'x', match: 'substring', caseSensitive: true })) })], 'clientOutputPolicies[0].blockedTerms');
    expectIssue([policy({ blockedTerms: [{ value: 'x', match: 'substring', caseSensitive: true, extra: true }] })], 'clientOutputPolicies[0].blockedTerms[0]');
    expectIssue([policy({ blockedTerms: [{ value: 'résumé', match: 'substring', caseSensitive: false }] })], 'clientOutputPolicies[0].blockedTerms[0].value');
    expectIssue([policy({ blockedTerms: [{ value: ' x', match: 'substring', caseSensitive: true }] })], 'clientOutputPolicies[0].blockedTerms[0].value');
    expectIssue([policy({ blockedTerms: [{ value: '😀'.repeat(129), match: 'substring', caseSensitive: true }] })], 'clientOutputPolicies[0].blockedTerms[0].value');
    expectIssue([policy({ blockedTerms: [{ value: 'x', match: 'regex', caseSensitive: true }] })], 'clientOutputPolicies[0].blockedTerms[0].match');
    expectIssue([policy({ blockedTerms: [{ value: 'x', match: 'substring', caseSensitive: 1 }] })], 'clientOutputPolicies[0].blockedTerms[0].caseSensitive');
  });

  it('uses the evaluator normalization SSOT when rejecting duplicate terms', () => {
    expectIssue([policy({
      blockedTerms: [
        { value: 'Résumé', match: 'substring', caseSensitive: false },
        { value: 'RÉSUMÉ', match: 'substring', caseSensitive: false },
      ],
    })], 'clientOutputPolicies[0].blockedTerms[1].value');

    const caseDistinct = parseClientOutputPolicies([policy({
      blockedTerms: [
        { value: 'Résumé', match: 'substring', caseSensitive: true },
        { value: 'RÉSUMÉ', match: 'substring', caseSensitive: true },
      ],
    })]);
    expect(caseDistinct.ok).toBe(true);
  });

  it.each([
    ['Greek sigma/final sigma', 'οσ', 'ος'],
    ['Latin long-s', 'safe', 'ſafe'],
    ['sharp-s/SS expansion', 'STRASSE', 'Straße'],
    ['capital sharp-s/SS expansion', 'STRASSE', 'STRAẞE'],
    ['Latin presentation ligature expansion', 'office', 'oﬃce'],
    ['micro-sign compatibility mapping', 'μ', 'µ'],
    ['Greek iota-subscript expansion', 'ἀι', 'ᾀ'],
    ['Cherokee stability', 'Ꭰ', 'ꭰ'],
  ])(
    'uses the evaluator caseless-key SSOT for duplicate %s terms',
    (_case, first, equivalent) => {
      expectIssue([policy({
        blockedTerms: [
          { value: first, match: 'substring', caseSensitive: false },
          { value: equivalent, match: 'substring', caseSensitive: false },
        ],
      })], 'clientOutputPolicies[0].blockedTerms[1].value');

      const caseDistinct = parseClientOutputPolicies([policy({
        blockedTerms: [
          { value: first, match: 'substring', caseSensitive: true },
          { value: equivalent, match: 'substring', caseSensitive: true },
        ],
      })]);
      expect(caseDistinct.ok).toBe(true);
    },
  );

  it('enforces authorization closure, key ID, canonical Ed25519 SPKI, and unique allowed actions', () => {
    expectIssue([policy({ authorization: { keyId: 'key:colon', publicKey: syntheticPublicKey(), requiredActions: ['send_message'] } })], 'clientOutputPolicies[0].authorization.keyId');
    expectIssue([policy({ authorization: { keyId: 'key', publicKey: `${syntheticPublicKey()}=`, requiredActions: ['send_message'] } })], 'clientOutputPolicies[0].authorization.publicKey');
    expectIssue([policy({ authorization: { keyId: 'key', publicKey: Buffer.alloc(44).toString('base64url'), requiredActions: ['send_message'] } })], 'clientOutputPolicies[0].authorization.publicKey');
    expectIssue([policy({ authorization: { keyId: 'key', publicKey: syntheticPublicKey(), requiredActions: ['send_message', 'send_message'] } })], 'clientOutputPolicies[0].authorization.requiredActions[1]');
    expectIssue([policy({ authorization: { keyId: 'key', publicKey: syntheticPublicKey(), requiredActions: ['unknown'] } })], 'clientOutputPolicies[0].authorization.requiredActions[0]');
    expectIssue([policy({ authorization: { keyId: 'key', publicKey: syntheticPublicKey(), requiredActions: ['send_message'], extra: true } })], 'clientOutputPolicies[0].authorization');
  });

  it('rejects unknown nested fields without echoing attacker-controlled field names', () => {
    const privateField = 'private-field-name-that-must-not-escape';
    const candidates: Array<[Record<string, unknown>, string]> = [
      [{ ...policy(), [privateField]: true }, 'clientOutputPolicies[0]'],
      [policy({
        blockedTerms: [{
          value: 'restricted',
          match: 'whole_word',
          caseSensitive: false,
          [privateField]: true,
        }],
      }), 'clientOutputPolicies[0].blockedTerms[0]'],
      [policy({
        authorization: {
          keyId: 'synthetic-key',
          publicKey: syntheticPublicKey(),
          requiredActions: ['send_message'],
          [privateField]: true,
        },
      }), 'clientOutputPolicies[0].authorization'],
    ];

    for (const [candidate, expectedField] of candidates) {
      const parsed = parseClientOutputPolicies([candidate]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('expected unknown nested field to fail');
      expect(parsed.error.field).toBe(expectedField);
      expect(JSON.stringify(parsed.error)).not.toContain(privateField);
    }
  });

  it('projects term values and public keys with one stable marker while retaining non-secret policy shape', () => {
    const raw = { name: 'synthetic-agent', clientOutputPolicies: [policy()] };
    const projected = projectClientOutputPolicyConfig(raw);
    const serialized = JSON.stringify(projected);

    expect(projected).not.toBe(raw);
    expect(serialized).not.toContain('restricted');
    expect(serialized).not.toContain(syntheticPublicKey());
    expect(projected).toMatchObject({
      name: 'synthetic-agent',
      clientOutputPolicies: [{
        conversationKey: 'synthetic-conversation',
        blockedTerms: [{ value: CLIENT_OUTPUT_POLICY_REDACTION, match: 'whole_word', caseSensitive: false }],
        authorization: { keyId: 'synthetic-key.1', publicKey: CLIENT_OUTPUT_POLICY_REDACTION },
      }],
    });
  });
});

describe('client-output policy canonical resolution composition', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database(':memory:');
    database.open();
  });

  afterEach(() => {
    database.close();
  });

  it('selects only after chat resolution and canonical conversation-key folding', () => {
    database.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run(SYNTHETIC_LID, PHONE_JID, '2026-01-01 00:00:00');
    database.raw.prepare('INSERT INTO chats (jid, conversation_key) VALUES (?, ?)')
      .run(LID_JID, SYNTHETIC_PHONE);
    seedChatAliases(database.raw, { synthetic: PHONE_JID });
    const resolver = createChatResolver({ db: database.raw, dbWrapper: database });
    const parsed = parseClientOutputPolicies([policy({ conversationKey: SYNTHETIC_PHONE })]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected valid client-output policy configuration');

    const resolvedJid = resolver.resolve({ to: 'synthetic' });
    expect(resolvedJid).toBe(LID_JID);
    expect(selectClientOutputPolicy(
      parsed.registry,
      {
        status: 'resolved',
        canonicalConversationKey: canonicalConversationKey(resolvedJid, database),
      },
    )).toMatchObject({ status: 'configured' });
  });

  it('distinguishes an unresolved raw LID from an ordinary unconfigured canonical key', () => {
    const resolver = createChatResolver({ db: database.raw, dbWrapper: database });
    const parsed = parseClientOutputPolicies([policy({ conversationKey: SYNTHETIC_PHONE })]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected valid client-output policy configuration');

    const unresolvedJid = resolver.resolve({ chatJid: LID_JID });
    expect(unresolvedJid).toBe(LID_JID);
    expect(selectClientOutputPolicy(
      parsed.registry,
      { status: 'identity_unresolved' },
    )).toEqual({ status: 'identity_unresolved' });
    expect(selectClientOutputPolicy(
      parsed.registry,
      { status: 'resolved', canonicalConversationKey: 'ordinary-unconfigured-key' },
    )).toEqual({ status: 'unconfigured' });
    expect(resolveClientOutputPolicy(
      parsed.registry,
      canonicalConversationKey(unresolvedJid, database),
    )).toBeUndefined();
  });
});
