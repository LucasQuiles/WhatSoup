// src/core/echo-guard.ts
// Defense-in-depth: per-group outbound cooldown to prevent cascade floods.
// In-memory state — resets on process restart (intentional).

import { createChildLogger } from '../logger.ts';

const log = createChildLogger('echo-guard');

export interface EchoGuardConfig {
  enabled: boolean;
  groupCooldownMs: number;
}

interface GroupCooldownEntry {
  lastOutboundTs: number;
}

const groupCooldowns = new Map<string, GroupCooldownEntry>();

export function canSendToGroup(chatJid: string, cfg: EchoGuardConfig): boolean {
  if (!cfg.enabled) return true;
  if (!chatJid.endsWith('@g.us')) return true;

  const entry = groupCooldowns.get(chatJid);
  if (!entry) return true;

  const elapsed = Date.now() - entry.lastOutboundTs;
  if (elapsed >= cfg.groupCooldownMs) return true;

  log.warn({ chatJid, elapsedMs: elapsed, cooldownMs: cfg.groupCooldownMs },
    'echo guard: outbound group message suppressed (cooldown active)');
  return false;
}

export function recordGroupOutbound(chatJid: string): void {
  if (!chatJid.endsWith('@g.us')) return;
  groupCooldowns.set(chatJid, { lastOutboundTs: Date.now() });
}

export function __resetForTests(): void {
  groupCooldowns.clear();
}
