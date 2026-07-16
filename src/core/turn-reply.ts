export interface TurnReplyRequest {
  readonly chatJid: string;
  readonly conversationKey: string;
  readonly text: string;
}

export type TurnReplySinkResult =
  | { readonly disposition: 'queued' }
  | { readonly disposition: 'inactive' }
  | { readonly disposition: 'suppressed'; readonly reason: 'answer_already_claimed' }
  | { readonly disposition: 'rejected'; readonly reason: 'turn_target_mismatch' };

export type TurnReplySink = (request: TurnReplyRequest) => TurnReplySinkResult;
