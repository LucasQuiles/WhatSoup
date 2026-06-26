// src/core/outbound-identity/guard.ts
// Outbound identity guard — pure decision function over an injected IdentityStore.
// Decision order (spec §4.2): A group → B system caller → C cold floor → E allow.
// Step D (expect: verified-alias) is a later, separate effort and intentionally absent here.

import { bareNumber, isLidJid, isGroupJid } from '../jid-constants.ts';
import type { Decision, GuardCode, GuardOpts, IdentityStore } from './types.ts';

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
