import type { ContentType } from '../../core/types.ts';
import type { StoredMessage } from '../../core/messages.ts';
import type {
  RecoveryOwnerIdentity,
  TurnIdentity,
  TurnRecoveryReplayEnvelope,
} from './turn-terminal.ts';

export interface RuntimeTurnContext {
  readonly identity: Readonly<TurnIdentity>;
  readonly recoveryOwner: Readonly<RecoveryOwnerIdentity>;
  readonly replay: Readonly<TurnRecoveryReplayEnvelope>;
  readonly contentType: ContentType;
  readonly toolScopeKey: string;
}

export interface CreateRuntimeTurnContextParams {
  readonly identity: TurnIdentity;
  readonly recoveryOwner: RecoveryOwnerIdentity;
  readonly replay: TurnRecoveryReplayEnvelope;
  readonly contentType: ContentType;
  readonly toolScopeKey: string;
}

function freezeContext(params: CreateRuntimeTurnContextParams): RuntimeTurnContext {
  return Object.freeze({
    identity: Object.freeze({ ...params.identity }),
    recoveryOwner: Object.freeze({ ...params.recoveryOwner }),
    replay: Object.freeze({ ...params.replay }),
    contentType: params.contentType,
    toolScopeKey: params.toolScopeKey,
  });
}

export function createRuntimeTurnContext(
  params: CreateRuntimeTurnContextParams,
): RuntimeTurnContext {
  return freezeContext(params);
}

export function markRuntimeTurnReplayUnsafe(
  context: RuntimeTurnContext,
): RuntimeTurnContext {
  if (!context.replay.replaySafe) return context;
  return freezeContext({
    ...context,
    identity: context.identity,
    recoveryOwner: context.recoveryOwner,
    replay: { ...context.replay, replaySafe: false },
  });
}

export function rebindRuntimeTurnOwner(
  context: RuntimeTurnContext,
  owner: { readonly managerId: string; readonly generation: number; readonly toolScopeKey?: string },
): RuntimeTurnContext {
  if (
    context.identity.managerId === owner.managerId
    && context.identity.generation === owner.generation
    && (owner.toolScopeKey === undefined || context.toolScopeKey === owner.toolScopeKey)
  ) return context;
  return freezeContext({
    ...context,
    identity: {
      ...context.identity,
      managerId: owner.managerId,
      generation: owner.generation,
    },
    recoveryOwner: context.recoveryOwner,
    replay: context.replay,
    toolScopeKey: owner.toolScopeKey ?? context.toolScopeKey,
  });
}

export function excludeCurrentInboundMessage(
  messages: StoredMessage[],
  sourceMessageId: string | null | undefined,
): StoredMessage[] {
  return sourceMessageId ? messages.filter((message) => message.messageId !== sourceMessageId) : messages;
}
