import type { RouteDecision } from './route-resolution.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';
import type { SessionManager } from './session.ts';
import type { SystemTurnLeaseToken } from './pending-system-result-tracker.ts';
import type { TurnDeliveryKind } from './turn-chronology.ts';

/** Exact next-session route captured when a fallback replay is admitted. */
export type ResolvedReplayRoute = RouteDecision & { pinnedProvider: string | null };

export class FallbackReplayInvalidatedError extends Error {}

export class FallbackReplayRouteChangedError extends FallbackReplayInvalidatedError {
  constructor() {
    super('Fallback replay route changed before session recreation');
    this.name = 'FallbackReplayRouteChangedError';
  }
}

export class FallbackReplayOwnershipChangedError extends FallbackReplayInvalidatedError {
  constructor() {
    super('Fallback replay owner changed before session recreation');
    this.name = 'FallbackReplayOwnershipChangedError';
  }
}

export interface ProviderFallbackReplayArgs {
  chatJid: string;
  mapKey?: string;
  replayText: string;
  actorJid?: string;
  oldSession: SessionManager | null;
  runtimeContext?: RuntimeTurnContext;
  routeOverride?: ResolvedReplayRoute;
}

/** Minimal runtime surface required to recreate and dispatch a fallback turn. */
export interface FallbackReplayHost {
  readonly perChatExecActorQueue: Map<string, (string | undefined)[]>;
  session: SessionManager | null;
  currentTurnChatJid: string | null;
  currentTurnReplayText: string | null;
  currentTurnReplayActorJid: string | undefined;
  turnHadVisibleOutput: boolean;
  discardPerChatSessionForFallback(mapKey: string, expected: SessionManager): boolean;
  discardSingletonSessionForFallback(expected: SessionManager): boolean;
  recreatePerChatSessionForFallback(
    mapKey: string,
    chatJid: string,
    actorJid?: string,
    routeOverride?: ResolvedReplayRoute,
  ): void;
  recreateSingletonSessionForFallback(
    chatJid: string,
    actorJid?: string,
    routeOverride?: ResolvedReplayRoute,
  ): void;
  isReplayRouteCurrent(
    chatJid: string,
    actorJid: string | undefined,
    routeOverride: ResolvedReplayRoute,
  ): boolean;
  bindActiveGlobalMcpConversation(chatJid: string): void;
  sendTurnPerChat(
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
    runtimeContext?: RuntimeTurnContext,
    scopeRef?: { value: string },
    systemTurnLease?: SystemTurnLeaseToken,
    excludeJobId?: number,
    deliveryKind?: TurnDeliveryKind,
  ): Promise<void>;
  sendTurnToSession(
    session: SessionManager,
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
    beforeUserSend?: () => void,
    systemTurnLease?: SystemTurnLeaseToken,
    dispatchAllowed?: () => boolean,
    runtimeContext?: RuntimeTurnContext,
    deliveryKind?: TurnDeliveryKind,
  ): Promise<void>;
}

export async function replayTurnOnFallback(
  host: FallbackReplayHost,
  args: ProviderFallbackReplayArgs,
): Promise<void> {
  if (args.oldSession) await args.oldSession.shutdown(false);
  let sourceStillOwned = true;
  if (args.mapKey !== undefined && args.oldSession) {
    // Clear the dead source before route revalidation. If the route drifted,
    // leaving this shutdown manager mapped would strand later turns on an
    // inactive session; the expected-owner guard preserves any newer session.
    sourceStillOwned = host.discardPerChatSessionForFallback(args.mapKey, args.oldSession);
    if (sourceStillOwned) {
      host.perChatExecActorQueue.delete(args.mapKey);
    }
  } else if (args.mapKey !== undefined) {
    // There is no owned source to guard in this legacy/no-session path, but
    // the replacement still must not inherit actors queued for the failed
    // turn. This preserves the established replay cleanup invariant.
    host.perChatExecActorQueue.delete(args.mapKey);
  } else if (args.oldSession) {
    sourceStillOwned = host.discardSingletonSessionForFallback(args.oldSession);
  }
  // A concurrent recovery or replacement won ownership while shutdown was in
  // flight. Do not let this replay replace that newer session or its actor
  // queue; the captured turn is no longer safe to apply here.
  if (!sourceStillOwned) {
    throw new FallbackReplayOwnershipChangedError();
  }
  // `routeOverride` proves the target that made an extended replay safe at
  // admission. Recheck it after shutdown because a fallback can be disabled,
  // rotated, or repinned while that await is in flight. Replaying onto a
  // drifted route would defeat the admission check, so fail closed instead.
  if (
    args.routeOverride
    && !host.isReplayRouteCurrent(args.chatJid, args.actorJid, args.routeOverride)
  ) {
    throw new FallbackReplayRouteChangedError();
  }
  if (args.mapKey !== undefined) {
    host.recreatePerChatSessionForFallback(
      args.mapKey,
      args.chatJid,
      args.actorJid,
      args.routeOverride,
    );
    await host.sendTurnPerChat(
      args.chatJid,
      args.replayText,
      args.mapKey,
      args.actorJid,
      args.runtimeContext,
      undefined,
      undefined,
      undefined,
      'recovery_replay',
    );
    return;
  }
  host.recreateSingletonSessionForFallback(args.chatJid, args.actorJid, args.routeOverride);
  host.currentTurnChatJid = args.chatJid;
  host.bindActiveGlobalMcpConversation(args.chatJid);
  host.turnHadVisibleOutput = false;
  host.currentTurnReplayText = args.replayText;
  host.currentTurnReplayActorJid = args.actorJid;
  await host.sendTurnToSession(
    host.session!,
    args.chatJid,
    args.replayText,
    undefined,
    args.actorJid,
    undefined,
    undefined,
    undefined,
    args.runtimeContext,
    args.runtimeContext === undefined ? 'live' : 'recovery_replay',
  );
}
