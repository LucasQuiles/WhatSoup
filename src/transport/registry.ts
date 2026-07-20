// src/transport/registry.ts
// Transport ID registry — single source of truth for the supported transport
// identifiers, mirroring the provider ID registry pattern
// (src/runtimes/agent/providers/index.ts).
//
// Add a new transport:
//   1. Append the canonical ID below (kebab-case).
//   2. Add its ChannelKind to src/core/transport-refs.ts if new.
//   3. Add a case in the transport factory switch — TypeScript will surface
//      any miss via the assertNeverTransport pattern at the throw site.
//   4. Extend config validation in src/core/agent-config-validator.ts.

/**
 * Canonical, ordered list of supported transport IDs. Frozen at module load
 * so accidental mutation throws in strict mode. Treat as a closed set.
 *
 * Ordering is stable-insertion: baileys (default), then transports in the
 * order they were added. New transports append to the end.
 */
export const TRANSPORT_IDS = Object.freeze(['baileys', 'twilio', 'signal', 'imessage'] as const);

/** Discriminated-union of supported transport IDs derived from {@link TRANSPORT_IDS}. */
export type TransportId = (typeof TRANSPORT_IDS)[number];

/** Default transport when none is specified in config. */
export const DEFAULT_TRANSPORT_ID: TransportId = 'baileys';

/**
 * Type guard: narrows an unknown value to {@link TransportId} iff it is one
 * of the canonical IDs. Case-sensitive — operators must use the exact ID.
 */
export function isTransportId(v: unknown): v is TransportId {
  return typeof v === 'string' && (TRANSPORT_IDS as readonly string[]).includes(v);
}

/**
 * Exhaustiveness helper for `switch` statements over {@link TransportId}.
 * Use at the end of a switch instead of a silent `default:` branch so that
 * adding a new transport ID surfaces a compile error at every consumer site.
 */
export function assertNeverTransport(v: never, ctx: string): never {
  throw new Error(
    `[${ctx}] unknown transport id: ${JSON.stringify(v)}. ` +
      `Valid: ${TRANSPORT_IDS.join(', ')}.`,
  );
}
