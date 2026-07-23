export interface TurnQueueHaltHealth {
  turnQueueHalted: boolean;
  turnQueueHaltedScopes: number;
}

export class TurnQueueHaltLatch {
  private readonly haltedScopes = new Set<string>();
  private readonly scopeAliases = new Map<string, string>();

  snapshot(perChatMode: boolean, sharedQueueHalted: boolean): TurnQueueHaltHealth {
    const turnQueueHaltedScopes = perChatMode
      ? this.haltedScopes.size
      : sharedQueueHalted ? 1 : 0;
    return {
      turnQueueHalted: turnQueueHaltedScopes > 0,
      turnQueueHaltedScopes,
    };
  }

  has(scopeKey: string): boolean {
    return this.haltedScopes.has(this.resolve(scopeKey));
  }

  halt(scopeKey: string): void {
    this.haltedScopes.add(this.resolve(scopeKey));
  }

  rekey(fromScopeKey: string, toScopeKey: string): void {
    const from = this.resolve(fromScopeKey);
    const to = this.resolve(toScopeKey);
    if (from === to) return;
    this.scopeAliases.set(fromScopeKey, to);
    this.scopeAliases.set(from, to);
    if (this.haltedScopes.delete(from)) this.haltedScopes.add(to);
  }

  private resolve(scopeKey: string): string {
    let resolved = scopeKey;
    const seen = new Set<string>();
    while (!seen.has(resolved)) {
      seen.add(resolved);
      const next = this.scopeAliases.get(resolved);
      if (next === undefined) break;
      resolved = next;
    }
    return resolved;
  }
}
