import type { TurnFinalizationBookkeepingParams } from '../../core/durability.ts';
import {
  finalizeRuntimeTurn,
  type FinalizeRuntimeTurnResult,
  type RuntimeAnswerEvidence,
  type RuntimeTurnFinalizerDurability,
} from './turn-finalizer.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';
import type { AttemptOutcome } from './turn-terminal.ts';

const MAX_RETAINED_FINALIZATIONS = 128;
const MAX_AUTOMATIC_RETRY_ATTEMPTS = 5;
const RETRY_BATCH_SIZE = 16;
const RETRY_DELAY_MS = 5_000;

type NonTerminalFinalization = Exclude<FinalizeRuntimeTurnResult, { kind: 'terminal' }>;

export interface RuntimeTurnFinalizationPostEffects {
  readonly queue: unknown;
  readonly mapKey?: string;
  readonly clearReplayOnSuccess?: boolean;
  readonly voice?: {
    readonly chatJid: string;
    readonly responseText: string;
    readonly inboundContentType: string | null;
  };
}

export interface RetainedRuntimeTurnFinalization<TPostEffects> {
  readonly context: RuntimeTurnContext;
  readonly attemptOutcome: AttemptOutcome;
  answerEvidence: RuntimeAnswerEvidence;
  readonly refreshAnswerEvidence?: () => Promise<RuntimeAnswerEvidence>;
  readonly bookkeeping: TurnFinalizationBookkeepingParams;
  readonly postEffects: TPostEffects;
  readonly failureStage: NonTerminalFinalization['failureStage'];
  incidentDurable: boolean;
  mayAdvance: boolean;
  postEffectsApplied: boolean;
  attempts: number;
  exhausted: boolean;
}

export interface RuntimeTurnRetryResult {
  readonly attempted: number;
  readonly recovered: number;
  readonly remaining: number;
  readonly degradedScopes: number;
}

export interface RuntimeTurnSupervisorHealth {
  readonly retainedRetries: number;
  readonly degradedScopes: number;
  readonly retryAttempts: number;
  readonly retryRecoveries: number;
  readonly retryExhaustions: number;
}

interface RecoveryWaiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function createRecoveryWaiter(): RecoveryWaiter {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export class RuntimeTurnSupervisor<TPostEffects> {
  private readonly retained = new Map<string, RetainedRuntimeTurnFinalization<TPostEffects>>();
  private readonly blockedTurnsByScope = new Map<string, Set<string>>();
  private readonly recoveryWaiters = new Map<string, RecoveryWaiter>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryInFlight: Promise<RuntimeTurnRetryResult> | null = null;
  private retryCursor = 0;
  private retryAttempts = 0;
  private retryRecoveries = 0;
  private retryExhaustions = 0;
  private closed = false;

  constructor(
    private readonly instanceName: string,
    private readonly durability: () => RuntimeTurnFinalizerDurability | null,
    private readonly applyRecovered: (
      result: Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' }>,
      retained: RetainedRuntimeTurnFinalization<TPostEffects>,
    ) => void | Promise<void>,
  ) {}

  scopeKey(context: RuntimeTurnContext): string {
    return context.identity.scope === 'per_chat'
      ? `per_chat:${context.identity.conversationKey}`
      : context.identity.scope;
  }

  isDegraded(context: RuntimeTurnContext): boolean {
    return (this.blockedTurnsByScope.get(this.scopeKey(context))?.size ?? 0) > 0;
  }

  canAccept(context: RuntimeTurnContext): boolean {
    return !this.closed
      && !this.isDegraded(context)
      && this.retained.size < MAX_RETAINED_FINALIZATIONS;
  }

  markDegraded(context: RuntimeTurnContext): void {
    this.block(context);
  }

  retain(
    record: Omit<
      RetainedRuntimeTurnFinalization<TPostEffects>,
      | 'attempts'
      | 'exhausted'
      | 'failureStage'
      | 'incidentDurable'
      | 'mayAdvance'
      | 'postEffectsApplied'
    >,
    failure: NonTerminalFinalization,
  ): RetainedRuntimeTurnFinalization<TPostEffects> {
    if (this.closed) {
      throw new Error('Runtime turn supervisor is closed; late finalization cannot be retained');
    }
    const turnId = record.context.identity.logicalTurnId;
    const existing = this.retained.get(turnId);
    if (existing) {
      if (failure.kind === 'durable_failure_incident') {
        existing.incidentDurable = true;
        existing.mayAdvance = existing.mayAdvance || failure.mayAdvance;
      }
      return existing;
    }

    const retained: RetainedRuntimeTurnFinalization<TPostEffects> = {
      ...record,
      failureStage: failure.failureStage,
      incidentDurable: failure.kind === 'durable_failure_incident',
      mayAdvance: failure.kind === 'durable_failure_incident' && failure.mayAdvance,
      postEffectsApplied: false,
      attempts: 0,
      exhausted: false,
    };
    this.retained.set(turnId, retained);
    this.recoveryWaiters.set(turnId, createRecoveryWaiter());

    if (!retained.mayAdvance || this.retained.size > MAX_RETAINED_FINALIZATIONS) {
      this.block(record.context);
    }
    this.scheduleRetry();
    return retained;
  }

  markPostEffectsApplied(context: RuntimeTurnContext): void {
    const retained = this.retained.get(context.identity.logicalTurnId);
    if (retained) retained.postEffectsApplied = true;
  }

  waitForRecovery(context: RuntimeTurnContext): Promise<void> {
    return this.recoveryWaiters.get(context.identity.logicalTurnId)?.promise ?? Promise.resolve();
  }

  health(): RuntimeTurnSupervisorHealth {
    return {
      retainedRetries: this.retained.size,
      degradedScopes: this.blockedTurnsByScope.size,
      retryAttempts: this.retryAttempts,
      retryRecoveries: this.retryRecoveries,
      retryExhaustions: this.retryExhaustions,
    };
  }

  retryAll(): Promise<RuntimeTurnRetryResult> {
    if (this.retryInFlight) return this.retryInFlight;
    this.clearRetryTimer();
    const retry = this.runRetries().finally(() => {
      this.retryInFlight = null;
      if (!this.closed && this.retryableCount() > 0) this.scheduleRetry();
    });
    this.retryInFlight = retry;
    return retry;
  }

  close(): void {
    this.closed = true;
    this.clearRetryTimer();
  }

  async shutdown(): Promise<RuntimeTurnRetryResult> {
    this.clearRetryTimer();
    let result = this.result(0, 0);
    for (let attempt = 0; attempt < MAX_AUTOMATIC_RETRY_ATTEMPTS; attempt += 1) {
      if (this.retained.size === 0 || this.retryableCount() === 0) break;
      result = await this.retryAll();
      this.clearRetryTimer();
    }
    this.closed = true;
    this.clearRetryTimer();
    result = this.result(result.attempted, result.recovered);
    if (result.remaining === 0) return result;

    const error = new Error(
      `Runtime turn shutdown left ${result.remaining} retained finalization(s) unresolved`,
    );
    for (const waiter of this.recoveryWaiters.values()) waiter.reject(error);
    this.recoveryWaiters.clear();
    throw error;
  }

  private async runRetries(): Promise<RuntimeTurnRetryResult> {
    const durability = this.durability();
    if (!durability || this.closed) return this.result(0, 0);

    const retryable = [...this.retained.entries()].filter(([, retained]) => (
      retained.attempts < MAX_AUTOMATIC_RETRY_ATTEMPTS
    ));
    if (retryable.length === 0) return this.result(0, 0);

    const start = this.retryCursor % retryable.length;
    const batchCount = Math.min(RETRY_BATCH_SIZE, retryable.length);
    const batch: typeof retryable = [];
    for (let offset = 0; offset < batchCount; offset += 1) {
      batch.push(retryable[(start + offset) % retryable.length]!);
    }
    this.retryCursor = (start + batchCount) % retryable.length;

    let attempted = 0;
    let recovered = 0;
    for (const [turnId, retained] of batch) {
      retained.attempts += 1;
      attempted += 1;
      this.retryAttempts += 1;
      try {
        if (retained.answerEvidence.kind === 'failed' && retained.refreshAnswerEvidence) {
          try {
            retained.answerEvidence = await retained.refreshAnswerEvidence();
          } catch {
            retained.answerEvidence = { kind: 'failed' };
          }
        }
        const result = finalizeRuntimeTurn({
          instanceName: this.instanceName,
          durability,
          identity: retained.context.identity,
          attemptOutcome: retained.attemptOutcome,
          answerEvidence: retained.answerEvidence,
          recoveryOwner: retained.context.recoveryOwner,
          replay: retained.context.replay,
          bookkeeping: retained.bookkeeping,
        });
        if (result.kind === 'terminal') {
          await this.applyRecovered(result, retained);
          this.retained.delete(turnId);
          this.unblock(retained.context, turnId);
          this.recoveryWaiters.get(turnId)?.resolve();
          this.recoveryWaiters.delete(turnId);
          recovered += 1;
          this.retryRecoveries += 1;
        } else if (result.kind === 'durable_failure_incident') {
          retained.incidentDurable = true;
          retained.mayAdvance = retained.mayAdvance || result.mayAdvance;
        } else if (!retained.incidentDurable) {
          this.block(retained.context);
        }
      } catch {
        this.block(retained.context);
      }

      if (
        this.retained.has(turnId)
        && retained.attempts >= MAX_AUTOMATIC_RETRY_ATTEMPTS
        && !retained.exhausted
      ) {
        retained.exhausted = true;
        this.retryExhaustions += 1;
        this.block(retained.context);
      }
    }
    return this.result(attempted, recovered);
  }

  private result(attempted: number, recovered: number): RuntimeTurnRetryResult {
    return {
      attempted,
      recovered,
      remaining: this.retained.size,
      degradedScopes: this.blockedTurnsByScope.size,
    };
  }

  private retryableCount(): number {
    let count = 0;
    for (const retained of this.retained.values()) {
      if (retained.attempts < MAX_AUTOMATIC_RETRY_ATTEMPTS) count += 1;
    }
    return count;
  }

  private scheduleRetry(): void {
    if (
      this.closed
      || this.retryTimer
      || this.retryInFlight
      || this.retryableCount() === 0
    ) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retryAll().catch(() => {
        // runRetries contains failures per retained record. This final catch is
        // only a last-resort rejection barrier for the timer callback.
      });
    }, RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private block(context: RuntimeTurnContext): void {
    const scopeKey = this.scopeKey(context);
    const blocked = this.blockedTurnsByScope.get(scopeKey) ?? new Set<string>();
    blocked.add(context.identity.logicalTurnId);
    this.blockedTurnsByScope.set(scopeKey, blocked);
  }

  private unblock(context: RuntimeTurnContext, turnId: string): void {
    const scopeKey = this.scopeKey(context);
    const blocked = this.blockedTurnsByScope.get(scopeKey);
    if (!blocked) return;
    blocked.delete(turnId);
    if (blocked.size === 0) this.blockedTurnsByScope.delete(scopeKey);
  }
}
