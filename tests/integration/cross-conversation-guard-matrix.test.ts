/**
 * Integration: cross-conversation guard call-site matrix (issue 3457, C1).
 *
 * Pins the CURRENT behaviour of the two cross-conversation guards named by
 * issue 3457, one named test per matrix cell:
 *
 *   registry guard   src/mcp/registry.ts:688  injected-target branch
 *                    src/mcp/registry.ts:718  global-and-unbound arm
 *                    src/mcp/registry.ts:741  guard predicate
 *                    src/mcp/registry.ts:756  authorization_denied / authorization
 *
 *   messaging guard  src/mcp/tools/messaging.ts:275  predicate (global + key)
 *                    src/mcp/tools/messaging.ts:283  throw
 *                    src/mcp/tools/messaging.ts:302  dry-run call site
 *                    src/mcp/tools/messaging.ts:375  beforeAudit call site
 *                    src/mcp/registry.ts:858         returned_error / handler
 *
 * Axes: session tier (global-unbound / chat-scoped / conversation-bound)
 *     x alias target `to` (present / absent)
 *     x session conversationKey mirror (present / absent).
 *
 * NOT an axis: the resolved / unresolved turn shape. Every cell here imports
 * ToolRegistry from tests/helpers/resolved-tool-registry.ts, which forces
 * `resolved: true`, so all thirteen cells run resolution-normal. No cell
 * outcome depends on it — `executingResolution` has one reader in src/,
 * scheduledAgentJobMaySee (src/mcp/registry.ts:104), reachable only for the
 * tools in SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS (src/mcp/registry.ts:75-82),
 * and neither `send_message` nor the M10 fixture tool is in that set. The
 * unresolved axis belongs to sibling issue 3435.
 *
 * Every cell asserts THREE things, because any one of them alone is weak:
 *   1. the caller-visible outcome (denied or admitted, and by which shape —
 *      the registry denies in PLAIN TEXT, the messaging guard denies inside a
 *      JSON error envelope);
 *   2. the dispatch effect (did a send reach the socket, and to which JID);
 *   3. the durable FAILURE CHANNEL recorded in `tool_calls`
 *      (failure_code / failure_stage), which is the axis issue 3457 exists to
 *      track and which no test pinned before this file.
 *
 * These tests pin behaviour AS IT IS at base. They are deliberately not a
 * statement that the current behaviour is desirable — a later consolidation
 * leaf must show each of these cells changing on purpose, not by accident.
 *
 * The companion document is docs/mcp/cross-conversation-guard-call-site-matrix.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';
import { registerMessagingTools, type MessagingDeps } from '../../src/mcp/tools/messaging.ts';
import { makeConversationBinding } from '../../src/mcp/types.ts';
import type { SessionContext, ToolDeclaration } from '../../src/mcp/types.ts';
import { canonicalConversationKey } from '../../src/core/access-list.ts';
import { GLOBAL_CONVERSATION_KEY, toConversationKey } from '../../src/core/conversation-key.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const ALICE_JID = '15551110001@s.whatsapp.net';
const ALICE_KEY = '15551110001';

const BOB_JID = '15552220002@s.whatsapp.net';
const BOB_KEY = '15552220002';

const BOB_ALIAS = 'bob';

/** A session pinned to ALICE addressing its OWN conversation by a mapped @lid. */
const PIN_PHONE = '15551230777';
const PIN_PHONE_JID = '15551230777@s.whatsapp.net';
const PIN_LID = '11111110777';
const PIN_LID_JID = '11111110777@lid';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SentMessage {
  jid: string;
  content: unknown;
}

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeCapturingConnection(sent: SentMessage[]): ConnectionManager {
  return {
    contactsDir: { contacts: new Map<string, string>(), getLidMappings: () => undefined },
    sendRaw: async (jid: string, content: unknown) => {
      sent.push({ jid, content });
      return { waMessageId: null };
    },
    sendMedia: async (jid: string, content: unknown) => {
      sent.push({ jid, content });
      return { waMessageId: null };
    },
    botJid: null,
    botLid: null,
  } as unknown as ConnectionManager;
}

/**
 * A registry with the real messaging module registered (so the canonical fold
 * IS armed, exactly as production arms it at messaging.ts:221) and durability
 * attached (so every cell can read its recorded failure channel).
 */
function makeArmedRegistry(db: Database, sent: SentMessage[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.setDurability(new DurabilityEngine(db));
  const deps: MessagingDeps = {
    connection: makeCapturingConnection(sent),
    db: db.raw,
    dbWrapper: db,
    adminPhones: new Set<string>(),
  };
  registerMessagingTools(registry, deps);
  return registry;
}

function seedAlias(db: Database, alias: string, chatJid: string): void {
  db.raw.prepare('INSERT INTO chat_aliases (alias, chat_jid) VALUES (?, ?)').run(alias, chatJid);
}

function seedLidMapping(db: Database, lid: string, phoneJid: string): void {
  db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)').run(lid, phoneJid);
}

/** The most recent `tool_calls` evidence row filed under `conversationKey`. */
function lastToolCall(db: Database, conversationKey: string): Record<string, unknown> | undefined {
  return db.raw.prepare(`
    SELECT tool_name, status, failure_code, failure_stage
      FROM tool_calls
     WHERE conversation_key = ?
     ORDER BY id DESC
     LIMIT 1
  `).get(conversationKey) as Record<string, unknown> | undefined;
}

function errorEnvelope(result: { content: Array<{ text: string }> }): { error?: string } {
  return JSON.parse(result.content[0].text) as { error?: string };
}

/** Fixture injected tool that declares NO `to` property, so the registry's
 *  alias-target axis is fixed absent and the guard predicate is reachable
 *  without registering the messaging module (which is what arms the fold). */
function probeInjectedTool(seen: string[]): ToolDeclaration {
  return {
    name: 'probe_injected_send',
    description: 'Matrix fixture: an injected-target tool with no alias parameter.',
    schema: z.object({ chatJid: z.string().optional(), text: z.string() }),
    scope: 'chat',
    targetMode: 'injected',
    handler: async (params: Record<string, unknown>) => {
      seen.push(params['chatJid'] as string);
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe('cross-conversation guard call-site matrix (3457)', () => {
  let db: Database;
  let sent: SentMessage[];
  let registry: ToolRegistry;

  beforeEach(() => {
    db = makeDb();
    sent = [];
    registry = makeArmedRegistry(db, sent);
  });

  afterEach(() => { db.close(); });

  // =========================================================================
  // M1 — global-unbound, key present, chatJid foreign, no alias target
  //      REGISTRY guard adjudicates (registry.ts:741) and denies.
  // =========================================================================
  it('M1 global pinned session, foreign chatJid, no alias: registry guard denies as authorization_denied/authorization', async () => {
    const result = await registry.call(
      'send_message',
      { chatJid: BOB_JID, text: 'matrix cell M1' },
      { tier: 'global', conversationKey: ALICE_KEY },
    );

    // Caller-visible shape: the registry denies in PLAIN TEXT, before the
    // handler runs, so there is no JSON error envelope to parse.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not match session conversation');
    expect(result.content[0].text).toContain(BOB_JID);
    expect(() => JSON.parse(result.content[0].text)).toThrow();

    // No dispatch.
    expect(sent).toHaveLength(0);

    // Durable failure channel: the registry's typed authorization denial.
    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'error',
      failure_code: 'authorization_denied',
      failure_stage: 'authorization',
    });
  });

  // =========================================================================
  // M2 — global-unbound, key present, own conversation by mapped @lid, no alias
  //      REGISTRY guard adjudicates and ADMITS through the armed fold.
  // =========================================================================
  it('M2 global pinned session, own conversation addressed by a mapped @lid: registry guard admits through the armed fold', async () => {
    seedLidMapping(db, PIN_LID, PIN_PHONE_JID);

    const result = await registry.call(
      'send_message',
      { chatJid: PIN_LID_JID, text: 'matrix cell M2' },
      { tier: 'global', conversationKey: PIN_PHONE },
    );

    // Admitted at both layers: the registry fold and the handler fold agree.
    expect(result.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(PIN_LID_JID);

    // The armed fold is what makes this cell an admit: without it the bare
    // fallback yields the raw LID digits, which is cell M10.
    expect(canonicalConversationKey(PIN_LID_JID, db)).toBe(PIN_PHONE);
    expect(toConversationKey(PIN_LID_JID)).not.toBe(PIN_PHONE);

    // No failure channel — the evidence row completes clean.
    expect(lastToolCall(db, PIN_PHONE)).toEqual({
      tool_name: 'send_message',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });
  });

  // =========================================================================
  // M3 — global-unbound, key present, alias target present, live send
  //      REGISTRY guard SUPPRESSED by `to`; MESSAGING guard denies at
  //      beforeAudit (messaging.ts:375).
  // =========================================================================
  it('M3 global pinned session, foreign alias target, live send: messaging guard denies as returned_error/handler', async () => {
    seedAlias(db, BOB_ALIAS, BOB_JID);

    const result = await registry.call(
      'send_message',
      { to: BOB_ALIAS, text: 'matrix cell M3' },
      { tier: 'global', conversationKey: ALICE_KEY },
    );

    // Caller-visible shape: a JSON error envelope returned BY THE HANDLER,
    // not the registry's plain-text denial. Same violation, different shape.
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result).error).toMatch(/does not match session conversation/);
    expect(errorEnvelope(result).error).toContain(BOB_JID);

    // No dispatch: the guard runs before the audit-intent write and the send.
    expect(sent).toHaveLength(0);

    // Durable failure channel: UNTYPED, because a handler-returned errorResult
    // carries no typed evidence (registry.ts:858-859 defaults).
    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'error',
      failure_code: 'returned_error',
      failure_stage: 'handler',
    });
  });

  // =========================================================================
  // M4 — global-unbound, key present, alias target present, dryRun
  //      MESSAGING guard denies at the dry-run call site (messaging.ts:302).
  // =========================================================================
  it('M4 global pinned session, foreign alias target, dryRun: messaging guard denies as returned_error/handler', async () => {
    seedAlias(db, BOB_ALIAS, BOB_JID);

    const result = await registry.call(
      'send_message',
      { to: BOB_ALIAS, text: 'matrix cell M4', dryRun: true },
      { tier: 'global', conversationKey: ALICE_KEY },
    );

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result).error).toMatch(/does not match session conversation/);
    expect(sent).toHaveLength(0);

    // The dry-run path reports the SAME channel as the live path (M3): the
    // preview is faithful to what a real send would record.
    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'error',
      failure_code: 'returned_error',
      failure_stage: 'handler',
    });
  });

  // =========================================================================
  // M5 — global-unbound, key ABSENT, chatJid foreign
  //      BOTH guards skipped (fail-open). registry.ts:741 requires a truthy
  //      conversationKey; messaging.ts:275 early-returns on a falsy one.
  // =========================================================================
  it('M5 global session with no conversationKey: both guards are skipped and the send is admitted', async () => {
    const result = await registry.call(
      'send_message',
      { chatJid: BOB_JID, text: 'matrix cell M5' },
      { tier: 'global' },
    );

    // Fail-open: an unpinned global session may address any conversation.
    expect(result.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(BOB_JID);

    // Evidence for an unpinned global session is filed under the reserved
    // global sentinel, not under the addressed conversation.
    expect(lastToolCall(db, GLOBAL_CONVERSATION_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });
    expect(lastToolCall(db, BOB_KEY)).toBeUndefined();
  });

  // =========================================================================
  // M6 — chat-scoped, caller chatJid supplied
  //      NEITHER guard runs. The chat-scoped arm (registry.ts:705) discards
  //      the caller target and injects session.deliveryJid.
  // =========================================================================
  it('M6 chat-scoped session with a caller-supplied chatJid: target is replaced by deliveryJid and neither guard runs', async () => {
    const result = await registry.call(
      'send_message',
      { chatJid: BOB_JID, text: 'matrix cell M6' },
      { tier: 'chat-scoped', conversationKey: ALICE_KEY, deliveryJid: ALICE_JID },
    );

    // Confinement here is INJECTION, not adjudication: no denial, and the
    // foreign target is silently replaced rather than rejected.
    expect(result.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(ALICE_JID);
    expect(sent[0].jid).not.toBe(BOB_JID);

    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });
  });

  // =========================================================================
  // M7 — chat-scoped, alias target supplied
  //      NEITHER guard runs; `to` is stripped (registry.ts:717) before the
  //      handler, so the alias never resolves.
  // =========================================================================
  it('M7 chat-scoped session with an alias target: the alias is stripped and the send goes to deliveryJid', async () => {
    seedAlias(db, BOB_ALIAS, BOB_JID);

    const result = await registry.call(
      'send_message',
      { to: BOB_ALIAS, text: 'matrix cell M7' },
      { tier: 'chat-scoped', conversationKey: ALICE_KEY, deliveryJid: ALICE_JID },
    );

    expect(result.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(ALICE_JID);

    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });
  });

  // =========================================================================
  // M8 — global-unbound, key present, BOTH chatJid and `to` supplied
  //      REGISTRY guard SUPPRESSED by a caller-controlled parameter. The
  //      rejection that follows is a TARGET-EXCLUSIVITY fault raised inside
  //      the handler, proving the guard never adjudicated the foreign JID.
  // =========================================================================
  it('M8 global pinned session supplying both chatJid and to: the registry guard is suppressed and a target-exclusivity fault answers instead', async () => {
    seedAlias(db, BOB_ALIAS, BOB_JID);

    const result = await registry.call(
      'send_message',
      { chatJid: BOB_JID, to: BOB_ALIAS, text: 'matrix cell M8' },
      { tier: 'global', conversationKey: ALICE_KEY },
    );

    expect(result.isError).toBe(true);

    // The load-bearing assertion: the answer is the mutual-exclusion fault,
    // NOT the cross-conversation denial. A caller-supplied `to` sets
    // hasAliasTarget and switches the registry guard off (registry.ts:741),
    // and the handler rejects on target shape before any conversation check.
    expect(errorEnvelope(result).error).toBe('chatJid and to are mutually exclusive; provide exactly one');
    expect(errorEnvelope(result).error).not.toMatch(/does not match session conversation/);
    expect(sent).toHaveLength(0);

    // Channel: the handler's untyped return, not the registry's typed denial.
    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'error',
      failure_code: 'returned_error',
      failure_stage: 'handler',
    });
  });

  // =========================================================================
  // M9a — conversation-bound, mirror PRESENT, caller target supplied
  //       The bound arm (registry.ts:691-702) rejects the caller target
  //       BEFORE the cross-conversation guard is reachable, and does so on a
  //       VALIDATION channel — even when the target matches the binding.
  // =========================================================================
  it('M9a conversation-bound session with the conversationKey mirror present: a caller-supplied target is rejected as validation_rejected/validation', async () => {
    const boundWithMirror: SessionContext = {
      tier: 'global',
      conversationKey: ALICE_KEY,
      binding: makeConversationBinding(ALICE_KEY, ALICE_JID),
    };

    const result = await registry.call(
      'send_message',
      { chatJid: BOB_JID, text: 'matrix cell M9a' },
      boundWithMirror,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fills its target from the conversation binding');
    // Not the cross-conversation denial: the bound arm returns at
    // registry.ts:697 before the global-and-unbound arm is ever entered.
    expect(result.content[0].text).not.toMatch(/does not match session conversation/);
    expect(sent).toHaveLength(0);

    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'error',
      failure_code: 'validation_rejected',
      failure_stage: 'validation',
    });
  });

  // =========================================================================
  // M9b — conversation-bound, top-level conversationKey mirror ABSENT
  //       Confinement comes from the BINDING via the registry's bound arm
  //       (registry.ts:691-702), not from either 3457 guard: both read only
  //       session.conversationKey, which is absent here.
  // =========================================================================
  it('M9b conversation-bound session with no conversationKey mirror: a caller-supplied target is rejected as validation_rejected/validation', async () => {
    const boundNoMirror: SessionContext = {
      tier: 'global',
      binding: makeConversationBinding(ALICE_KEY, ALICE_JID),
    };

    const result = await registry.call(
      'send_message',
      { chatJid: BOB_JID, text: 'matrix cell M9' },
      boundNoMirror,
    );

    // Rejected, but by the BINDING arm and on a VALIDATION channel — a
    // different code and stage from the registry cross-conversation guard.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('fills its target from the conversation binding');
    expect(result.content[0].text).not.toMatch(/does not match session conversation/);
    expect(sent).toHaveLength(0);

    // With no mirror, evidence is filed under the reserved global sentinel,
    // NOT under the bound conversation.
    expect(lastToolCall(db, GLOBAL_CONVERSATION_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'error',
      failure_code: 'validation_rejected',
      failure_stage: 'validation',
    });
    expect(lastToolCall(db, ALICE_KEY)).toBeUndefined();
  });

  // =========================================================================
  // M9c — conversation-bound, mirror absent, NO caller target
  //       The binding still supplies the target, so the send is confined
  //       without either 3457 guard participating.
  // =========================================================================
  it('M9c conversation-bound session with no conversationKey mirror and no caller target: the binding supplies the target', async () => {
    const boundNoMirror: SessionContext = {
      tier: 'global',
      binding: makeConversationBinding(ALICE_KEY, ALICE_JID),
    };

    const result = await registry.call(
      'send_message',
      { text: 'matrix cell M9c' },
      boundNoMirror,
    );

    expect(result.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(ALICE_JID);

    expect(lastToolCall(db, GLOBAL_CONVERSATION_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });
  });

  // =========================================================================
  // M9d — conversation-bound, top-level conversationKey mirror PRESENT,
  //       NO caller target.
  //       The only cell in which the MESSAGING guard adjudicates a target the
  //       registry itself injected from the binding (registry.ts:704). The
  //       registry guard is unreachable here (the bound arm at registry.ts:691
  //       is taken), but messaging.ts:275 does NOT early-return, because a
  //       conversation-bound session carries tier 'global' and the mirror is
  //       truthy. Both sub-cases live in this one cell: the mirror AGREES with
  //       the binding, and the mirror has DIVERGED from it.
  // =========================================================================
  it('M9d conversation-bound session with the conversationKey mirror present and no caller target: an agreeing mirror is admitted and a diverged mirror is denied by the messaging guard as returned_error/handler', async () => {
    // Sub-case 1 — mirror AGREES with the binding.
    const boundAgreeingMirror: SessionContext = {
      tier: 'global',
      conversationKey: ALICE_KEY,
      binding: makeConversationBinding(ALICE_KEY, ALICE_JID),
    };

    const admitted = await registry.call(
      'send_message',
      { text: 'matrix cell M9d, agreeing mirror' },
      boundAgreeingMirror,
    );

    expect(admitted.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(ALICE_JID);
    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });

    // Sub-case 2 — mirror has DIVERGED from the binding.
    const boundDivergedMirror: SessionContext = {
      tier: 'global',
      conversationKey: BOB_KEY,
      binding: makeConversationBinding(ALICE_KEY, ALICE_JID),
    };

    const diverged = await registry.call(
      'send_message',
      { text: 'matrix cell M9d, diverged mirror' },
      boundDivergedMirror,
    );

    // The MESSAGING guard denies. The JSON envelope shape is what separates it
    // from the registry guard, which denies in PLAIN TEXT (see M1 and M10).
    expect(diverged.isError).toBe(true);
    const envelope = errorEnvelope(diverged);
    expect(envelope.error).toContain('does not match session conversation');
    // The denied target is the one the registry ITSELF injected from the
    // binding at registry.ts:704, and the key it is compared against is the
    // diverged mirror. So this is a false deny of the session's OWN bound
    // conversation, not a cross-conversation escape.
    expect(envelope.error).toContain(ALICE_JID);
    expect(envelope.error).toContain(BOB_KEY);
    // No second dispatch: sub-case 1 sent one message, this sub-case sent none.
    expect(sent).toHaveLength(1);

    // The evidence row is filed under the DIVERGED MIRROR key.
    expect(lastToolCall(db, BOB_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'error',
      failure_code: 'returned_error',
      failure_stage: 'handler',
    });
    // and NOT under the binding key: the newest row there is still sub-case 1,
    // unchanged by this denial.
    expect(lastToolCall(db, ALICE_KEY)).toEqual({
      tool_name: 'send_message',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });
  });
});

// ===========================================================================
// M10 — the registry guard with NO canonical fold armed.
//       Its own describe block: this cell must NOT register the messaging
//       module, because registerMessagingTools is the sole production arming
//       site (messaging.ts:221). A fixture injected tool with no `to`
//       property stands in for the injected-target surface.
// ===========================================================================

describe('cross-conversation guard call-site matrix (3457) — un-armed fold', () => {
  let db: Database;
  let seen: string[];

  beforeEach(() => {
    db = makeDb();
    seen = [];
    seedLidMapping(db, PIN_LID, PIN_PHONE_JID);
  });

  afterEach(() => { db.close(); });

  it('M10 registry guard with no fold armed: a pinned session addressing its OWN conversation by a mapped @lid is denied as authorization_denied/authorization', async () => {
    const registry = new ToolRegistry();
    registry.setDurability(new DurabilityEngine(db));
    registry.register(probeInjectedTool(seen));

    const result = await registry.call(
      'probe_injected_send',
      { chatJid: PIN_LID_JID, text: 'matrix cell M10' },
      { tier: 'global', conversationKey: PIN_PHONE },
    );

    // The un-armed fallback compares the RAW LID digits against the
    // phone-folded session key, so the session's own conversation is
    // rejected. The fallback errs toward rejection EXCEPT where the target's
    // LID local part, after the `:device` strip, is identical to the
    // session's phone-folded key: `toConversationKey` in
    // `src/core/conversation-key.ts` handles the personal and LID domains in
    // ONE switch arm and returns the bare local part for both, so those two
    // keys coincide and the comparison ADMITS instead. Where such a LID is
    // MAPPED to a different phone the admitted target is a foreign
    // conversation, and the armed fold would have resolved that mapped LID to
    // its phone and rejected — so the fallback is not strictly the more
    // conservative of the two. For an UNMAPPED LID the armed fold shares the
    // collision rather than closing it: `resolvePhoneFromJid` in
    // `src/core/access-list.ts` falls back to the bare LID digits when the
    // mapping misses. Whether any live LID collides with a session phone this
    // way is NOT established here; the collision is a property of the fold.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not match session conversation');
    expect(result.content[0].text).toContain(`resolves to conversation "${PIN_LID}"`);
    expect(seen).toHaveLength(0);

    expect(lastToolCall(db, PIN_PHONE)).toEqual({
      tool_name: 'probe_injected_send',
      status: 'error',
      failure_code: 'authorization_denied',
      failure_stage: 'authorization',
    });
  });

  it('M10 control: the SAME call is admitted once the canonical fold is armed', async () => {
    const registry = new ToolRegistry();
    registry.setDurability(new DurabilityEngine(db));
    registry.register(probeInjectedTool(seen));
    registry.setCanonicalConversationKeyResolver((jid) => canonicalConversationKey(jid, db));

    const result = await registry.call(
      'probe_injected_send',
      { chatJid: PIN_LID_JID, text: 'matrix cell M10 control' },
      { tier: 'global', conversationKey: PIN_PHONE },
    );

    // Differential control for M10: the only difference between this call and
    // the one above is the armed fold, so the denial above is attributable to
    // the missing fold and to nothing else.
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([PIN_LID_JID]);

    expect(lastToolCall(db, PIN_PHONE)).toEqual({
      tool_name: 'probe_injected_send',
      status: 'complete',
      failure_code: null,
      failure_stage: null,
    });
  });
});
