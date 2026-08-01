import type { RuntimeTurnContext } from './runtime-turn-context.ts';

export interface RuntimeTurnCompletion {
  readonly context: RuntimeTurnContext;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface RuntimeTurnCompletionPort {
  readonly perChatRuntimeTurnCompletions: Map<string, RuntimeTurnCompletion>;
  readonly currentRuntimeTurnCompletion: RuntimeTurnCompletion | null;
}

export function rejectRuntimeTurnCompletionValue(
  host: RuntimeTurnCompletionPort,
  error: unknown,
  mapKey?: string,
  expectedContext?: RuntimeTurnContext,
): boolean {
  const completion = mapKey === undefined
    ? host.currentRuntimeTurnCompletion
    : host.perChatRuntimeTurnCompletions.get(mapKey);
  if (!completion) return false;
  if (
    expectedContext
    && completion.context.identity.logicalTurnId !== expectedContext.identity.logicalTurnId
  ) return false;
  completion.reject(error);
  return true;
}

export function createRuntimeTurnCompletionValue(
  context: RuntimeTurnContext,
): RuntimeTurnCompletion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { context, promise, resolve, reject };
}
