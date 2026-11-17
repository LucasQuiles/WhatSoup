// Shared loopback address constants — single source of truth for the host
// set used by bind-guard modules (fleet + health) to decide whether a bind
// address is a safe local-only endpoint.

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);
