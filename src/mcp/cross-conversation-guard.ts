// src/mcp/cross-conversation-guard.ts
//
// Issue 3457: the ONE cross-conversation guard. It replaces two guards that
// protected the same property with different triggers, folds and failure
// channels: the registry's pre-handler check and send_message's in-handler
// check. The registry owns the guard and runs it at two points: before the
// handler, on a caller-supplied `chatJid`, and after alias and `@lid`
// resolution, through the callback it hands the handler. Both points use this
// function, so they share one trigger, one fold and one failure channel.
//
// Behaviour is kept cell for cell (docs/mcp/cross-conversation-guard-call-site-matrix.md).
// No branch admits a target that either old guard denied.

import { conversationBoundKey, type SessionContext } from './types.ts';
import type { ToolFailureCode, ToolFailureStage } from '../core/durability-evidence-contract.ts';

/** Folds a JID to its canonical conversation key. Throws on an invalid JID. */
export type ConversationKeyFold = (jid: string) => string;

export type CrossConversationAdmitBranch =
  /** Chat-scoped sessions: the registry injects the target from the session, so there is nothing caller-controlled to adjudicate. */
  | 'chat-scoped-injected-target'
  /** #3435 L3, kept on purpose: a global session with no conversation key may address any conversation. */
  | 'unconfined-global-session'
  | 'target-matches-conversation';

export type CrossConversationDenyBranch =
  /** The target JID does not fold to a conversation key at all. */
  | 'invalid-target-jid'
  /** A bound session whose conversationKey mirror names a different conversation from its binding. */
  | 'binding-mirror-divergence'
  | 'foreign-conversation';

export type CrossConversationVerdict =
  | { readonly kind: 'admit'; readonly branch: CrossConversationAdmitBranch }
  | {
      readonly kind: 'deny';
      readonly branch: CrossConversationDenyBranch;
      readonly failureCode: Extract<ToolFailureCode, 'authorization_denied' | 'validation_rejected'>;
      readonly failureStage: Extract<ToolFailureStage, 'authorization' | 'validation'>;
      readonly text: string;
      /** Set only on binding-mirror-divergence: the values the loud log must carry. */
      readonly divergence?: {
        readonly bindingConversationKey: string;
        readonly bindingDeliveryJid: string;
        readonly bindingFoldedKey: string;
        readonly mirrorConversationKey: string;
      };
    };

function invalidTarget(targetJid: string): CrossConversationVerdict {
  return {
    kind: 'deny',
    branch: 'invalid-target-jid',
    failureCode: 'validation_rejected',
    failureStage: 'validation',
    text: `Invalid chatJid "${targetJid}": must be a valid JID`,
  };
}

function tryFold(fold: ConversationKeyFold, jid: string): string | undefined {
  try {
    return fold(jid);
  } catch {
    return undefined;
  }
}

/**
 * Decide whether `session` may act on the conversation `targetJid` names.
 * Pure: the caller maps a deny verdict onto its failure channel and logs it.
 */
export function evaluateTargetConversation(
  session: SessionContext,
  targetJid: string,
  fold: ConversationKeyFold,
): CrossConversationVerdict {
  if (session.tier !== 'global') return { kind: 'admit', branch: 'chat-scoped-injected-target' };

  const mirror = session.conversationKey;
  let enforcedKey: string;

  if (conversationBoundKey(session) !== undefined) {
    const binding = session.binding!;
    // The binding's identity is compared as a FOLD, not as its stored string.
    // The binding key is stored raw (toConversationKey) while the mirror is
    // stored phone-folded (canonicalConversationKey), so a raw comparison
    // would call a mapped `@lid` binding "diverged" from its own mirror.
    const bindingFoldedKey = tryFold(fold, binding.deliveryJid);
    if (bindingFoldedKey === undefined) return invalidTarget(binding.deliveryJid);
    if (mirror && mirror !== bindingFoldedKey) {
      // Owner decision 27 (issue 3457): a binding and its mirror that disagree
      // stay DENIED. Why the mirror drifts is a separate investigation.
      return {
        kind: 'deny',
        branch: 'binding-mirror-divergence',
        failureCode: 'authorization_denied',
        failureStage: 'authorization',
        text: `chatJid "${targetJid}" denied: session conversation "${mirror}" does not match the conversation binding "${bindingFoldedKey}"`,
        divergence: {
          bindingConversationKey: binding.conversationKey,
          bindingDeliveryJid: binding.deliveryJid,
          bindingFoldedKey,
          mirrorConversationKey: mirror,
        },
      };
    }
    enforcedKey = bindingFoldedKey;
  } else {
    if (!mirror) return { kind: 'admit', branch: 'unconfined-global-session' };
    enforcedKey = mirror;
  }

  const targetKey = tryFold(fold, targetJid);
  if (targetKey === undefined) return invalidTarget(targetJid);
  if (targetKey !== enforcedKey) {
    return {
      kind: 'deny',
      branch: 'foreign-conversation',
      failureCode: 'authorization_denied',
      failureStage: 'authorization',
      text: `chatJid "${targetJid}" resolves to conversation "${targetKey}" which does not match session conversation "${enforcedKey}"`,
    };
  }
  return { kind: 'admit', branch: 'target-matches-conversation' };
}

/**
 * Thrown by the post-resolution callback the registry hands a handler. The
 * handler must let it escape; the registry maps it onto the verdict's failure
 * channel, exactly as it does for a pre-handler denial.
 */
export class CrossConversationDenied extends Error {
  readonly verdict: Extract<CrossConversationVerdict, { kind: 'deny' }>;

  constructor(verdict: Extract<CrossConversationVerdict, { kind: 'deny' }>) {
    super(verdict.text);
    this.name = 'CrossConversationDenied';
    this.verdict = verdict;
  }
}

/** Post-resolution check a handler calls on the JID it is about to act on. */
export type AssertTargetConversation = (targetJid: string) => void;
