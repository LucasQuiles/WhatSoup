// src/core/outbound-identity/store.ts
// SqliteIdentityStore — warm-set reads over bot.db (node:sqlite, synchronous).

import type { DatabaseSync } from 'node:sqlite';
import type { IdentityStore } from './types.ts';

export class SqliteIdentityStore implements IdentityStore {
  private readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  resolveLid(lidBare: string): string | null {
    const row = this.raw
      .prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?')
      .get(lidBare) as { phone_jid: string } | undefined;
    return row?.phone_jid ?? null;
  }

  isWarm(phoneJid: string, barePhone: string): boolean {
    const contact = this.raw
      .prepare('SELECT 1 FROM contacts WHERE jid = ? OR canonical_phone = ? LIMIT 1')
      .get(phoneJid, barePhone);
    if (contact !== undefined) return true;

    const access = this.raw
      .prepare(
        "SELECT 1 FROM access_list WHERE subject_type = 'phone' AND subject_id = ? AND status = 'allowed' LIMIT 1",
      )
      .get(barePhone);
    if (access !== undefined) return true;

    const inbound = this.raw
      .prepare(
        'SELECT 1 FROM messages WHERE is_from_me = 0 AND (sender_jid = ? OR sender_jid LIKE ?) LIMIT 1',
      )
      .get(phoneJid, `${barePhone}@%`);
    return inbound !== undefined;
  }

  isKnownGroup(groupJid: string): boolean {
    const row = this.raw.prepare('SELECT 1 FROM groups WHERE jid = ? LIMIT 1').get(groupJid);
    return row !== undefined;
  }
}
