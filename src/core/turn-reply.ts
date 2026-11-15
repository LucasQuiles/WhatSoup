export interface TurnReplyRequest {
  readonly chatJid: string;
  readonly conversationKey: string;
  readonly text: string;
  /** Opaque runtime SessionManager identity; never a provider token. */
  readonly runtimeSessionId: string;
  readonly action?: 'enqueue' | 'reserve' | 'commit' | 'release';
  /** Returned by reserve and required for a later raw-send commit or release. */
  readonly reservationId?: string;
  /** Completes the send audit only when the durable queue reaches a terminal transport outcome. */
  readonly deliveryObserver?: TurnReplyDeliveryObserver;
}

export interface TurnReplyDeliveryObserver {
  onProviderAcknowledged(): void;
  onProviderFailure(error: unknown): void;
  onNotSent(): void;
}

export type TurnReplySinkResult =
  | { readonly disposition: 'queued' }
  | { readonly disposition: 'reserved'; readonly reservationId: string }
  | { readonly disposition: 'committed' }
  | { readonly disposition: 'released' }
  | { readonly disposition: 'inactive' }
  | { readonly disposition: 'suppressed'; readonly reason: 'answer_already_claimed' }
  | { readonly disposition: 'rejected'; readonly reason: 'turn_target_mismatch' };

export type TurnReplySink = (request: TurnReplyRequest) => TurnReplySinkResult;
