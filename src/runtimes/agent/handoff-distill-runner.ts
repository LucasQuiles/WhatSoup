import { runHandoffDistill } from './handoff-distiller.ts';
import { initialDistillState, type DistillBudgetConfig, type DistillState } from './handoff-distill-gate.ts';
import type { DistillOutcome } from './handoff-distiller.ts';
import type { HandoffArtifact } from './handoff-prelude.ts';

export interface HandoffDistillRunnerDeps {
  config: DistillBudgetConfig;
  now: () => number;
  growthThreshold: number;
  tokenGrowth: (conversationKey: string) => number;
  distillFor: (conversationKey: string) => Promise<DistillOutcome>;
  persist: (artifact: HandoffArtifact) => void;
  onDegraded: (conversationKey: string, reason: string) => void;
  sourceFor: (conversationKey: string) => { provider: string; model: string | null };
}

export class HandoffDistillRunner {
  private states = new Map<string, DistillState>();
  private inFlight = new Set<string>();
  private globalInFlight = 0;
  // Explicit field (not a constructor parameter property): TS parameter
  // properties are unsupported under node --experimental-strip-types, which is
  // how WhatSoup runs source with no build step.
  private readonly deps: HandoffDistillRunnerDeps;

  constructor(deps: HandoffDistillRunnerDeps) {
    this.deps = deps;
  }

  async tickConversation(conversationKey: string): Promise<void> {
    if (this.inFlight.has(conversationKey)) return; // per-conversation serialisation
    if (this.deps.tokenGrowth(conversationKey) < this.deps.growthThreshold) return;

    this.inFlight.add(conversationKey);
    this.globalInFlight += 1;
    try {
      const state = this.states.get(conversationKey) ?? initialDistillState(this.deps.now());
      const source = this.deps.sourceFor(conversationKey);
      const result = await runHandoffDistill({
        state, config: this.deps.config, now: this.deps.now(),
        globalInFlight: this.globalInFlight - 1, // exclude self
        conversationKey, sourceProvider: source.provider, sourceModel: source.model,
        tokenBaseline: this.deps.tokenGrowth(conversationKey),
        distill: () => this.deps.distillFor(conversationKey),
        persist: this.deps.persist,
        onDegraded: (reason) => this.deps.onDegraded(conversationKey, reason),
      });
      this.states.set(conversationKey, result.nextState);
    } finally {
      this.globalInFlight -= 1;
      this.inFlight.delete(conversationKey);
    }
  }
}
