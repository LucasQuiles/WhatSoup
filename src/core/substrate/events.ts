// src/core/substrate/events.ts
import type { DatabaseSync } from 'node:sqlite';
import { nowUnixSec } from './time.ts';

export interface WriteBeadEventArgs {
  beadId: number; eventType: string; actor: string;
  payload?: Record<string, unknown>;
  sourceMessagePk?: number | null;
  at?: number;
}

export function writeBeadEvent(db: DatabaseSync, args: WriteBeadEventArgs): number {
  const at = args.at ?? nowUnixSec();
  const info = db
    .prepare(
      `INSERT INTO bead_events (bead_id, event_type, payload_json, actor, source_message_pk, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.beadId, args.eventType,
      JSON.stringify(args.payload ?? {}),
      args.actor, args.sourceMessagePk ?? null, at,
    );
  return Number(info.lastInsertRowid);
}
