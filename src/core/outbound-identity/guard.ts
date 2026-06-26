// src/core/outbound-identity/guard.ts
// Outbound identity guard — pure decision function over an injected IdentityStore.
// Decision order (spec §4.2): A group → B system caller → C cold floor → E allow.
// Step D (expect: verified-alias) is a later, separate effort and intentionally absent here.

import { bareNumber, isLidJid, isGroupJid } from '../jid-constants.ts';
import { createChildLogger } from '../../logger.ts';
import type { Decision, GuardCode, GuardOpts, IdentityStore } from './types.ts';

const guardLog = createChildLogger('outbound-identity');

/** Infra callers that must never be floored (spec §4.2 step B, §6). */
const SYSTEM_CALLERS = new Set(['health', 'scheduler', 'reply-guarantee', 'report-channel']);

/** Downgrade a block to a warn under log-only; pass blocks through under enforce. */
function applyMode(code: GuardCode, reason: string, mode: GuardOpts['mode']): Decision {
  return mode === 'enforce'
    ? { verdict: 'block', code, reason }
    : { verdict: 'warn', code, reason };
}

export function assertOutboundIdentity(
  chatJid: string,
  opts: GuardOpts,
  store: IdentityStore,
): Decision {
  // A. Group — placeholder: allow. A later task tightens this to UNKNOWN_GROUP.
  if (isGroupJid(chatJid)) {
    return { verdict: 'allow' };
  }

  // B. System/infra caller — never floored, audited by the caller.
  if (SYSTEM_CALLERS.has(opts.caller)) {
    return { verdict: 'allow' };
  }

  // Identity resolution → phone JID.
  let phoneJid = chatJid;
  if (isLidJid(chatJid)) {
    const resolved = store.resolveLid(bareNumber(chatJid));
    if (resolved === null) {
      return applyMode('AMBIGUOUS', `unresolvable LID ${chatJid}`, opts.mode);
    }
    phoneJid = resolved;
  }
  const barePhone = bareNumber(phoneJid);

  // C. Cold floor.
  if (!store.isWarm(phoneJid, barePhone)) {
    return applyMode('COLD_TARGET', `no warm relationship for ${phoneJid}`, opts.mode);
  }

  // E. Otherwise allow.
  return { verdict: 'allow' };
}

/** Thrown when the guard blocks a send (enforce mode). Carries the guard sub-code. */
export class OutboundIdentityError extends Error {
  readonly code = 'IDENTITY_BLOCKED' as const;
  readonly guardCode: GuardCode;
  readonly reason: string;

  constructor(guardCode: GuardCode, reason: string) {
    super(`outbound identity guard blocked send: ${guardCode} — ${reason}`);
    this.name = 'OutboundIdentityError';
    this.guardCode = guardCode;
    this.reason = reason;
  }
}

/**
 * Call-site helper: run the guard, audit every non-allow decision, and throw on
 * block. Synchronous (node:sqlite is sync). A store read failure is caught and
 * mapped to fail-open with a loud STORE_UNAVAILABLE audit — a later effort adds
 * the explicit retry; this baseline already fails open rather than closed.
 */
export function applyOutboundIdentityGuard(
  chatJid: string,
  opts: GuardOpts,
  store: IdentityStore | null,
): void {
  if (store === null) return; // not yet wired (e.g. early boot) — do not block.
  let decision: Decision;
  try {
    decision = assertOutboundIdentity(chatJid, opts, store);
  } catch (err) {
    guardLog.warn(
      { chatJid, caller: opts.caller, mode: opts.mode, err: (err as Error).message },
      'outbound identity store unavailable — failing open (STORE_UNAVAILABLE)',
    );
    return; // fail-open
  }
  if (decision.verdict === 'allow') return;
  guardLog.warn(
    { chatJid, caller: opts.caller, mode: opts.mode, code: decision.code, reason: decision.reason, verdict: decision.verdict },
    'outbound identity guard decision',
  );
  if (decision.verdict === 'block') {
    throw new OutboundIdentityError(decision.code, decision.reason);
  }
}
