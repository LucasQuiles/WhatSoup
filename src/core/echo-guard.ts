// src/core/echo-guard.ts
// Defense-in-depth: per-group outbound cooldown to prevent cascade floods.
// Session-aware: rapid sends from the same queue instance are exempt from
// the cooldown. Only cross-session sends to the same JID trigger suppression.
// In-memory state — resets on process restart (intentional).

import { createChildLogger } from '../logger.ts';
import { isGroupJid } from './jid-constants.ts';

const log = createChildLogger('echo-guard');

export interface EchoGuardConfig {
  enabled: boolean;
  groupCooldownMs: number;
}

interface CooldownEntry {
  timestamp: number;
  senderToken: string | undefined;
}

const groupCooldowns = new Map<string, CooldownEntry>();

/**
 * Check whether an outbound group send should be allowed.
 *
 * @param senderToken - Opaque token identifying the queue/session that is
 *   sending. When the token matches the previous sender's token, the cooldown
 *   is skipped — this exempts rapid multi-chunk sends within a single
 *   session's drain cycle from being suppressed. Cross-session sends (different
 *   token or undefined) still respect the cooldown.
 */
export function canSendToGroup(chatJid: string, cfg: EchoGuardConfig, senderToken?: string): boolean {
  if (!cfg.enabled) return true;
  if (!isGroupJid(chatJid)) return true;

  const entry = groupCooldowns.get(chatJid);
  if (!entry) return true;

  // Same sender — exempt from cooldown (intra-session rapid sends)
  if (senderToken !== undefined && entry.senderToken === senderToken) return true;

  const elapsed = Date.now() - entry.timestamp;
  if (elapsed >= cfg.groupCooldownMs) return true;

  log.warn({ chatJid, elapsedMs: elapsed, cooldownMs: cfg.groupCooldownMs },
    'echo guard: outbound group message suppressed (cross-session cooldown active)');
  return false;
}

export function recordGroupOutbound(chatJid: string, senderToken?: string): void {
  if (!isGroupJid(chatJid)) return;
  groupCooldowns.set(chatJid, { timestamp: Date.now(), senderToken });
}

export function __resetForTests(): void {
  groupCooldowns.clear();
}
