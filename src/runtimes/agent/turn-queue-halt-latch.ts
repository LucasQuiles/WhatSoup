import { ScopeAliasMap } from './scope-alias-map.ts';

export interface TurnQueueHaltHealth {
  turnQueueHalted: boolean;
  turnQueueHaltedScopes: number;
}

export class TurnQueueHaltLatch {
  private readonly haltedScopes = new Set<string>();
  private readonly scopeAliases = new ScopeAliasMap();

  snapshot(
    sessionScope: 'single' | 'shared' | 'per_chat',
    sharedQueueHalted: boolean,
  ): TurnQueueHaltHealth {
    const turnQueueHaltedScopes = sessionScope === 'per_chat'
      ? this.haltedScopes.size
      : sessionScope === 'shared' && sharedQueueHalted ? 1 : 0;
    return {
      turnQueueHalted: turnQueueHaltedScopes > 0,
      turnQueueHaltedScopes,
    };
  }

  has(scopeKey: string): boolean {
    return this.haltedScopes.has(this.scopeAliases.resolve(scopeKey));
  }

  halt(scopeKey: string): void {
    this.haltedScopes.add(this.scopeAliases.resolve(scopeKey));
  }

  rekey(fromScopeKey: string, toScopeKey: string): void {
    const migration = this.scopeAliases.rekey(fromScopeKey, toScopeKey);
    if (migration === null) return;
    const { from, to } = migration;
    if (this.haltedScopes.delete(from)) this.haltedScopes.add(to);
  }
}
