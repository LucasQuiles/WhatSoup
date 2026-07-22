// src/core/outbound-identity/guard.ts
// Outbound identity guard — pure decision function over an injected IdentityStore.
// Decision order (spec §4.2): B system caller → A group → LID resolve → C cold floor → E allow.
// Step D (expect: verified-alias) is a later, separate effort and intentionally absent here.

import {
  bareNumber,
  fromImessageJid,
  fromSignalJid,
  isGroupJid,
  isLidJid,
  JID_IMESSAGE,
  JID_SIGNAL,
  JID_SMS,
  normalizeLid,
  smsJidToPhone,
} from '../jid-constants.ts';
import { createChildLogger } from '../../logger.ts';
import type { Decision, GuardCode, GuardOpts, IdentityStore } from './types.ts';

const guardLog = createChildLogger('outbound-identity');

/** Infra callers that must never be floored (spec §4.2 step B, §6). */
const SYSTEM_CALLERS = new Set(['health', 'scheduler', 'reply-guarantee', 'report-channel']);

function accessIdentityForDirectJid(jid: string): string {
  if (jid.endsWith(JID_SMS)) return smsJidToPhone(jid);
  if (jid.endsWith(JID_SIGNAL)) return fromSignalJid(jid);
  if (jid.endsWith(JID_IMESSAGE)) return fromImessageJid(jid);
  return bareNumber(jid);
}

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
  // B. System/infra caller — never floored (applies to DMs and groups).
  if (SYSTEM_CALLERS.has(opts.caller)) {
    return { verdict: 'allow' };
  }

  // A. Group classification — operator-APPROVED group allowed, otherwise floored.
  // Bare membership is not approval (QR-038): a `groups` row is auto-created when the
  // bot is added to any group, so the egress bar must be an access_list 'allowed' group
  // entry (parity with the auto-respond gate) — otherwise an attacker who adds the bot to
  // a group could induce egress to it, defeating the anti-exfil cold floor.
  if (isGroupJid(chatJid)) {
    if (store.isApprovedGroup(chatJid)) {
      return { verdict: 'allow' };
    }
    return applyMode('UNKNOWN_GROUP', `unapproved group ${chatJid}`, opts.mode);
  }

  // Identity resolution → phone JID.
  let phoneJid = chatJid;
  if (isLidJid(chatJid)) {
    // QR-025: normalize the :device suffix — the store matches lid_mappings on the
    // normalized LID, so a device-suffixed LID (<lid>:8@lid) would otherwise miss and be
    // floored AMBIGUOUS (fail-closed) for a known, warm contact.
    const resolved = store.resolveLid(normalizeLid(bareNumber(chatJid)));
    if (resolved === null) {
      return applyMode('AMBIGUOUS', `unresolvable LID ${chatJid}`, opts.mode);
    }
    phoneJid = resolved;
  }
  const barePhone = accessIdentityForDirectJid(phoneJid);

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
 * block. Synchronous (node:sqlite is sync). A store read failure is retried once
 * (node:sqlite's busy_timeout already waited up to 5s, so one more attempt covers
 * a checkpoint-truncate blip). If the retry also throws, enforce mode blocks
 * with a loud STORE_UNAVAILABLE audit; only an explicitly selected log-only
 * rollout permits the send. A cold target is blocked only after a successful
 * read, while an unavailable store is classified separately.
 */
export function applyOutboundIdentityGuard(
  chatJid: string,
  opts: GuardOpts,
  store: IdentityStore | null,
): void {
  // System callers carry trusted in-process provenance and do not depend on
  // recipient history. Check them before the store so operator reporting still
  // works during database recovery.
  if (SYSTEM_CALLERS.has(opts.caller)) return;

  if (store === null) {
    const reason = 'outbound identity store is not configured';
    const verdict = opts.mode === 'enforce' ? 'block' : 'warn';
    guardLog.warn(
      {
        chatJid,
        caller: opts.caller,
        mode: opts.mode,
        code: 'STORE_UNAVAILABLE' satisfies GuardCode,
        verdict,
        reason,
      },
      opts.mode === 'enforce'
        ? 'outbound identity store unavailable — blocking send (STORE_UNAVAILABLE)'
        : 'outbound identity store unavailable — explicit log-only mode allows send (STORE_UNAVAILABLE)',
    );
    if (opts.mode === 'enforce') {
      throw new OutboundIdentityError('STORE_UNAVAILABLE', reason);
    }
    return;
  }
  let decision: Decision;
  try {
    try {
      decision = assertOutboundIdentity(chatJid, opts, store);
    } catch {
      // node:sqlite busy_timeout already waited up to 5s; one more attempt
      // covers a checkpoint-truncate blip. Persistent failure is handled below.
      decision = assertOutboundIdentity(chatJid, opts, store);
    }
  } catch (err) {
    const reason = `outbound identity store read failed: ${(err as Error).message}`;
    const verdict = opts.mode === 'enforce' ? 'block' : 'warn';
    guardLog.warn(
      {
        chatJid,
        caller: opts.caller,
        mode: opts.mode,
        code: 'STORE_UNAVAILABLE' satisfies GuardCode,
        verdict,
        err: (err as Error).message,
      },
      opts.mode === 'enforce'
        ? 'outbound identity store unavailable — blocking send (STORE_UNAVAILABLE)'
        : 'outbound identity store unavailable — explicit log-only mode allows send (STORE_UNAVAILABLE)',
    );
    if (opts.mode === 'enforce') {
      throw new OutboundIdentityError('STORE_UNAVAILABLE', reason);
    }
    return;
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
