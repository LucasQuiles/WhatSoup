// src/core/outbound-identity/types.ts
// Outbound identity guard — shared types. Cold-floor surface only.
// IDENTITY_MISMATCH and the verified-alias path are a later, separate effort.

export type GuardMode = 'log-only' | 'enforce';

export type GuardCode =
  | 'COLD_TARGET'
  | 'UNKNOWN_GROUP'
  | 'AMBIGUOUS'
  | 'STORE_UNAVAILABLE';

/** Origin of the send. System/infra callers bypass the cold floor (spec §4.2 step B). */
export type GuardCaller =
  | 'mcp'
  | 'agent'
  | 'health'
  | 'scheduler'
  | 'reply-guarantee'
  | 'report-channel';

export interface GuardOpts {
  caller: GuardCaller;
  mode: GuardMode;
}

export type Decision =
  | { verdict: 'allow' }
  | { verdict: 'warn'; code: GuardCode; reason: string }
  | { verdict: 'block'; code: GuardCode; reason: string };

/**
 * Read surface the guard depends on. Implemented by SqliteIdentityStore over
 * bot.db; can be faked in unit tests. All methods are synchronous because the
 * underlying node:sqlite DatabaseSync is synchronous. A read failure throws —
 * the guard catches it and maps to STORE_UNAVAILABLE (fail-open, spec §6).
 */
export interface IdentityStore {
  /** Bare lid (no @lid suffix) → phone JID, or null if unmapped. */
  resolveLid(lidBare: string): string | null;
  /** Any warm signal: contacts row, access_list allowed, or a prior inbound message. */
  isWarm(phoneJid: string, barePhone: string): boolean;
  /** True if the group JID exists in the groups table. */
  isApprovedGroup(groupJid: string): boolean;
}
