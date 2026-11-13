import type { TurnReplyRequest, TurnReplySink } from '../../core/turn-reply.ts';
import type { IOutboundQueue } from './outbound-queue.ts';

export interface ActiveTurnReplyBinding {
  readonly queue: IOutboundQueue;
  readonly logicalTurnId: string;
}

export interface ActiveTurnReplyContext {
  readonly identity: {
    readonly conversationKey: string;
    readonly managerId: string;
    readonly logicalTurnId: string;
  };
}

export interface RuntimeTurnReplySinkCandidate {
  readonly active: ActiveTurnReplyContext | null | undefined;
  readonly queue: IOutboundQueue | null | undefined;
}

export interface RuntimeTurnReplySinksOptions<Session> {
  readonly mapKeyFor: (session: Session, fallbackMapKey?: string) => string | null;
  readonly perChat: (mapKey: string) => RuntimeTurnReplySinkCandidate;
  readonly global: () => RuntimeTurnReplySinkCandidate;
}

interface RawReplyReservation extends ActiveTurnReplyBinding {
  readonly reservationId: string;
}

export function createActiveTurnReplySink(
  resolveBinding: (request: TurnReplyRequest) => ActiveTurnReplyBinding | null | undefined,
): TurnReplySink {
  const rawReservations = new Map<string, RawReplyReservation>();

  return (request) => {
    switch (request.action ?? 'enqueue') {
      case 'enqueue': {
        const binding = resolveBinding(request);
        if (!binding?.queue.enqueueToolReplyText) return { disposition: 'inactive' };
        if (binding.queue.targetConversationKey !== request.conversationKey) {
          return { disposition: 'rejected', reason: 'turn_target_mismatch' };
        }
        return binding.queue.enqueueToolReplyText(
          request.text,
          binding.logicalTurnId,
          request.deliveryObserver,
        );
      }
      case 'reserve': {
        const binding = resolveBinding(request);
        if (!binding?.queue.reserveToolReply) return { disposition: 'inactive' };
        if (binding.queue.targetConversationKey !== request.conversationKey) {
          return { disposition: 'rejected', reason: 'turn_target_mismatch' };
        }
        const reserved = binding.queue.reserveToolReply(binding.logicalTurnId);
        if (reserved.disposition === 'reserved') {
          rawReservations.set(reserved.reservationId, {
            ...binding,
            reservationId: reserved.reservationId,
          });
        }
        return reserved;
      }
      case 'commit': {
        const reservationId = request.reservationId;
        const reservation = reservationId === undefined ? undefined : rawReservations.get(reservationId);
        if (!reservation?.queue.commitReservedToolReply) return { disposition: 'inactive' };
        const committed = reservation.queue.commitReservedToolReply(
          reservation.logicalTurnId,
          reservation.reservationId,
        );
        rawReservations.delete(reservation.reservationId);
        return committed;
      }
      case 'release': {
        const reservationId = request.reservationId;
        const reservation = reservationId === undefined ? undefined : rawReservations.get(reservationId);
        if (!reservation?.queue.releaseReservedToolReply) return { disposition: 'inactive' };
        reservation.queue.releaseReservedToolReply(reservation.logicalTurnId, reservation.reservationId);
        rawReservations.delete(reservation.reservationId);
        return { disposition: 'released' };
      }
    }
  };
}

/** Binds socket and bridge reply calls to the currently owned runtime turn. */
export class RuntimeTurnReplySinks<Session> {
  private readonly options: RuntimeTurnReplySinksOptions<Session>;

  constructor(options: RuntimeTurnReplySinksOptions<Session>) {
    this.options = options;
  }

  forPerChat(mapKey: string): TurnReplySink {
    return this.create(() => this.options.perChat(mapKey));
  }

  forGlobal(): TurnReplySink {
    return this.create(() => this.options.global());
  }

  forSession(session: Session, fallbackMapKey?: string): TurnReplySink {
    return this.create(() => {
      const mapKey = this.options.mapKeyFor(session, fallbackMapKey);
      return mapKey === null ? this.options.global() : this.options.perChat(mapKey);
    });
  }

  private create(resolveCandidate: () => RuntimeTurnReplySinkCandidate): TurnReplySink {
    return createActiveTurnReplySink((request) => {
      const { active, queue } = resolveCandidate();
      if (
        !active
        || active.identity.conversationKey !== request.conversationKey
        || active.identity.managerId !== request.runtimeSessionId
        || !queue
      ) return undefined;
      return { queue, logicalTurnId: active.identity.logicalTurnId };
    });
  }
}
