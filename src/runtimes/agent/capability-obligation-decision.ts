/**
 * Capability-obligation CREATION seam (capability-obligation replay, D1/D2/D3
 * production wiring). This is the systemic half of the fix: when a per-chat
 * turn was served by a harness that LACKS the declared capability, the
 * instance-declared contract is evaluated against the ORIGINAL inbound, the
 * turn's external effects are folded, media is staged, and the resulting typed
 * decision rides the C3 terminal transaction (`finalizeTurnTerminal`) — so a
 * capability-refused turn can never again echo-settle into silence.
 *
 * Fail-closed rules, in order:
 *  - non-per_chat scope, minted (`obl:`) sources, unknown serving provider, or
 *    a capability-capable harness produce NO decision (nothing to owe);
 *  - a contract conflict, an inconclusive effect fold, an unjournaled source,
 *    or a media-staging failure produce a typed `obligation.not_created`
 *    audit event — recorded loss, never silent loss;
 *  - only a conclusive-no-effect match on a journaled source creates the
 *    dispatchable obligation row.
 */
import type { CapabilityObligationsOptions } from '../../core/capability-contract.ts';
import { capabilitySourceDigest, evaluateCapabilityContract } from '../../core/capability-contract.ts';
import type {
  CapabilityDecisionParams,
  CapabilityObligationRetainedMedia,
} from '../../core/capability-obligation-store.ts';
import type { Database } from '../../core/database.ts';
import { retainMediaForObligation } from '../../core/obligation-media-retention.ts';
import { createChildLogger } from '../../logger.ts';
import {
  classifyInvocationEffect,
  foldTurnEffects,
  type ExternalEffectDeclaration,
} from '../../mcp/external-effect.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';

const log = createChildLogger('agent:capability-obligation-decision');

export interface CapabilityDecisionProducerDeps {
  db: Database;
  options: CapabilityObligationsOptions;
  /** D2 declaration lookup from the live tool registry. */
  externalEffectFor: (toolName: string) => ExternalEffectDeclaration | undefined;
  /** AS-04: any tool-durability write loss at or after `sinceMs` (registry signal). */
  writeLossSince: (sinceMs: number) => boolean;
}

/** managed_loop is the harness class with no child processes — it cannot carry
 * the contract's capabilities; every other execution mode can. */
export function harnessLacksCapability(harnessType: string): boolean {
  return harnessType === 'managed_loop';
}

function preparedMediaClass(contentType: string): string | undefined {
  // Audio is transcribed in-process (media-prep) and is unrepresentable in the
  // contract by construction; only document/video are prepared-media classes.
  if (contentType === 'document' || contentType === 'video') return contentType;
  return undefined;
}

function notCreated(reasonCode: string, sourceHash: string | null): CapabilityDecisionParams {
  return {
    auditEvent: {
      action: 'obligation.not_created',
      actorType: 'runtime',
      reasonCode,
      sourceHash,
    },
  };
}

/**
 * Derive the C3 capability decision for a finalizing turn, or undefined when
 * the turn owes nothing. `harnessType` is the execution mode of the provider
 * that actually SERVED the turn (fallback-aware), not the configured primary.
 */
export async function deriveCapabilityDecision(
  deps: CapabilityDecisionProducerDeps,
  context: RuntimeTurnContext,
  harnessType: string | null,
): Promise<CapabilityDecisionParams | undefined> {
  if (context.identity.scope !== 'per_chat') return undefined;
  // Never self-spawn: an obligation-owned minted turn owes nothing new.
  if (context.replay.sourceMessageId.startsWith('obl:')) return undefined;
  // Unknown serving provider = capability availability unprovable = no debt
  // (creating one could duplicate work a capable turn already performed).
  if (harnessType === null || !harnessLacksCapability(harnessType)) return undefined;

  const decision = evaluateCapabilityContract(deps.options.contract, {
    text: context.replay.text,
    preparedMediaClass: preparedMediaClass(context.contentType),
  });
  if (decision.outcome === 'no_match') return undefined;
  if (decision.outcome === 'conflict') {
    return notCreated('not_created_contract_conflict', decision.inputDigest);
  }

  if (context.identity.inboundSeq === null || context.identity.inboundSeq <= 0) {
    return notCreated('not_created_unjournaled_source', decision.inputDigest);
  }

  // D2 fold over TURN-CORRELATED rows (AS-04, spec §3.2b): every row is
  // stamped with its owning logical turn at the single writer. Enumeration is
  // complete only when NO row in the conversation window lacks correlation —
  // an unstamped row could belong to this turn, so it fails closed. Any
  // durability write loss since the inbound arrived also fails closed: a
  // mutating call whose record write was refused must never read as "no
  // effect".
  const uncorrelated = deps.db.raw
    .prepare(
      `SELECT COUNT(*) AS c FROM tool_calls
       WHERE conversation_key = ?
         AND created_at >= datetime(?, 'unixepoch')
         AND logical_turn_id IS NULL`,
    )
    .get(context.identity.conversationKey, context.replay.receivedAtUnixSeconds) as { c: number };
  const toolRows = deps.db.raw
    .prepare(
      `SELECT tool_name, status, outcome_code, failure_stage FROM tool_calls
       WHERE logical_turn_id = ?`,
    )
    .all(context.identity.logicalTurnId) as Array<{
    tool_name: string;
    status: string;
    outcome_code: string | null;
    failure_stage: string | null;
  }>;
  const classes = toolRows.map((row) =>
    classifyInvocationEffect(deps.externalEffectFor(row.tool_name), {
      toolName: row.tool_name,
      status: row.status,
      outcomeCode: row.outcome_code,
      failureStage: row.failure_stage,
    }),
  );
  const fold = foldTurnEffects(classes, {
    enumerationComplete: uncorrelated.c === 0,
    writeLossInWindow: deps.writeLossSince(context.replay.receivedAtUnixSeconds * 1000),
  });
  if (!fold.conclusiveNoEffect) {
    return notCreated('not_created_side_effect_uncertain', decision.inputDigest);
  }

  // D3: media staged (copy/fsync/rehash) BEFORE the C3 transaction, from the
  // durably persisted prepared-media path.
  let retainedMedia: CapabilityObligationRetainedMedia | null = null;
  if (decision.ruleKind === 'media_class') {
    const row = deps.db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ? ORDER BY pk DESC LIMIT 1')
      .get(context.replay.sourceMessageId) as { media_path: string | null } | undefined;
    if (row?.media_path == null) {
      return notCreated('not_created_media_unavailable', decision.inputDigest);
    }
    try {
      const retained = await retainMediaForObligation(
        { root: deps.options.mediaRoot, policyVersion: deps.options.retentionPolicyVersion },
        row.media_path,
      );
      retainedMedia = {
        path: retained.path,
        sha256: retained.sha256,
        bytes: retained.bytes,
        policyVersion: retained.policyVersion,
      };
    } catch (err) {
      log.warn({ err, sourceMessageId: context.replay.sourceMessageId }, 'obligation media staging failed');
      return notCreated('not_created_media_retention_failed', decision.inputDigest);
    }
  }

  return {
    auditEvent: {
      action: 'obligation.create',
      actorType: 'runtime',
      reasonCode: 'conclusive_no_effect',
      sourceHash: decision.inputDigest,
      detail: { ruleId: decision.ruleId, ruleKind: decision.ruleKind },
    },
    obligation: {
      sourceInboundSeq: context.identity.inboundSeq,
      sourceMessageId: context.replay.sourceMessageId,
      conversationKey: context.identity.conversationKey,
      deliveryJid: context.identity.deliveryJid,
      senderJid: context.replay.senderJid,
      senderName: context.replay.senderName,
      isGroup: context.replay.isGroup,
      groupName: context.replay.groupName ?? (context.replay.isGroup ? context.identity.deliveryJid : null),
      scope: 'per_chat',
      originRecoveryJobId: null,
      replayText: context.replay.text,
      contentTypeHint: context.contentType,
      contractVersion: decision.contractVersion,
      requiredCapability: decision.capability,
      capabilityParams: JSON.stringify({ skill: deps.options.attestation.skillName }),
      inputDigest: decision.inputDigest,
      sourceDigest: capabilitySourceDigest(decision.sourceToken, retainedMedia?.sha256 ?? null),
      // Exactly one source: media rules carry retainedMedia and a null token;
      // url_host/leading_token rules carry the token and no media.
      sourceToken: retainedMedia !== null ? null : decision.sourceToken,
      retainedMedia,
      creationReason: 'typed_deferral_signal',
    },
  };
}
