export interface ScopeAliasMigration {
  readonly from: string;
  readonly to: string;
}

export class ScopeAliasMap {
  private readonly aliases = new Map<string, string>();

  resolve(scopeKey: string): string {
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

  rekey(fromScopeKey: string, toScopeKey: string): ScopeAliasMigration | null {
    const from = this.resolve(fromScopeKey);
    const to = this.resolve(toScopeKey);
    if (from === to) return null;

    this.aliases.set(fromScopeKey, to);
    this.aliases.set(from, to);
    return { from, to };
  }
}
