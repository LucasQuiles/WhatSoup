import { WhatSoupError } from '../errors.ts';

/** Stable log/error text for a send rejected before the provider call starts. */
export const OUTBOUND_GOVERNOR_SHED_LOG = 'outbound governor ceiling exceeded';

/** True when the local outbound governor rejected a send before transport mutation. */
export function isOutboundGovernorShed(err: unknown): boolean {
  if (err instanceof WhatSoupError && err.code === 'OUTBOUND_GOVERNOR_SHED') return true;
  return err instanceof Error && err.message === OUTBOUND_GOVERNOR_SHED_LOG;
}
