import type { Database } from '../../core/database.ts';
import type { IncomingMessage } from '../../core/types.ts';
import { resolvePhoneFromJid } from '../../core/access-list.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';
import type { QueuedTurn } from './turn-queue.ts';
import {
  TurnChronologyTracker,
  type TurnDeliveryKind,
} from './turn-chronology.ts';

export function sharedRuntimeTurnText(
  turn: Pick<QueuedTurn, 'chatJid' | 'senderJid' | 'senderName' | 'text' | 'isGroup'>,
  db: Database,
): string {
  const phone = resolvePhoneFromJid(turn.senderJid, db);
  const displayName = turn.senderName ?? phone;
  const prefix = turn.isGroup
    ? `[Group: ${turn.chatJid} — ${displayName}]`
    : `[DM from ${displayName} (${phone})]`;
  return `${prefix}\n${turn.text}`;
}

export function receivedAtUnixSeconds(msg: IncomingMessage): number {
  return msg.receivedAtUnixSeconds ?? msg.timestamp;
}

export function renderUserTurnForProvider(
  tracker: TurnChronologyTracker,
  text: string,
  context: RuntimeTurnContext | null,
  deliveryKind: TurnDeliveryKind,
): string {
  if (!context) return text;
  return tracker.render(text, {
    receivedAtUnixSeconds: context.replay.receivedAtUnixSeconds,
    deliveryKind,
  });
}
