// src/core/echo-guard.ts
// Defense-in-depth: per-group outbound cooldown to prevent cascade floods.
// In-memory state — resets on process restart (intentional).

import { createChildLogger } from '../logger.ts';
import { JID_GROUP } from './jid-constants.ts';

const log = createChildLogger('echo-guard');

export interface EchoGuardConfig {
  enabled: boolean;
  groupCooldownMs: number;
}

const groupCooldowns = new Map<string, number>();

export function canSendToGroup(chatJid: string, cfg: EchoGuardConfig): boolean {
  if (!cfg.enabled) return true;
  if (!chatJid.endsWith(JID_GROUP)) return true;

  const entry = groupCooldowns.get(chatJid);
  if (!entry) return true;

  const elapsed = Date.now() - entry;
  if (elapsed >= cfg.groupCooldownMs) return true;

  log.error({ chatJid, elapsedMs: elapsed, cooldownMs: cfg.groupCooldownMs },
    'echo guard: outbound group message suppressed (cooldown active)');
  return false;
}

export function recordGroupOutbound(chatJid: string): void {
  if (!chatJid.endsWith(JID_GROUP)) return;
  groupCooldowns.set(chatJid, Date.now());
}

export function __resetForTests(): void {
  groupCooldowns.clear();
}
