import { ScopeAliasMap } from './scope-alias-map.ts';

export interface OutboundQueuePoisonHealth {
  outboundQueuePoisoned: boolean;
  outboundQueuePoisonedScopes: number;
  activeAdmissionLaneBlocked: boolean;
}

/**
 * Monotonic process-local record of outbound scopes whose delivery queue has
 * entered its sticky failure state. Exact causes stay in memory for diagnosis;
 * only aggregate state is exposed to health surfaces.
 */
export class OutboundQueuePoisonRegistry {
  private readonly causes = new Map<string, unknown>();
  private readonly scopeAliases = new ScopeAliasMap();

  record(scopeKey: string, error: unknown): boolean {
    const canonical = this.scopeAliases.resolve(scopeKey);
    if (this.causes.has(canonical)) return false;
    this.causes.set(canonical, error);
    return true;
  }

  has(scopeKey: string): boolean {
    return this.causes.has(this.scopeAliases.resolve(scopeKey));
  }

  snapshot(): OutboundQueuePoisonHealth {
    const count = this.causes.size;
    return {
      outboundQueuePoisoned: count > 0,
      outboundQueuePoisonedScopes: count,
      activeAdmissionLaneBlocked: count > 0,
    };
  }

  rekey(fromScopeKey: string, toScopeKey: string): void {
    const migration = this.scopeAliases.rekey(fromScopeKey, toScopeKey);
    if (migration === null) return;
    const { from, to } = migration;
    const sourceWasPoisoned = this.causes.has(from);
    if (!this.causes.has(to) && sourceWasPoisoned) {
      this.causes.set(to, this.causes.get(from));
    }
    if (sourceWasPoisoned) this.causes.delete(from);
  }
}
