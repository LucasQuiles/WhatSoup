import { runHandoffDistill } from './handoff-distiller.ts';
import { initialDistillState, type DistillBudgetConfig, type DistillState } from './handoff-distill-gate.ts';
import type { DistillOutcome, ReserveDistillTokens } from './handoff-distiller.ts';
import type { HandoffArtifact } from './handoff-prelude.ts';

export interface HandoffDistillRunnerDeps {
  config: DistillBudgetConfig;
  now: () => number;
  growthThreshold: number;
  tokenGrowth: (conversationKey: string) => number;
  distillFor: (conversationKey: string, reserveTokens: ReserveDistillTokens) => Promise<DistillOutcome>;
  persist: (artifact: HandoffArtifact) => void;
  onDegraded: (conversationKey: string, reason: string) => void;
  onSucceeded?: (conversationKey: string) => void;
  sourceFor: (conversationKey: string) => { provider: string; model: string | null };
}

export class HandoffDistillRunner {
  private states = new Map<string, DistillState>();
  private invalidationGenerations = new Map<string, number>();
  private inFlight = new Set<string>();
  private globalInFlight = 0;
  // Explicit field (not a constructor parameter property): TS parameter
  // properties are unsupported under node --experimental-strip-types, which is
  // how WhatSoup runs source with no build step.
  private readonly deps: HandoffDistillRunnerDeps;

  constructor(deps: HandoffDistillRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Fence any pending distill for a conversation. The runner is deliberately
   * in-memory only: lifecycle invalidation must never create another stored
   * copy of a conversation identifier.
   */
  invalidateConversation(conversationKey: string): void {
    if (conversationKey.length === 0) return;
    const generation = this.invalidationGenerations.get(conversationKey) ?? 0;
    this.invalidationGenerations.set(conversationKey, generation + 1);
    // Artifact invalidation cannot refund a provider request or reset its budget.
  }

  private generationFor(conversationKey: string): number {
    return this.invalidationGenerations.get(conversationKey) ?? 0;
  }

  /**
   * Drop retained per-conversation gate state for conversations that are no
   * longer active, so `states` cannot grow unbounded over a long-running
   * process. Called by the sweep with the current active-conversation set. An
   * in-flight conversation is never pruned (its state is about to be written).
   */
  prune(activeKeys: Set<string>): void {
    for (const key of this.states.keys()) {
      if (!activeKeys.has(key) && !this.inFlight.has(key)) {
        this.states.delete(key);
      }
    }
    for (const key of this.invalidationGenerations.keys()) {
      if (!activeKeys.has(key) && !this.inFlight.has(key)) {
        this.invalidationGenerations.delete(key);
      }
    }
  }

  async tickConversation(conversationKey: string): Promise<void> {
    if (this.inFlight.has(conversationKey)) return; // per-conversation serialisation
    if (this.deps.tokenGrowth(conversationKey) < this.deps.growthThreshold) return;

    this.inFlight.add(conversationKey);
    this.globalInFlight += 1;
    try {
      const generation = this.generationFor(conversationKey);
      const state = this.states.get(conversationKey) ?? initialDistillState(this.deps.now());
      const source = this.deps.sourceFor(conversationKey);
      const result = await runHandoffDistill({
        state, config: this.deps.config, now: this.deps.now(),
        globalInFlight: this.globalInFlight - 1, // exclude self
        conversationKey, sourceProvider: source.provider, sourceModel: source.model,
        tokenBaseline: this.deps.tokenGrowth(conversationKey),
        distill: (reserveTokens) => this.deps.distillFor(conversationKey, reserveTokens),
        persist: (artifact) => {
          if (this.generationFor(conversationKey) === generation) {
            this.deps.persist(artifact);
          }
        },
        onDegraded: (reason) => {
          if (this.generationFor(conversationKey) === generation) {
            this.deps.onDegraded(conversationKey, reason);
          }
        },
      });
      this.states.set(conversationKey, result.nextState);
      if (this.generationFor(conversationKey) !== generation) return;
      if (result.ran) this.deps.onSucceeded?.(conversationKey);
    } finally {
      this.globalInFlight -= 1;
      this.inFlight.delete(conversationKey);
    }
  }
}
