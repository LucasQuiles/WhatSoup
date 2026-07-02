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

    // QR-098: a BLOCKED sender is never a warm egress target. ingest stores every
    // inbound BEFORE the access/block check ("always, even if we later reject
    // it"), so a blocked sender still has is_from_me=0 rows below — but
    // shouldRespond refuses to REPLY to them, and the anti-exfil floor must not
    // then permit SENDING to them (respond-vs-egress asymmetry). Explicit
    // contact/allowed rows above still win (a blocked-AND-allowed row is
    // contradictory operator state). This only gates the unsolicited-inbound
    // warm clause below.
    const blocked = this.raw
      .prepare(
        "SELECT 1 FROM access_list WHERE subject_type = 'phone' AND subject_id = ? AND status = 'blocked' LIMIT 1",
      )
      .get(barePhone);
    if (blocked !== undefined) return false;

    const inbound = this.raw
      .prepare(
        'SELECT 1 FROM messages WHERE is_from_me = 0 AND (sender_jid = ? OR sender_jid LIKE ?) LIMIT 1',
      )
      .get(phoneJid, `${barePhone}@%`);
    return inbound !== undefined;
  }

  isApprovedGroup(groupJid: string): boolean {
    // QR-038: operator approval, NOT membership. A bare `groups` row is auto-created on
    // join (handleGroupsUpsert on 'groups.upsert'), so membership alone is too weak an
    // egress bar — require an access_list group entry explicitly 'allowed' (parity with the
    // auto-respond gate), so the anti-exfil floor for groups matches the warm-only DM bar.
    const row = this.raw.prepare(
      "SELECT 1 FROM access_list WHERE subject_type = 'group' AND subject_id = ? AND status = 'allowed' LIMIT 1",
    ).get(groupJid);
    return row !== undefined;
  }
}
