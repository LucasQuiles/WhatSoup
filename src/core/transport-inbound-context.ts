import { AsyncLocalStorage } from 'node:async_hooks';

export interface TransportInboundContext {
  readonly inbound_event_id: string;
  /** Present only when authority has released this exact held operation. */
  readonly operation_id?: string;
}

const inboundContext = new AsyncLocalStorage<TransportInboundContext | undefined>();

export function withTransportInboundContext<T>(
  context: TransportInboundContext | undefined,
  work: () => T,
): T {
  // Undefined must clear a draining task's ambient authority for unbound work.
  return inboundContext.run(context === undefined ? undefined : Object.freeze({ ...context }), work);
}

export function getTransportInboundContext(): TransportInboundContext | undefined {
  return inboundContext.getStore();
}
