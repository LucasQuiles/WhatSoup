// src/transport/registry.ts
// Compatibility re-export for the canonical core transport-reference registry.
// New core consumers import src/core/transport-refs.ts directly so the
// transport identity contract remains available without a core → transport edge.
//
// Add a new transport:
//   1. Append the canonical ID in src/core/transport-refs.ts (kebab-case).
//   2. Add its ChannelKind to src/core/transport-refs.ts if new.
//   3. Add a case in the transport factory switch — TypeScript will surface
//      any miss via the assertNeverTransport pattern at the throw site.
//   4. Extend config validation in src/core/agent-config-validator.ts.

export {
  TRANSPORT_IDS,
  DEFAULT_TRANSPORT_ID,
  isTransportId,
  assertNeverTransport,
} from '../core/transport-refs.ts';
export type { TransportId } from '../core/transport-refs.ts';
