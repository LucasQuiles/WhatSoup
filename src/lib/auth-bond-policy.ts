export const DEFAULT_FRESH_INVALID_GRACE_MS = 10_000;

/**
 * Auth-bond issue prefixes that mean "could not establish this", never "this
 * is broken".
 *
 * A nonblocking open that returns EAGAIN/EWOULDBLOCK says "not now" and says
 * nothing about the credential behind the path.
 */
export const TRANSIENT_AUTH_READ_ISSUE_PREFIXES = [
  'creds_json_read_transient:',
  'auth_dir_read_transient:',
] as const;

/**
 * Does this auth-bond snapshot carry a transient read?
 *
 * Lives here, in the policy module both sides already import, because the two
 * places that draw a DESTRUCTIVE or PAGING conclusion from a non-'present'
 * bond must not draw it from an indefinite read: AuthBondGuard's restore path,
 * which renames the live auth root away, and classifyAuthFailure, which pages
 * on local corruption. Sharing one predicate is what stops a new transient
 * reason being added to one and forgotten in the other.
 */
export function hasTransientAuthReadIssue(issues: readonly string[]): boolean {
  return issues.some(
    issue => TRANSIENT_AUTH_READ_ISSUE_PREFIXES.some(prefix => issue.startsWith(prefix)),
  );
}
