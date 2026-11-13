const SCOPE_PREFIX = 'scope:';
const SCOPE_TAIL_RE = /^[a-z0-9-]{4,59}$/;

export type AccountScopeIdV1 = string & { readonly __accountScopeIdV1: unique symbol };

export function parseAccountScopeId(value: unknown): AccountScopeIdV1 | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(SCOPE_PREFIX)) return null;
  const tail = value.slice(SCOPE_PREFIX.length);
  if (!SCOPE_TAIL_RE.test(tail)) return null;
  // Reject digits-and-dashes-only tails so phone numbers cannot become scopes.
  if (!/[a-z]/.test(tail)) return null;
  return value as AccountScopeIdV1;
}
