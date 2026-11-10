import { AsyncLocalStorage } from 'node:async_hooks';

export type TransportInboundContext =
  | { readonly inbound_event_id: string; readonly operation_id?: string }
  /** Desk-approved work has no conversational inbound event to inherit. */
  | { readonly inbound_event_id?: never; readonly operation_id: string };

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
