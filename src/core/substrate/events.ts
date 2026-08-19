// src/core/substrate/events.ts
import type { DatabaseSync } from 'node:sqlite';
import { type Clock, systemClock } from '../../lib/clock.ts';

export interface WriteBeadEventArgs {
  beadId: number; eventType: string; actor: string;
  payload?: Record<string, unknown>;
  sourceMessagePk?: number | null;
  at?: number;
}

export function writeBeadEvent(
  db: DatabaseSync,
  args: WriteBeadEventArgs,
  // Injectable so a persisted event's default created_at can be driven to a
  // known instant (#2200). Optional and defaulted, so this slice changes no
  // existing call site.
  clock: Clock = systemClock,
): number {
  const at = args.at ?? clock.nowUnixSec();
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
