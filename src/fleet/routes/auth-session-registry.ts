/**
 * Auth session state owned by one fleet server (#2239).
 *
 * `createFleetServer` builds one registry next to its route deps and hands the
 * same object to every auth route, so the 409 "auth already in progress" dedup
 * spans every request that server handles, across the SSE auth route and the
 * pairing saga routes, exactly as the old module-level map and sets did in a
 * one-server process. A second server built in the same process gets its own.
 */
import type { ChildProcess } from 'node:child_process';

export interface PairingEventRecord {
  event: string;
  data: string | null;
  at: string;
}

export interface AuthSessionRegistry {
  /** Live auth helper child per instance; a new session kills a stale one. */
  readonly activeAuthProcesses: Map<string, ChildProcess>;
  /** Instances with an auth operation in flight; a second request gets 409. */
  readonly authInFlight: Set<string>;
  /** Last pairing helper event per instance, served by the pairing status route. */
  readonly lastPairingEvents: Map<string, PairingEventRecord>;
}

export function createAuthSessionRegistry(): AuthSessionRegistry {
  return {
    activeAuthProcesses: new Map(),
    authInFlight: new Set(),
    lastPairingEvents: new Map(),
  };
}
