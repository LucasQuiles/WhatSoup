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
import { createHash } from 'node:crypto';
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
import { deriveCapabilityDecision as deriveDecisionForTurn } from './capability-obligation-decision.ts';
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
  liveFacts: () => CapabilityObligationLiveFacts;
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

/**
 * D6 execution evidence: the resolver EMITS a structured marker line in its
 * result (`<evidenceMarker>{json}`); the receipt's source digest is DERIVED
 * from that evidence — media work must report the sha256 of the bytes it
 * actually processed, everything else the exact source it executed against.
 * Shell text is never inferred from. Absent/malformed evidence derives null,
 * which records as an error receipt and can never complete an obligation.
 */
export function parseExecutionEvidence(
  marker: string,
  content: string,
): { source?: unknown; mediaSha256?: unknown } | null {
  const at = content.indexOf(marker);
  if (at === -1) return null;
  const line = content.slice(at + marker.length).split('\n', 1)[0] ?? '';
  try {
    const parsed = JSON.parse(line.trim()) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as { source?: unknown; mediaSha256?: unknown };
  } catch {
    // intentional: malformed evidence is simply not evidence — the receipt
    // records as error rather than guessing at what executed.
    return null;
  }
}

/**
 * Does a provider tool invocation EXECUTE the declared capability? Loading a
 * skill (the provider's Skill tool) is NOT execution — only an invocation of
 * the instance-declared execution tool whose input carries the declared marker
 * is tracked. This is only the TRACKING filter; proof comes from the
 * structured result evidence below.
 */
export function matchesCapabilityExecution(
  rule: CapabilityObligationsOptions['receipt'],
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  if (toolName !== rule.toolName) return false;
  return Object.values(toolInput).some(
    (value) => typeof value === 'string' && value.includes(rule.commandMarker),
  );
}

/** Derive the observed source digest from parsed evidence, or null. */
export function deriveObservedSourceDigest(
  obligation: Pick<CapabilityObligationDueRow, 'retainedMediaPath'>,
  evidence: { source?: unknown; mediaSha256?: unknown } | null,
): string | null {
  if (evidence === null) return null;
  if (obligation.retainedMediaPath !== null) {
    return typeof evidence.mediaSha256 === 'string' && /^[0-9a-f]{64}$/.test(evidence.mediaSha256)
      ? evidence.mediaSha256
      : null;
  }
  if (typeof evidence.source !== 'string' || evidence.source.length === 0) return null;
  return createHash('sha256').update(evidence.source).digest('hex');
}

interface ActiveObligationTurn {
  obligation: CapabilityObligationDueRow;
  mintedMessageId: string;
  fence: CapabilityObligationClaimFence;
  attemptNumber: number;
  /** toolId → toolName for capability-matching tool_use events seen this turn. */
  pendingToolIds: Map<string, string>;
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
  private readonly activeTurns = new Map<string, ActiveObligationTurn>();
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
    this.supervisor = new CapabilityObligationSupervisor({
      db: deps.db,
      store: deps.store,
      mediaMaxAgeSeconds: deps.options.retentionHorizonDays * 86_400,
      attestationPort: {
        binding: (obligation): CapabilityAttestationBinding => ({
          ...deps.liveFacts(),
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

  // ── D6 receipt recorder (provider stream tap) ─────────────────────────────

  /**
   * The runtime's per-chat stream handler forwards typed tool events here.
   * Only events on a mapKey with an active obligation-owned turn are examined;
   * everything else is a no-op.
   */
  onStreamEvent(mapKey: string | undefined, event: AgentEvent, logicalTurnId?: string): void {
    if (mapKey === undefined) return;
    const active = this.activeTurns.get(mapKey);
    if (active === undefined) return;
    if (event.type === 'tool_use') {
      if (matchesCapabilityExecution(this.options.receipt, event.toolName, event.toolInput)) {
        active.pendingToolIds.set(event.toolId, event.toolName);
      }
      return;
    }
    if (event.type !== 'tool_result') return;
    const toolName = active.pendingToolIds.get(event.toolId);
    if (toolName === undefined) return;
    active.pendingToolIds.delete(event.toolId);
    // D6 item 3: an 'ok' receipt needs a non-error result, the declared
    // minimum of output, AND structured evidence whose DERIVED source digest
    // reproduces the obligation's — never inference from shell text.
    const evidence = parseExecutionEvidence(this.options.receipt.evidenceMarker, event.content);
    const derivedSourceDigest = deriveObservedSourceDigest(active.obligation, evidence);
    const evidentOk =
      !event.isError
      && event.content.length >= this.options.receipt.minOutputBytes
      && derivedSourceDigest !== null
      && derivedSourceDigest === active.obligation.sourceDigest;
    try {
      this.store.recordExecutionReceipt({
        obligationId: active.obligation.id,
        // Prefer the live runtime turn identity; the minted inbound id is the
        // deterministic fallback correlate for the same turn.
        logicalTurnId: logicalTurnId ?? active.mintedMessageId,
        toolUseId: event.toolId,
        skillName: this.options.attestation.skillName,
        contractVersion: active.obligation.contractVersion,
        inputDigest: active.obligation.inputDigest,
        mediaDigest: active.obligation.mediaSha256,
        resultStatus: evidentOk ? 'ok' : 'error',
        outputEvidence: {
          toolName,
          contentBytes: event.content.length,
          isError: event.isError,
          evidencePresent: evidence !== null,
        },
        sourceDigest: derivedSourceDigest,
        claimEpoch: active.fence.claimEpoch,
        attemptNumber: active.attemptNumber,
      });
    } catch (err) {
      // Never crash the stream loop; a missing receipt fails CLOSED (the
      // obligation cannot complete without one — it quarantines instead).
      log.error({ err, obligationId: active.obligation.id }, 'execution receipt persistence failed');
    }
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
    this.activeTurns.set(mapKey, {
      obligation,
      mintedMessageId,
      fence,
      attemptNumber,
      pendingToolIds: new Map(),
    });
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
      text: obligation.replayText,
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
    text: obligation.replayText,
    isGroup: source.isGroup,
    groupName: source.groupName,
    contentType: 'text',
    runtimeContext,
    inboundSeq: mintedSeq,
  };
  try {
    await coordinator.processPerChatTurn(
      { value: target.mapKey },
      turn,
      undefined,
      () => isTargetCurrent(target),
      () => {},
    );
  } catch (err) {
    log.warn({ err, obligationId: obligation.id }, 'obligation turn dispatch failed');
    return 'retryable';
  }
  return 'dispatched';
}
