// src/core/client-output-policy-gate.ts
// #3613: the single enforcement point for per-conversation client output
// policies. Every send path (the agent outbound queue and the MCP send tools)
// calls enforceClientOutputPolicy so the evaluator call and the audit line
// shape stay identical everywhere.
//
// Owner ruling (decision 64): a rejected message is dropped with one
// structured audit log line and no database record. The line never carries
// the message text or blocked-term values. An evaluator error on a configured
// policy fails closed: the message is dropped and the error is logged.

import { evaluateClientOutputPolicy } from './client-output-policy.ts';
import {
  selectClientOutputPolicy,
  type ClientOutputPolicyRegistry,
} from './client-output-policy-config.ts';
import type { ClientOutputViolationCode } from './client-output-policy-contract.ts';

/** Which send path produced the message: a queue role or an MCP tool name. */
export type ClientOutputMessageKind =
  | 'answer'
  | 'lifecycle'
  | 'status'
  | 'send_message'
  | 'reply_message'
  | 'edit_message'
  | 'send_poll'
  | 'send_media'
  | 'send_voice_reply';

export type ClientOutputGateResult =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      decision: 'rejected';
      violationCodes: readonly ClientOutputViolationCode[];
    }>
  | Readonly<{ admitted: false; decision: 'error' }>;

export interface ClientOutputAuditLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface EnforceClientOutputPolicyArgs {
  readonly registry: ClientOutputPolicyRegistry | undefined;
  /** Canonical conversation key of the target chat. */
  readonly conversationKey: string;
  /** Text before redaction, used by the internal-artifact check. */
  readonly sourceText: string;
  /** Text as it would be sent, used by every other check. */
  readonly finalText: string;
  readonly messageKind: ClientOutputMessageKind;
  readonly log: ClientOutputAuditLogger;
}

const ADMITTED: ClientOutputGateResult = Object.freeze({ admitted: true });

export interface EnforceClientOutputPolicyForChatArgs
  extends Omit<EnforceClientOutputPolicyArgs, 'conversationKey'> {
  readonly chatJid: string;
  /** Folds the chat JID onto its canonical conversation key (LID to phone). */
  readonly resolveConversationKey: (chatJid: string) => string;
}

/**
 * Send-tool entry point: resolves the target chat's canonical conversation key,
 * then enforces. With no policies configured it never resolves a key. A JID
 * that cannot be folded has no policy to match; the transport rejects it.
 */
export function enforceClientOutputPolicyForChat(
  args: EnforceClientOutputPolicyForChatArgs,
): ClientOutputGateResult {
  if (!args.registry || args.registry.size === 0) return ADMITTED;
  let conversationKey: string;
  try {
    conversationKey = args.resolveConversationKey(args.chatJid);
  } catch {
    return ADMITTED;
  }
  return enforceClientOutputPolicy({ ...args, conversationKey });
}

export function enforceClientOutputPolicy(
  args: EnforceClientOutputPolicyArgs,
): ClientOutputGateResult {
  if (!args.registry) return ADMITTED;
  const selection = selectClientOutputPolicy(args.registry, {
    status: 'resolved',
    canonicalConversationKey: args.conversationKey,
  });
  if (selection.status !== 'configured') return ADMITTED;
  try {
    const decision = evaluateClientOutputPolicy(selection.policy, {
      sourceText: args.sourceText,
      finalText: args.finalText,
    });
    if (decision.action === 'allow') return ADMITTED;
    const violationCodes = Object.freeze([...decision.violationCodes]);
    args.log.warn({
      operation: 'client_output_policy',
      decision: 'rejected',
      conversationKey: args.conversationKey,
      reason: decision.reason,
      violationCodes: [...violationCodes],
      messageKind: args.messageKind,
    }, 'client output policy rejected outbound message; dropped');
    return Object.freeze({ admitted: false, decision: 'rejected', violationCodes });
  } catch (err) {
    args.log.error({
      operation: 'client_output_policy',
      decision: 'error',
      conversationKey: args.conversationKey,
      messageKind: args.messageKind,
      errorName: err instanceof Error ? err.name : typeof err,
    }, 'client output policy evaluation failed; outbound message dropped');
    return Object.freeze({ admitted: false, decision: 'error' });
  }
}
