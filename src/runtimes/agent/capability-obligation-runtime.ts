/**
 * Capability-obligation runtime integration (capability-obligation replay,
 * steps 7b-8): the REAL ports behind the obligation supervisor, wired to the
 * live durability schema and the normal per-chat turn pipeline.
 *
 *  - ATTESTATION port (D5): live runtime facts + the instance-declared
 *    activation options produce the exact binding `findAdmissibleAttestation`
 *    matches. A fact that cannot be resolved (e.g. release SHA outside a
 *    deployed release dir) yields a sentinel that never matches — fail closed,
 *    obligations simply wait.
 *  - DISPATCH port (D7): the runtime-supplied closure journals a NEW minted
 *    inbound (`obl:<id>:<attempt>`) through `durability.journalInbound` and
 *    enters `createRuntimeTurnForDispatch`/`processPerChatTurn` — the same
 *    live pipeline as a real inbound, never a parallel send path.
 *  - RECEIPT recorder (D6): for the duration of an obligation-owned turn, the
 *    runtime's provider stream tap forwards typed `tool_use`/`tool_result`
 *    events; invocations matching the obligation's declared capability params
 *    persist attempt-bound execution receipts.
 *  - EVIDENCE port (D6/D7): provider acceptance = the minted inbound exists in
 *    `inbound_events`; completion = attempt-bound non-error receipt + the
 *    minted turn's terminal record with echoed delivery proof; a terminal
 *    record without that full chain is AMBIGUOUS and quarantines. Post-
 *    acceptance outcomes are never auto-retried; the bounded-retry path is the
 *    pre-acceptance `retryable` dispatch outcome.
 *
 * The whole feature is all-or-inert: this module is only constructed when
 * `agentOptions.capabilityObligations` parsed with `enabled: true`.
 */
import { hostname, userInfo } from 'node:os';

import type { CapabilityAttestationBinding } from '../../core/capability-attestation.ts';
import type { CapabilityObligationsOptions } from '../../core/capability-contract.ts';
import type {
  CapabilityDecisionParams,
  CapabilityObligationClaimFence,
  CapabilityObligationDueRow,
  CapabilityObligationStore,
} from '../../core/capability-obligation-store.ts';
import { CURRENT_SCHEMA_MIGRATION, type Database } from '../../core/database.ts';
import { cleanupUnreferencedMedia } from '../../core/obligation-media-retention.ts';
import { systemClock } from '../../lib/clock.ts';
import { createChildLogger } from '../../logger.ts';
import type { ExternalEffectDeclaration } from '../../mcp/external-effect.ts';
import type { ToolDeclaration } from '../../mcp/types.ts';
import { deriveCapabilityDecision as deriveDecisionForTurn } from './capability-obligation-decision.ts';
import {
  buildCapabilityExecutionTool,
  type ActiveObligationExecution,
} from './capability-obligation-execution-tool.ts';
import {
  CapabilityObligationSupervisor,
  type ObligationDispatchOutcome,
  type ObligationSettlementEvidence,
} from './capability-obligation-supervisor.ts';
import { executionModeForProvider } from './providers/index.ts';
import type {
  RuntimeTurnCoordinator,
  RuntimeTurnSourceSnapshot,
} from './runtime-turn-coordinator.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';
import type { SessionManager } from './session.ts';
import type { AgentEvent } from './stream-parser.ts';
import type { QueuedTurn } from './turn-queue.ts';
import type { TurnRecoveryDispatchTarget } from './turn-recovery-supervisor.ts';

const log = createChildLogger('agent:capability-obligation-runtime');

export const OBLIGATION_SCAN_INTERVAL_MS = 30_000;

export interface CapabilityObligationLiveFacts {
  hostId: string;
  runtimeUser: string;
  releaseSha: string;
  schemaVersion: number;
  providerId: string;
  harnessType: string;
}

export interface CapabilityObligationRuntimeDeps {
  db: Database;
  store: CapabilityObligationStore;
  options: CapabilityObligationsOptions;
  /**
   * D5 live binding facts for the provider SERVING a given chat (r13 F4). The
   * caller resolves the effective/fallback provider of the target session (not the
   * configured primary), so attestation admits only against the harness that will
   * actually execute; an unresolvable session yields a fail-closed sentinel.
   */
  liveFacts: (deliveryJid: string) => CapabilityObligationLiveFacts;
  /**
   * The live durability engine, or null before setDurability. A null engine at
   * dispatch time makes the attempt retryable (never a crash).
   */
  getDurability: () => {
    journalInbound: (messageId: string, conversationKey: string, chatJid: string, routedTo: string) => number;
  } | null;
  /**
   * Enter the normal per-chat pipeline for the minted, already-journaled
   * inbound. 'retryable' = target/session not current (cold, superseded, shut
   * down); the obligation requeues under bounded backoff.
   */
  dispatchTurn: (
    obligation: CapabilityObligationDueRow,
    mintedMessageId: string,
    mintedSeq: number,
  ) => Promise<ObligationDispatchOutcome>;
  /**
   * Map a delivery JID to the runtime's per-chat map key (LID aliasing means
   * these can differ). The stream tap and the dispatch recorder must agree on
   * this key. Defaults to identity for unit tests.
   */
  resolveMapKey?: (deliveryJid: string) => string;
  /** D2 declaration lookup from the live tool registry (creation-seam fold). */
  externalEffectFor: (toolName: string) => ExternalEffectDeclaration | undefined;
  /** AS-04: registry tool-durability write-loss signal for the fold window. */
  writeLossSince: (sinceMs: number) => boolean;
  /** Registers the trusted `execute_capability` tool (activation-scoped). */
  registerTool: (tool: ToolDeclaration) => void;
  /** Live logical turn id owning a conversation (shared correlation resolver). */
  turnIdFor: (conversationKey: string) => string | null;
  scanIntervalMs?: number;
}

/**
 * AS-04 record-time turn correlation: per-chat turns are serialized per
 * conversation, so the head of a mapKey's context list IS the turn currently
 * owning that conversation. Used by the registry's single tool_calls writer.
 */
export function turnCorrelationFromContexts(
  contexts: ReadonlyMap<string, readonly RuntimeTurnContext[]>,
  conversationKey: string,
): { logicalTurnId: string; inboundSeq: number | null } | null {
  for (const list of contexts.values()) {
    const head = list[0];
    if (head?.identity.conversationKey === conversationKey) {
      return { logicalTurnId: head.identity.logicalTurnId, inboundSeq: head.identity.inboundSeq };
    }
  }
  return null;
}



export class CapabilityObligationRuntime {
  readonly supervisor: CapabilityObligationSupervisor;
  private readonly db: Database;
  private readonly store: CapabilityObligationStore;
  private readonly options: CapabilityObligationsOptions;
  private readonly resolveMapKey: (deliveryJid: string) => string;
  private readonly externalEffectFor: (toolName: string) => ExternalEffectDeclaration | undefined;
  private readonly writeLossSince: (sinceMs: number) => boolean;
  private readonly scanIntervalMs: number;
  private readonly activeTurns = new Map<string, ActiveObligationExecution>();
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private tickInFlight: Promise<unknown> | null = null;
  private closed = false;

  constructor(deps: CapabilityObligationRuntimeDeps) {
    this.db = deps.db;
    this.store = deps.store;
    this.options = deps.options;
    this.resolveMapKey = deps.resolveMapKey ?? ((jid) => jid);
    this.externalEffectFor = deps.externalEffectFor;
    this.writeLossSince = deps.writeLossSince;
    this.scanIntervalMs = deps.scanIntervalMs ?? OBLIGATION_SCAN_INTERVAL_MS;
    // D6 trusted execution seam: receipts are written ONLY by this handler.
    deps.registerTool(
      buildCapabilityExecutionTool({
        store: deps.store,
        options: deps.options,
        findActiveTurn: (conversationKey) => this.findActiveTurn(conversationKey),
        turnIdFor: deps.turnIdFor,
      }),
    );
    this.supervisor = new CapabilityObligationSupervisor({
      db: deps.db,
      store: deps.store,
      mediaMaxAgeSeconds: deps.options.retentionHorizonDays * 86_400,
      attestationPort: {
        binding: (obligation): CapabilityAttestationBinding => ({
          ...deps.liveFacts(obligation.deliveryJid),
          contractVersion: obligation.contractVersion,
          capability: obligation.requiredCapability,
          skillName: this.options.attestation.skillName,
          skillVersion: this.options.attestation.skillVersion,
          skillDigest: this.options.attestation.skillDigest,
          resolverDigest: this.options.attestation.resolverDigest,
          dependencyVersions: this.options.attestation.dependencyVersions,
          probeVersion: this.options.attestation.probeVersion,
          canaryId: this.options.attestation.canaryId,
          mediaRoot: this.options.mediaRoot,
        }),
      },
      dispatchPort: {
        dispatch: (obligation, mintedMessageId, fence, attemptNumber) =>
          this.dispatch(deps, obligation, mintedMessageId, fence, attemptNumber),
      },
      evidencePort: {
        providerAcceptedIds: () => this.providerAcceptedIds(),
        settlementEvidence: (id, attempt) => this.settlementEvidence(id, attempt),
      },
    });
  }

  // ── lifecycle (mirrors the turn-recovery supervisor's unref'd loop) ────────

  start(): void {
    if (this.closed || this.scanTimer !== null) return;
    this.scheduleTick();
  }

  stop(): void {
    this.closed = true;
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    if (this.tickInFlight) {
      try {
        await this.tickInFlight;
      } catch (err) {
        log.warn({ err }, 'obligation tick in flight during shutdown failed');
      }
    }
  }

  /** Single-flight: a tick already in progress is awaited, not re-entered. */
  tickOnce(): Promise<unknown> {
    if (this.tickInFlight) return this.tickInFlight;
    const run = this.supervisor
      .tick()
      .then(async (report) => {
        await this.collectExpiredMedia();
        return report;
      })
      .catch((err) => {
        log.error({ err }, 'capability-obligation tick failed');
        return null;
      })
      .finally(() => {
        this.tickInFlight = null;
      });
    this.tickInFlight = run;
    return run;
  }

  /**
   * A-08 finite retention: retained bytes survive only while some live
   * obligation inside the horizon references them; everything else is removed
   * once older than the horizon. Runs outside any DB transaction (D3).
   */
  private async collectExpiredMedia(): Promise<void> {
    const horizonMs = this.options.retentionHorizonDays * 86_400_000;
    try {
      await cleanupUnreferencedMedia(
        { root: this.options.mediaRoot, policyVersion: this.options.retentionPolicyVersion },
        {
          referencedPaths: this.store.listRetainedMediaReferences({
            mediaMaxAgeSeconds: this.options.retentionHorizonDays * 86_400,
          }),
          graceMs: horizonMs,
        },
      );
    } catch (err) {
      log.warn({ err }, 'retained-media horizon GC failed; will retry next tick');
    }
  }

  private scheduleTick(): void {
    if (this.closed) return;
    this.scanTimer = setTimeout(() => {
      void this.tickOnce().finally(() => {
        this.scanTimer = null;
        this.scheduleTick();
      });
    }, this.scanIntervalMs);
    this.scanTimer.unref?.();
  }

  // ── D6 trusted execution lookup ───────────────────────────────────────────

  /** The active obligation-owned turn for a conversation, if any. */
  findActiveTurn(conversationKey: string): ActiveObligationExecution | null {
    for (const active of this.activeTurns.values()) {
      if (active.obligation.conversationKey === conversationKey) return active;
    }
    return null;
  }

  // ── ports ─────────────────────────────────────────────────────────────────

  private async dispatch(
    deps: CapabilityObligationRuntimeDeps,
    obligation: CapabilityObligationDueRow,
    mintedMessageId: string,
    fence: CapabilityObligationClaimFence,
    attemptNumber: number,
  ): Promise<ObligationDispatchOutcome> {
    let mintedSeq: number;
    try {
      const durability = deps.getDurability();
      if (!durability) throw new Error('durability unavailable for obligation dispatch');
      mintedSeq = durability.journalInbound(
        mintedMessageId,
        obligation.conversationKey,
        obligation.deliveryJid,
        'agent',
      );
    } catch (err) {
      log.warn({ err, obligationId: obligation.id }, 'minted inbound journaling failed; requeueing');
      return 'retryable';
    }
    const mapKey = this.resolveRecorderKey(obligation.deliveryJid);
    this.activeTurns.set(mapKey, { obligation, mintedMessageId, fence, attemptNumber });
    try {
      return await deps.dispatchTurn(obligation, mintedMessageId, mintedSeq);
    } finally {
      this.activeTurns.delete(mapKey);
    }
  }

  /** The shared recorder-key rule for the dispatch registration and the tap. */
  resolveRecorderKey(deliveryJid: string): string {
    return this.resolveMapKey(deliveryJid);
  }

  /**
   * The CREATION seam (D1/D2/D3): derive the C3 capability decision for a
   * finalizing turn. The harness is the execution mode of the provider that
   * SERVED the turn (fallback-aware, read from the live session).
   */
  deriveCapabilityDecision(
    context: RuntimeTurnContext,
    session: { getProviderId?: () => string | null } | null,
  ): Promise<CapabilityDecisionParams | undefined> {
    // Defensive typeof mirrors the runtime's other getProviderId call sites.
    const providerId =
      session !== null && typeof session.getProviderId === 'function' ? session.getProviderId() : null;
    return deriveDecisionForTurn(
      {
        db: this.db,
        options: this.options,
        externalEffectFor: this.externalEffectFor,
        writeLossSince: this.writeLossSince,
      },
      context,
      providerId === null ? null : resolveHarnessType(providerId),
    );
  }

  private providerAcceptedIds(): ReadonlySet<number> {
    const rows = this.db.raw
      .prepare(
        `SELECT o.id AS id FROM capability_obligations o
         JOIN inbound_events ie ON ie.message_id = ('obl:' || o.id || ':' || o.attempt_count)
         WHERE o.state = 'claimed'`,
      )
      .all() as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  private settlementEvidence(
    id: number,
    attempt: { claimEpoch: number; attemptCount: number },
  ): ObligationSettlementEvidence | undefined {
    const minted = `obl:${id}:${attempt.attemptCount}`;
    const inbound = this.db.raw
      .prepare('SELECT seq FROM inbound_events WHERE message_id = ? ORDER BY seq DESC LIMIT 1')
      .get(minted) as { seq: number } | undefined;
    if (inbound === undefined) return undefined; // never accepted — lease reclaim decides
    const terminal = this.db.raw
      .prepare(
        `SELECT id, delivery_kind, delivery_op_id, logical_turn_id FROM turn_terminal_records
         WHERE inbound_seq = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(inbound.seq) as
      | { id: number; delivery_kind: string; delivery_op_id: number | null; logical_turn_id: string }
      | undefined;
    if (terminal === undefined) return undefined; // turn still running under the lease
    const receipt = this.db.raw
      .prepare(
        `SELECT id FROM capability_execution_receipts
         WHERE obligation_id = ? AND claim_epoch = ? AND attempt_number = ? AND result_status = 'ok'
           AND logical_turn_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id, attempt.claimEpoch, attempt.attemptCount, terminal.logical_turn_id) as
      | { id: number }
      | undefined;
    if (
      receipt !== undefined
      && terminal.delivery_kind === 'echoed'
      && terminal.delivery_op_id !== null
    ) {
      return {
        kind: 'completed',
        executionReceiptId: receipt.id,
        completionProofId: `ttr:${terminal.id}`,
      };
    }
    // Accepted + terminal without the full receipt/delivery chain: the
    // execution outcome is not provable — quarantine (D6). Post-acceptance
    // outcomes are never auto-retried.
    return { kind: 'ambiguous' };
  }
}

/** Construct AND start — the one-call activation runtime.ts uses in setDurability. */
export function activateCapabilityObligationRuntime(
  deps: CapabilityObligationRuntimeDeps,
): CapabilityObligationRuntime {
  const runtime = new CapabilityObligationRuntime(deps);
  runtime.start();
  return runtime;
}

/**
 * The release identity the D5 binding carries. Deployed processes run from a
 * pinned `WhatSoup-release-<sha>/` tree (or declare WHATSOUP_RELEASE_SHA); a
 * tree with neither yields a sentinel no ops-produced attestation will ever
 * name — admission fails closed and obligations wait.
 */
export function resolveReleaseIdentity(cwd: string, env: Record<string, string | undefined>): string {
  const fromEnv = env['WHATSOUP_RELEASE_SHA'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const match = /WhatSoup-release-([0-9a-f]{7,40})$/.exec(cwd);
  return match?.[1] ?? 'unreleased-dev-tree';
}

/**
 * The harness type the D5 binding carries. An unknown provider id yields a
 * sentinel no attestation will ever name — admission fails closed.
 */
export function resolveHarnessType(providerId: string): string {
  try {
    return executionModeForProvider(providerId as Parameters<typeof executionModeForProvider>[0]);
  } catch {
    // intentional: an unregistered provider id must never admit a claim — the
    // sentinel harness type simply never matches a recorded attestation.
    return 'unknown_harness';
  }
}

/**
 * The fail-closed sentinel provider id used when the serving provider of a chat
 * cannot be determined. resolveHarnessType maps it to 'unknown_harness', which
 * never matches a recorded attestation — so admission fails closed and the
 * obligation waits rather than running on an unverified harness (r13 F4).
 */
export const UNRESOLVED_SERVING_PROVIDER = 'unresolved-serving-provider';

/**
 * The provider ACTUALLY serving a chat, read from its live session's
 * effective/fallback provider (r13 F4). Returns the fail-closed sentinel when the
 * session is absent or does not report a provider — never the configured primary,
 * which is the defect this closes.
 */
export function servingProviderId(session: { getProviderId?: () => string | null } | null | undefined): string {
  const providerId =
    session && typeof session.getProviderId === 'function' ? session.getProviderId() : null;
  return providerId ?? UNRESOLVED_SERVING_PROVIDER;
}

/** Live D5 binding facts for the running process (extracted from runtime.ts). */
export function buildObligationLiveFacts(providerId: string): CapabilityObligationLiveFacts {
  return {
    hostId: hostname(),
    runtimeUser: userInfo().username,
    releaseSha: resolveReleaseIdentity(process.cwd(), process.env),
    schemaVersion: CURRENT_SCHEMA_MIGRATION,
    providerId,
    harnessType: resolveHarnessType(providerId),
  };
}

/**
 * Capability-obligation dispatch (D7), extracted from runtime.ts (arch.file-size
 * ratchet — same shape as dispatchTurnRecoveryReplayForJob): enter the SAME
 * per-chat live pipeline as a real inbound for the already-journaled minted
 * inbound — never a parallel send path. 'retryable' covers every
 * not-current/cold/failed case; the obligation supervisor requeues bounded.
 */
/**
 * The minted obligation turn's prompt. The replayed turn enters the SAME
 * per-chat pipeline as a real inbound; if it carried only the bare original
 * message the agent would answer from memory (or not at all) and never call
 * execute_capability — the obligation would quarantine and the request would
 * never drain. This deterministic envelope names the required capability and the
 * EXACT source the agent must pass (the retained media path, or the persisted
 * source token — its sha256 is the obligation's source_digest, so the handler's
 * digest check matches), and preserves the original message for context. Pure:
 * no clock, no randomness.
 */
export function composeCapabilityObligationReplayPrompt(obligation: CapabilityObligationDueRow): string {
  const source = obligation.retainedMediaPath ?? obligation.sourceToken ?? '';
  return [
    `[capability-obligation replay #${obligation.id}]`,
    `An earlier turn in this chat could not fulfil a required capability (${obligation.requiredCapability}).`,
    'To fulfil it you MUST call the execute_capability tool with its `source` set EXACTLY to the following (do not alter, normalise, or re-derive it):',
    source,
    'The runtime runs the declared resolver itself and returns its output; compose your reply from that output and do not answer from prior knowledge.',
    'Original message:',
    obligation.replayText,
  ].join('\n');
}

export async function dispatchCapabilityObligationTurnViaSession(
  coordinator: RuntimeTurnCoordinator,
  resolveTarget: (deliveryJid: string) => TurnRecoveryDispatchTarget | null,
  requireSessionToolScopeKey: (session: SessionManager) => string,
  isTargetCurrent: (target: TurnRecoveryDispatchTarget) => boolean,
  obligation: CapabilityObligationDueRow,
  mintedMessageId: string,
  mintedSeq: number,
): Promise<ObligationDispatchOutcome> {
  const target = resolveTarget(obligation.deliveryJid);
  if (!target) return 'retryable';
  const session = target.session as SessionManager;
  // The minted turn must INSTRUCT the agent to run the capability (naming the
  // exact source); the bare replay text alone would quarantine silently.
  const replayPrompt = composeCapabilityObligationReplayPrompt(obligation);
  const source: RuntimeTurnSourceSnapshot = {
    sourceMessageId: mintedMessageId,
    receivedAtUnixSeconds: systemClock.nowUnixSec(),
    conversationKey: obligation.conversationKey,
    senderJid: obligation.senderJid,
    senderName: obligation.senderName,
    contentType: 'text',
    isGroup: obligation.isGroup,
    ...(obligation.isGroup ? { groupName: obligation.groupName ?? obligation.deliveryJid } : {}),
  };
  let runtimeContext: RuntimeTurnContext | null;
  try {
    runtimeContext = coordinator.createRuntimeTurnForDispatch({
      scope: 'per_chat',
      chatJid: obligation.deliveryJid,
      text: replayPrompt,
      inboundSeq: mintedSeq,
      source,
      session,
      toolScopeKey: requireSessionToolScopeKey(session),
      mapKey: target.mapKey,
    });
  } catch (err) {
    log.warn({ err, obligationId: obligation.id }, 'obligation turn context construction failed');
    return 'retryable';
  }
  if (!runtimeContext) return 'retryable';
  const turn: QueuedTurn = {
    sourceMessageId: mintedMessageId,
    receivedAtUnixSeconds: source.receivedAtUnixSeconds,
    conversationKey: obligation.conversationKey,
    chatJid: obligation.deliveryJid,
    senderJid: obligation.senderJid,
    senderName: obligation.senderName,
    text: replayPrompt,
    isGroup: source.isGroup,
    groupName: source.groupName,
    contentType: 'text',
    runtimeContext,
    inboundSeq: mintedSeq,
  };
  // Track the REAL provider boundary. Once the turn crosses it, the capability
  // side effect may already have happened, so a subsequent failure is AMBIGUOUS,
  // not retryable (spec §3.2: an ambiguous provider outcome ⇒ blocked_ambiguous,
  // never auto-retried). Discarding this signal (the old `() => {}`) let every
  // post-boundary exception fall through to 'retryable' and auto-re-execute.
  let providerBoundaryCrossed = false;
  try {
    await coordinator.processPerChatTurn(
      { value: target.mapKey },
      turn,
      undefined,
      () => isTargetCurrent(target),
      () => { providerBoundaryCrossed = true; },
    );
  } catch (err) {
    if (providerBoundaryCrossed) {
      log.warn({ err, obligationId: obligation.id }, 'obligation turn failed AFTER the provider boundary; quarantining ambiguous');
      return 'ambiguous';
    }
    log.warn({ err, obligationId: obligation.id }, 'obligation turn dispatch failed pre-boundary; retryable');
    return 'retryable';
  }
  return 'dispatched';
}
