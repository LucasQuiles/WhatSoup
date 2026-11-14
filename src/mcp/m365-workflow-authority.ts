import { createHash } from 'node:crypto';
import { z } from 'zod';
import { m365WorkflowAuthorityLive, type M365WorkflowAuthority as M365WorkflowAuthorityAssignment } from '../core/m365-bridge-policy.ts';
import type { ToolRegistry } from './registry.ts';
import type { SessionContext } from './types.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from './external-effect.ts';
import { isTurnOwned } from './caller-attribution.ts';
import { systemClock } from '../lib/clock.ts';

export const M365_WORKFLOW_AUTHORITY_VERSION = 1 as const;
export const M365_WORKFLOW_AUTHORITY_TTL_MS = 15 * 60 * 1_000;

export interface M365WorkflowAuthorityContext {
  actorJid?: string;
  conversationKey?: string;
  requestRef?: string;
  purpose?: 'scheduled-agent-job';
  executingResolution?: 'resolved' | 'unresolved';
  workflowAuthority?: M365WorkflowAuthorityAssignment;
  workflowAuthorityScope?: SessionContext['workflowAuthorityScope'];
  workflowAuthoritySandboxPerChat?: SessionContext['workflowAuthoritySandboxPerChat'];
  callerAttribution?: SessionContext['callerAttribution'];
  tokenBinding?: SessionContext['tokenBinding'];
}

const requestSchema = z.object({
  version: z.literal(M365_WORKFLOW_AUTHORITY_VERSION),
  toolName: z.string().min(1).max(256),
  params: z.record(z.string(), z.unknown()),
  accountId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
}).strict();

export function registerM365WorkflowAuthorityTool(
  registry: ToolRegistry,
  canonicalActor: (jid: string) => string = (jid) => jid,
): void {
  registry.register({
    name: 'authorize_m365_action',
    description: 'Authorize one exact Microsoft 365 workflow operation for the active assigned employee request.',
    schema: requestSchema,
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    private: true,
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' },
    handler: async (params, session: SessionContext) => authorizeM365WorkflowAction(
      params as unknown as M365WorkflowAuthorityRequest,
      { ...session, actorJid: session.actorJid ? canonicalActor(session.actorJid) : undefined },
      systemClock.now(),
    ),
  });
}

export interface M365WorkflowAuthorityRequest {
  version: 1;
  toolName: string;
  params: Record<string, unknown>;
  accountId: string;
  requestId: string;
}

export interface M365WorkflowAuthorityReceipt {
  version: 1;
  actorJid: string;
  conversationKey: string;
  requestRef: string;
  toolName: string;
  paramsSha256: string;
  accountId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  operationId: string;
  /**
   * Which token the plugin presented: a per-call adapter request token, or the
   * session token of a native plugin process (also used for in-process callers).
   */
  caller: 'adapter' | 'session';
}

export type M365WorkflowAuthorityResult =
  | { allowed: true; receipt: M365WorkflowAuthorityReceipt }
  | { allowed: false; code: string };

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function canonicalValue(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalValue);
    return items.some((item) => item === null) ? null : `[${items.join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const object = value as Record<string, unknown>;
  const entries: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const item = canonicalValue(object[key]);
    if (item === null) return null;
    entries.push(`${JSON.stringify(key)}:${item}`);
  }
  return `{${entries.join(',')}}`;
}

export function canonicalM365WorkflowParams(params: Record<string, unknown>): string | null {
  return canonicalValue(params);
}

/**
 * Stable action identity for one exact action contained in one human request.
 * It deliberately excludes the plugin's per-attempt requestId, so a reconnect
 * cannot turn an otherwise identical action into a new operation.
 */
export function deriveM365WorkflowOperationId(
  requestRef: string,
  accountId: string,
  toolName: string,
  canonicalParams: string,
): string {
  const identity = JSON.stringify([requestRef, accountId, toolName, canonicalParams]);
  return `m365-v1-${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

export function authorizeM365WorkflowAction(
  request: M365WorkflowAuthorityRequest,
  context: M365WorkflowAuthorityContext,
  issuedAtMs: number,
): M365WorkflowAuthorityResult {
  if (context.executingResolution !== 'resolved' || context.purpose !== undefined ||
      !nonBlank(context.actorJid) || !nonBlank(context.conversationKey) || !nonBlank(context.requestRef)) {
    return { allowed: false, code: context.purpose === 'scheduled-agent-job' ? 'BACKGROUND_REQUEST' : 'MISSING_CURRENT_HUMAN_REQUEST' };
  }
  const authority = context.workflowAuthority;
  // Read per request: a turn that published the assignment before a withdrawal loses it here.
  if (!authority || !m365WorkflowAuthorityLive(authority)) return { allowed: false, code: 'WORKFLOW_AUTHORITY_DISABLED' };
  // Outside per-chat scope one socket serves every chat, so a write could borrow another actor's turn.
  if (context.workflowAuthorityScope !== 'per_chat') return { allowed: false, code: 'WORKFLOW_AUTHORITY_SCOPE_NOT_PER_CHAT' };
  if (!context.callerAttribution || !isTurnOwned(context.callerAttribution)) {
    return { allowed: false, code: 'MISSING_SESSION_BINDING' };
  }
  let caller: M365WorkflowAuthorityReceipt['caller'] = 'session';
  if (context.callerAttribution.transport === 'socket') {
    // Re-verified per request: a revoked or foreign-socket token no longer binds.
    const binding = context.tokenBinding?.();
    if (!binding) return { allowed: false, code: 'MISSING_SESSION_BINDING' };
    if (binding.kind === 'request') {
      if (binding.requestRef !== context.requestRef || binding.conversationKey !== context.conversationKey) {
        return { allowed: false, code: 'STALE_REQUEST' };
      }
      caller = 'adapter';
    }
  }
  // A sandboxPerChat session child gets no authority socket, yet code in it still holds its
  // session token and WhatSoup socket; there only the adapter's request tokens are admitted.
  if (caller === 'session' && context.workflowAuthoritySandboxPerChat === true) {
    return { allowed: false, code: 'WORKFLOW_AUTHORITY_SANDBOX_SESSION' };
  }
  if (context.actorJid !== authority.employeeActorJid) return { allowed: false, code: 'ACTOR_NOT_ASSIGNED' };
  if (authority.conversationKey !== undefined && context.conversationKey !== authority.conversationKey) {
    return { allowed: false, code: 'CONVERSATION_NOT_ASSIGNED' };
  }
  if (request.version !== M365_WORKFLOW_AUTHORITY_VERSION || !nonBlank(request.toolName) ||
      !nonBlank(request.accountId) || !nonBlank(request.requestId)) return { allowed: false, code: 'INVALID_REQUEST' };
  if (request.accountId !== authority.accountId) return { allowed: false, code: 'ACCOUNT_NOT_ASSIGNED' };
  const canonicalParams = canonicalM365WorkflowParams(request.params);
  if (canonicalParams === null) return { allowed: false, code: 'INVALID_PARAMS' };
  const paramsSha256 = createHash('sha256').update(canonicalParams, 'utf8').digest('hex');
  const operationId = deriveM365WorkflowOperationId(
    context.requestRef,
    request.accountId,
    request.toolName,
    canonicalParams,
  );
  return {
    allowed: true,
    receipt: {
      version: M365_WORKFLOW_AUTHORITY_VERSION,
      actorJid: context.actorJid,
      conversationKey: context.conversationKey,
      requestRef: context.requestRef,
      toolName: request.toolName,
      paramsSha256,
      accountId: request.accountId,
      issuedAtMs,
      expiresAtMs: issuedAtMs + M365_WORKFLOW_AUTHORITY_TTL_MS,
      operationId,
      caller,
    },
  };
}
