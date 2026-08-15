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
  private readonly aliases = new Map<string, string>();

  record(scopeKey: string, error: unknown): boolean {
    const canonical = this.resolve(scopeKey);
    if (this.causes.has(canonical)) return false;
    this.causes.set(canonical, error);
    return true;
  }

  has(scopeKey: string): boolean {
    return this.causes.has(this.resolve(scopeKey));
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
    const from = this.resolve(fromScopeKey);
    const to = this.resolve(toScopeKey);
    if (from === to) return;

    this.aliases.set(fromScopeKey, to);
    this.aliases.set(from, to);
    const sourceWasPoisoned = this.causes.has(from);
    if (!this.causes.has(to) && sourceWasPoisoned) {
      this.causes.set(to, this.causes.get(from));
    }
    if (sourceWasPoisoned) this.causes.delete(from);
  }

  private resolve(scopeKey: string): string {
    let resolved = scopeKey;
    const seen = new Set<string>();
    while (!seen.has(resolved)) {
      seen.add(resolved);
      const next = this.aliases.get(resolved);
      if (next === undefined) break;
      resolved = next;
    }
    return resolved;
  }
}
