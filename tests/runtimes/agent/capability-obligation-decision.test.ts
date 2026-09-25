/**
 * Capability-obligation CREATION seam (D1/D2/D3 production wiring) — the
 * systemic half of the fix. A capability-refused turn served by a
 * child-process-less harness must produce a typed C3 decision: a dispatchable
 * obligation on a conclusive-no-effect match, a typed not_created audit on any
 * uncertainty, and nothing at all when nothing is owed. Real SQLite; the
 * decision is applied through the real store to prove end-to-end validity.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION, type ExternalEffectDeclaration } from '../../../src/mcp/external-effect.ts';
import {
  deriveCapabilityDecision,
  harnessLacksCapability,
} from '../../../src/runtimes/agent/capability-obligation-decision.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';

let db: Database;
let store: CapabilityObligationStore;
let dir: string;

const OPTIONS = parseCapabilityObligationsOptions({
  enabled: true,
  contract: {
    version: 'test-contract/1',
    rules: [
      { id: 'watch-url', kind: 'url_host', hosts: ['youtu.be'], capability: 'child_process_tools' },
      { id: 'watch-token', kind: 'leading_token', token: '/watch', capability: 'child_process_tools' },
      { id: 'watch-doc', kind: 'media_class', mediaClass: 'document', capability: 'child_process_tools' },
    ],
  },
  mediaRoot: '/unused-parse-time-root',
  retentionPolicyVersion: 'policy/1',
  retentionHorizonDays: 30,
  // round-18/20: an enabled config requires an explicit interpreter PATH, an explicit resolver
  // artifact, and an explicit interpreted flag (syntactic Zod validation; paths need not exist here).
  execution: { interpreter: '/usr/bin/node', resolverArtifactPath: '/opt/watch/resolver.cjs', args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8 },
  attestation: {
    skillName: 'watch',
    skillVersion: '1.0.0',
    skillDigest: 'digest-1',
    resolverDigest: 'resolver-1',
    dependencyVersions: {},
    probeVersion: 'probe/1',
    canaryId: 'canary-1',
  },
}) as CapabilityObligationsOptions;

const EFFECTS: Record<string, ExternalEffectDeclaration> = {
  send_message: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
  get_messages: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
};

function makeContext(over: Partial<{
  scope: string;
  sourceMessageId: string;
  text: string;
  contentType: string;
  inboundSeq: number | null;
}> = {}): RuntimeTurnContext {
  return {
    identity: {
      scope: (over.scope as 'per_chat') ?? 'per_chat',
      conversationKey: 'conv-decision',
      deliveryJid: 'test-dm-target@lid',
      inboundSeq: over.inboundSeq === undefined ? 8801 : over.inboundSeq,
      logicalTurnId: 'turn-d1',
      managerId: 'mgr-1',
      generation: 1,
    },
    recoveryOwner: { logicalTurnId: 'owner-1', managerId: 'mgr-1', generation: 1 },
    replay: {
      sourceMessageId: over.sourceMessageId ?? 'TESTMSG-DEC-1',
      receivedAtUnixSeconds: Math.floor(Date.now() / 1000) - 60,
      replaySafe: true,
      senderJid: 'test-sender@s.whatsapp.net',
      senderName: 'Test Sender',
      text: over.text ?? 'check this https://youtu.be/abc123',
      isGroup: false,
      groupName: null,
    },
    contentType: (over.contentType as RuntimeTurnContext['contentType']) ?? 'text',
    toolScopeKey: 'scope-1',
  };
}

function deps(over: { mediaRoot?: string; writeLoss?: boolean } = {}) {
  return {
    db,
    options: { ...OPTIONS, mediaRoot: over.mediaRoot ?? join(dir, 'retained') },
    externalEffectFor: (name: string) => EFFECTS[name],
    writeLossSince: () => over.writeLoss ?? false,
  };
}

function insertToolCall(
  toolName: string,
  status: 'complete' | 'error',
  failureStage: string | null = null,
  // AS-04: rows are turn-correlated by default; null simulates a writer path
  // without a live turn (which must fail the fold closed).
  logicalTurnId: string | null = 'turn-d1',
): void {
  // Satisfies migration-50's status-coherence CHECK for the two statuses the
  // decision-seam fold exercises.
  if (status === 'complete') {
    db.raw
      .prepare(
        `INSERT INTO tool_calls
           (conversation_key, tool_name, tool_group, tool_input, status, replay_policy,
            outcome_code, result, completed_at, retry_disposition, operator_action, evidence_coverage,
            logical_turn_id, source_inbound_seq)
         VALUES ('conv-decision', ?, 'messaging', '[metadata-only]', 'complete', 'unsafe',
                 'success', '[metadata-only:success]', datetime('now'), 'not_applicable', 'none', 'complete',
                 ?, ?)`,
      )
      .run(toolName, logicalTurnId, logicalTurnId === null ? null : 8801);
    return;
  }
  db.raw
    .prepare(
      `INSERT INTO tool_calls
         (conversation_key, tool_name, tool_group, tool_input, status, replay_policy,
          outcome_code, result, completed_at, failure_code, failure_stage,
          retry_disposition, operator_action, evidence_coverage, logical_turn_id, source_inbound_seq)
       VALUES ('conv-decision', ?, 'messaging', '[metadata-only]', 'error', 'unsafe',
               'failure', '[metadata-only:error]', datetime('now'), 'validation_rejected', ?,
               'not_retryable', 'none', 'complete', ?, ?)`,
    )
    .run(toolName, failureStage ?? 'validation', logicalTurnId, logicalTurnId === null ? null : 8801);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
  dir = mkdtempSync(join(tmpdir(), 'obl-decision-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scope and harness gating', () => {
  it('a capability-capable harness owes nothing', async () => {
    expect(await deriveCapabilityDecision(deps(), makeContext(), 'persistent_session')).toBeUndefined();
    expect(await deriveCapabilityDecision(deps(), makeContext(), 'spawn_per_turn')).toBeUndefined();
  });

  it('an unknown serving provider owes nothing (unprovable)', async () => {
    expect(await deriveCapabilityDecision(deps(), makeContext(), null)).toBeUndefined();
  });

  it('minted obligation turns never self-spawn', async () => {
    const context = makeContext({ sourceMessageId: 'obl:7:2' });
    expect(await deriveCapabilityDecision(deps(), context, 'managed_loop')).toBeUndefined();
  });

  it('non-per_chat scopes are out of contract', async () => {
    const context = makeContext({ scope: 'shared' });
    expect(await deriveCapabilityDecision(deps(), context, 'managed_loop')).toBeUndefined();
  });

  it('harnessLacksCapability is managed_loop exactly', () => {
    expect(harnessLacksCapability('managed_loop')).toBe(true);
    expect(harnessLacksCapability('persistent_session')).toBe(false);
    expect(harnessLacksCapability('spawn_per_turn')).toBe(false);
  });
});

describe('D1 evaluation outcomes', () => {
  it('a non-matching inbound owes nothing', async () => {
    const context = makeContext({ text: 'good morning, how are you?' });
    expect(await deriveCapabilityDecision(deps(), context, 'managed_loop')).toBeUndefined();
  });

  it('a conflicting inbound records a typed not_created decision', async () => {
    const context = makeContext({ text: '/watch https://youtu.be/abc' });
    const decision = await deriveCapabilityDecision(deps(), context, 'managed_loop');
    expect(decision?.obligation).toBeUndefined();
    expect(decision?.auditEvent).toMatchObject({
      action: 'obligation.not_created',
      reasonCode: 'not_created_contract_conflict',
    });
  });

  it('an unjournaled source records a typed not_created decision', async () => {
    const context = makeContext({ inboundSeq: null });
    const decision = await deriveCapabilityDecision(deps(), context, 'managed_loop');
    expect(decision?.auditEvent.reasonCode).toBe('not_created_unjournaled_source');
  });
});

describe('D2 effect fold', () => {
  it('a conclusive-no-effect matching turn CREATES the obligation (end-to-end through the store)', async () => {
    insertToolCall('get_messages', 'complete'); // declared-none reads never block
    const decision = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    expect(decision?.obligation).toMatchObject({
      sourceInboundSeq: 8801,
      requiredCapability: 'child_process_tools',
      contractVersion: 'test-contract/1',
      // F6 honesty: creation observes the harness class lacking the declared
      // capability — never a typed model deferral. Migration 59's CHECK refuses
      // the old 'typed_deferral_signal' literal, so the store apply below also
      // pins the vocabulary end-to-end.
      creationReason: 'harness_capability_gap',
    });
    // D6: the source digest is derived from the matched URL token itself, and
    // the token STRING is persisted so the replayed agent passes it verbatim to
    // execute_capability; a URL obligation carries no media.
    expect(decision?.obligation?.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(decision?.obligation?.sourceToken).toBe('https://youtu.be/abc123');
    expect(decision?.obligation?.retainedMedia).toBeNull();
    // The derived decision must be applicable through the REAL C3 store path.
    let outcome: { obligationId: number | null } = { obligationId: null };
    withTransaction(db, () => {
      outcome = store.applyDecisionWithinCallerTransaction(decision!);
    });
    expect(outcome.obligationId).not.toBeNull();
    const row = db.raw
      .prepare('SELECT state, source_token FROM capability_obligations WHERE id=?')
      .get(outcome.obligationId!) as { state: string; source_token: string };
    expect(row.source_token).toBe('https://youtu.be/abc123');
    expect(row.state).toBe('waiting_capability');
  });

  it('an accepted external invocation in the turn window blocks creation (typed not_created)', async () => {
    insertToolCall('send_message', 'complete');
    const decision = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    expect(decision?.obligation).toBeUndefined();
    expect(decision?.auditEvent.reasonCode).toBe('not_created_side_effect_uncertain');
  });

  it('an undeclared tool in the window blocks creation (unknown effect)', async () => {
    insertToolCall('mystery_tool', 'complete');
    const decision = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    expect(decision?.auditEvent.reasonCode).toBe('not_created_side_effect_uncertain');
  });

  it('a pre-accept-failed external invocation does NOT block creation', async () => {
    insertToolCall('send_message', 'error', 'validation');
    const decision = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    expect(decision?.auditEvent.action).toBe('obligation.create');
    expect(decision?.obligation?.requiredCapability).toBe('child_process_tools');
  });

  it('FALSIFIER: an UNCORRELATED row in the window blocks creation, even for a declared-none tool', async () => {
    insertToolCall('get_messages', 'complete', null, null); // no logical_turn_id
    const decision = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    expect(decision?.obligation).toBeUndefined();
    expect(decision?.auditEvent.reasonCode).toBe('not_created_side_effect_uncertain');
  });

  it("FALSIFIER: another turn's accepted external row does not block, but this turn's does", async () => {
    insertToolCall('send_message', 'complete', null, 'some-other-turn');
    const clean = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    expect(clean?.auditEvent.action).toBe('obligation.create');
    insertToolCall('send_message', 'complete', null, 'turn-d1');
    const blocked = await deriveCapabilityDecision(
      deps(),
      makeContext({ sourceMessageId: 'TESTMSG-DEC-2', inboundSeq: 8802 }),
      'managed_loop',
    );
    expect(blocked?.auditEvent.reasonCode).toBe('not_created_side_effect_uncertain');
  });

  it('FALSIFIER: a tool-durability write loss in the window blocks creation', async () => {
    const decision = await deriveCapabilityDecision(deps({ writeLoss: true }), makeContext(), 'managed_loop');
    expect(decision?.obligation).toBeUndefined();
    expect(decision?.auditEvent.reasonCode).toBe('not_created_side_effect_uncertain');
  });

  it('re-deriving for the same source is dedup-suppressed, never a crash', async () => {
    const decision = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    let firstId: number | null = null;
    withTransaction(db, () => {
      firstId = store.applyDecisionWithinCallerTransaction(decision!).obligationId;
    });
    const again = await deriveCapabilityDecision(deps(), makeContext(), 'managed_loop');
    let secondId: number | null = null;
    expect(() =>
      withTransaction(db, () => {
        secondId = store.applyDecisionWithinCallerTransaction(again!).obligationId;
      }),
    ).not.toThrow();
    expect(secondId).toBe(firstId);
    const count = (db.raw.prepare('SELECT COUNT(*) AS c FROM capability_obligations').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('D3 media staging', () => {
  function seedMessageWithMedia(messageId: string, mediaPath: string | null): void {
    db.raw
      .prepare(
        `INSERT INTO messages (message_id, chat_jid, conversation_key, sender_jid, is_from_me, timestamp, content_type, content, media_path)
         VALUES (?, 'test-dm-target@lid', 'conv-decision', 'test-sender@s.whatsapp.net', 0, 1754900000, 'document', 'Weekly Tracker.webm', ?)`,
      )
      .run(messageId, mediaPath);
  }

  it('a document match stages retained media before the decision', async () => {
    const src = join(dir, 'source.webm');
    writeFileSync(src, 'webm-bytes-here');
    seedMessageWithMedia('TESTMSG-DEC-M1', src);
    const context = makeContext({
      sourceMessageId: 'TESTMSG-DEC-M1',
      text: 'Weekly Tracker.webm',
      contentType: 'document',
    });
    const decision = await deriveCapabilityDecision(deps(), context, 'managed_loop');
    expect(decision?.obligation?.retainedMedia).toMatchObject({ bytes: 15, policyVersion: 'policy/1' });
    // Media obligations: source digest IS the retained media digest, and there
    // is no source token (the retained media path is the execution source).
    expect(decision?.obligation?.sourceDigest).toBe(decision?.obligation?.retainedMedia?.sha256);
    expect(decision?.obligation?.sourceToken).toBeNull();
    const retained = decision?.obligation?.retainedMedia;
    expect(retained?.path.startsWith(join(dir, 'retained'))).toBe(true);
    expect(retained?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a document match without a persisted media path records a typed not_created', async () => {
    seedMessageWithMedia('TESTMSG-DEC-M2', null);
    const context = makeContext({
      sourceMessageId: 'TESTMSG-DEC-M2',
      text: 'Weekly Tracker.webm',
      contentType: 'document',
    });
    const decision = await deriveCapabilityDecision(deps(), context, 'managed_loop');
    expect(decision?.auditEvent.reasonCode).toBe('not_created_media_unavailable');
  });

  it('a media staging failure records a typed not_created', async () => {
    seedMessageWithMedia('TESTMSG-DEC-M3', join(dir, 'missing-file.webm'));
    const context = makeContext({
      sourceMessageId: 'TESTMSG-DEC-M3',
      text: 'Weekly Tracker.webm',
      contentType: 'document',
    });
    const decision = await deriveCapabilityDecision(deps(), context, 'managed_loop');
    expect(decision?.auditEvent.reasonCode).toBe('not_created_media_retention_failed');
  });
});
