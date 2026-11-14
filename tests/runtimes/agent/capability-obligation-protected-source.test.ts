/**
 * A capability obligation whose source token carries a protected link is
 * refused at dispatch: it ends `cancelled` with the reason
 * `protected_link_source_refused`, no replay prompt reaches the turn pipeline,
 * and the stored row keeps its raw source token and digest, so the D6 check
 * sha256(source) == source_digest still holds. A protected link is a secret for
 * one person's browser and may be single-use, so an agent must never fetch it.
 *
 * Every dispatch path runs through the live wiring
 * (`maybeActivateCapabilityObligationRuntime`), so the real replay-prompt
 * builder sits behind the recording coordinator: a leak would show up as a
 * recorded prompt, not be inferred.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));

import { recordCapabilityAttestation } from '../../../src/core/capability-attestation.ts';
import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import { drainObligationNow } from '../../../src/runtimes/agent/capability-obligation-drain-now.ts';
import {
  buildObligationLiveFacts,
  maybeActivateCapabilityObligationRuntime,
  shutdownCapabilityObligationRuntimeSafely,
  type CapabilityObligationRuntime,
} from '../../../src/runtimes/agent/capability-obligation-runtime.ts';
import { TEST_LINK_HOST } from '../../helpers/protected-delivery-pins.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { trustedNodePath } from '../../helpers/trusted-node.ts';

const PROTECTED_LINK = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
const NEUTRAL_SOURCE = 'https://media.example.test/clip';
const CONVERSATION_KEY = 'conv-protected-source';
const DELIVERY_JID = 'test-protected-source@lid';
const SERVING_PROVIDER = 'claude-cli';
// The in-tree bounded lowercase tag rule (`ERROR_CLASS_RE`, deferred-turn-store.ts).
const BOUNDED_TAG = /^[a-z0-9_.:-]{1,64}$/;

const OPTIONS = parseCapabilityObligationsOptions({
  enabled: true,
  contract: {
    version: 'test-contract/1',
    rules: [{ id: 'watch-url', kind: 'url_host', hosts: ['media.example.test'], capability: 'child_process_tools' }],
  },
  mediaRoot: '/var/obligation-media',
  retentionPolicyVersion: 'policy/1',
  retentionHorizonDays: 30,
  // Never executed here: the turn fake records the prompt and stops.
  execution: {
    interpreter: trustedNodePath(),
    resolverArtifactPath: '/nonexistent/resolver.cjs',
    args: ['{source}'],
    timeoutMs: 30_000,
    minOutputBytes: 8,
  },
  attestation: {
    skillName: 'watch',
    skillVersion: '1.0.0',
    skillDigest: 'skill-digest-1',
    resolverDigest: 'resolver-digest-1',
    dependencyVersions: { 'yt-dlp': '2026.03.17' },
    probeVersion: 'probe/1',
    canaryId: 'canary-1',
  },
}) as CapabilityObligationsOptions;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

let db: Database;
let store: CapabilityObligationStore;
let runtime: CapabilityObligationRuntime | null = null;
/** Text handed to the turn pipeline: the context text and the queued turn text. */
let prompts: string[];

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
  prompts = [];
});

afterEach(async () => {
  expect(await shutdownCapabilityObligationRuntimeSafely(runtime)).toBeNull();
  runtime = null;
  db.close();
});

function seedObligation(sourceToken: string): number {
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: 1,
        sourceMessageId: 'protected-source-1',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        senderJid: 'test-sender@lid',
        senderName: 'Test Sender',
        // Not a group: a group waits for its drain approval before it is due.
        isGroup: false,
        groupName: null,
        scope: 'per_chat',
        originRecoveryJobId: null,
        // Neutral, so only the source token can carry the link into a prompt.
        replayText: 'please watch this clip',
        contentTypeHint: 'text',
        contractVersion: 'test-contract/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: 'aa'.repeat(32),
        sourceDigest: sha256(sourceToken),
        sourceToken,
        retainedMedia: null,
        creationReason: 'harness_capability_gap',
      },
    }).obligationId!;
  });
  return id;
}

/** An attestation for this process's live facts, so admission really admits. */
function admittingAttestation(): void {
  recordCapabilityAttestation(db, {
    ...buildObligationLiveFacts(SERVING_PROVIDER),
    contractVersion: 'test-contract/1',
    capability: 'child_process_tools',
    skillName: OPTIONS.attestation.skillName,
    skillVersion: OPTIONS.attestation.skillVersion,
    skillDigest: OPTIONS.attestation.skillDigest,
    resolverDigest: OPTIONS.attestation.resolverDigest,
    dependencyVersions: OPTIONS.attestation.dependencyVersions,
    probeVersion: OPTIONS.attestation.probeVersion,
    canaryId: OPTIONS.attestation.canaryId,
    mediaRoot: OPTIONS.mediaRoot,
    canaryResult: 'pass',
    nonce: `protected-source-${Math.random().toString(36).slice(2)}`,
    attestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    evidence: { probeStdoutRef: null, probeStderrRef: null, probeExit: null, canaryInputRef: null, mediaRootReadable: null },
  });
}

/** The live wiring with a resolved per_chat target and a recording turn pipeline. */
function activateLiveRuntime(): CapabilityObligationRuntime {
  const session = { getProviderId: () => SERVING_PROVIDER };
  const target = { scope: 'per_chat', session, mapKey: DELIVERY_JID, managerId: 'm1', generation: 1 };
  const host = {
    enabled: true,
    alreadyActive: false,
    options: OPTIONS,
    db,
    store,
    registry: new ToolRegistry(),
    perChatTurnContexts: () => new Map(),
    resolveDispatchTarget: () => target,
    turnCoordinator: {
      createRuntimeTurnForDispatch: (args: { text: string }) => {
        prompts.push(args.text);
        return { ctx: true };
      },
      processPerChatTurn: async (
        _key: unknown, turn: { text: string }, _third: unknown, _allowed: unknown, onBoundary: () => void,
      ) => {
        prompts.push(turn.text);
        onBoundary();
      },
    },
    requireSessionToolScopeKey: () => 'scope-key',
    isDispatchTargetCurrent: () => true,
    getDurability: () => ({
      journalInbound: (messageId: string) => Number(
        db.raw
          .prepare(
            `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
             VALUES (?, ?, ?, 'agent')`,
          )
          .run(messageId, CONVERSATION_KEY, DELIVERY_JID)
          .lastInsertRowid,
      ),
    }),
    resolveMapKey: (jid: string) => jid,
    getChatSession: () => undefined,
    captureOwnedGeneration: () => ({ managerId: 'm1', generation: 1 }),
    activateSpawnedSession: async () => DELIVERY_JID,
  } as unknown as Parameters<typeof maybeActivateCapabilityObligationRuntime>[0];
  const activated = maybeActivateCapabilityObligationRuntime(host);
  if (activated === null) throw new Error('the capability obligation runtime did not activate');
  runtime = activated;
  return activated;
}

function storedRow(id: number) {
  return db.raw
    .prepare('SELECT state, attempt_count, source_token, source_digest FROM capability_obligations WHERE id = ?')
    .get(id) as { state: string; attempt_count: number; source_token: string; source_digest: string };
}

function lastEvent(id: number) {
  return db.raw
    .prepare(
      `SELECT action, actor_type, reason_code FROM capability_obligation_events
       WHERE obligation_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(id) as { action: string; actor_type: string; reason_code: string | null };
}

function mintedInbound(id: number): unknown {
  return db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(`obl:${id}:1`);
}

interface DispatchPath {
  path: string;
  run: (live: CapabilityObligationRuntime, id: number) => Promise<unknown>;
}

const DISPATCH_PATHS: DispatchPath[] = [
  { path: 'scheduled scan (tickOnce, global due-row scan)', run: (live) => live.tickOnce() },
  { path: 'targeted named drain (supervisor.drainNamed)', run: (live, id) => live.supervisor.drainNamed(id) },
  {
    path: 'operator drain-now (drainObligationNow, as the runtime composes it)',
    run: (live, id) =>
      drainObligationNow(
        {
          db,
          store,
          activateSession: async () => true,
          drainNamed: (named) => live.supervisor.drainNamed(named),
          hasAdmissibleAttestationCandidate: () => true,
        },
        id,
      ),
  },
];

describe('capability obligation with a protected-link source token', () => {
  it.each(DISPATCH_PATHS)('$path refuses it terminally and composes no prompt', async ({ run }) => {
    const id = seedObligation(PROTECTED_LINK);
    admittingAttestation();
    const live = activateLiveRuntime();

    await run(live, id);

    const row = storedRow(id);
    expect(row.state).toBe('cancelled');
    expect(row.attempt_count).toBe(0);
    // The stored row stays raw: D6 still matches the token it would execute.
    expect(row.source_token).toBe(PROTECTED_LINK);
    expect(row.source_digest).toBe(sha256(PROTECTED_LINK));
    const event = lastEvent(id);
    expect(event).toEqual({
      action: 'obligation.cancel',
      actor_type: 'supervisor',
      reason_code: 'protected_link_source_refused',
    });
    expect(event.reason_code).toMatch(BOUNDED_TAG);
    // Nothing reached the turn pipeline, and no minted inbound was journaled.
    expect(prompts).toEqual([]);
    expect(mintedInbound(id)).toBeUndefined();
  });

  it.each(DISPATCH_PATHS)('$path still dispatches a neutral source token (positive control)', async ({ run }) => {
    const id = seedObligation(NEUTRAL_SOURCE);
    admittingAttestation();
    const live = activateLiveRuntime();

    await run(live, id);

    const row = storedRow(id);
    expect(row.state).toBe('claimed');
    expect(row.attempt_count).toBe(1);
    expect(mintedInbound(id)).toBeDefined();
    // The context and the queued turn both carry the exact source to execute.
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt.split('\n')).toContain(NEUTRAL_SOURCE);
  });

  it('a refused obligation stays refused: a later scan neither re-arms nor dispatches it', async () => {
    const id = seedObligation(PROTECTED_LINK);
    admittingAttestation();
    const live = activateLiveRuntime();

    await live.tickOnce();
    await live.tickOnce();

    expect(storedRow(id).state).toBe('cancelled');
    expect(
      db.raw
        .prepare("SELECT COUNT(*) AS c FROM capability_obligation_events WHERE obligation_id = ? AND action = 'obligation.cancel'")
        .get(id),
    ).toEqual({ c: 1 });
    expect(prompts).toEqual([]);
  });
});
