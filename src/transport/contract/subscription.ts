// src/transport/contract/subscription.ts

/** Disposable handle returned by adapter event subscriptions. */
export interface Subscription {
  /** Idempotent — calling twice does not throw and does not double-decrement listener counts. */
  dispose(): void;
}

export function makeSubscription(onDispose?: () => void): Subscription {
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      onDispose?.();
    },
  };
}
