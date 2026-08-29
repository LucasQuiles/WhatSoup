/**
 * Shape rules for `service.expectedAccountDigest` — the owner-ratified,
 * opaque account-identity expectation stored next to the launchd render
 * options (`service.claudeConfigDir` / `service.pathPrepend`, task-20).
 *
 * Kept separate from lib/launchd-service-config.ts on purpose: that module
 * is the render-options contract and ignores unknown keys; this one owns the
 * identity field so the render contract stays untouched. Both are enforced
 * from the same place in the instance-config validator.
 *
 * Admission is the only place a raw identifier could enter an instance
 * config, so anything that is not a self-describing sha256 digest is
 * rejected here on every path (create / patch / load / discovery).
 */
import { isAccountIdentityDigest } from './account-identity-digest.ts';
import type { ServiceConfigError } from './launchd-service-config.ts';

export const EXPECTED_ACCOUNT_DIGEST_FIELD = 'service.expectedAccountDigest';

export interface ServiceIdentityValidationOptions {
  /** Instance type to judge against when the raw payload omits `type`
   *  (PATCH merges carry the immutable original type via the validator). */
  effectiveType?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawDigest(raw: Record<string, unknown>): unknown {
  const service = raw['service'];
  if (!isRecord(service)) return undefined;
  const digest = service['expectedAccountDigest'];
  return digest === null ? undefined : digest;
}

/**
 * Validate the identity field. Returns null when the field is absent or
 * valid. Block-shape errors (a non-object `service`) belong to the launchd
 * service-config validator and are not repeated here.
 */
export function validateServiceIdentityConfig(
  raw: Record<string, unknown>,
  options: ServiceIdentityValidationOptions = {},
): ServiceConfigError | null {
  const digest = rawDigest(raw);
  if (digest === undefined) return null;
  if (!isAccountIdentityDigest(digest)) {
    return {
      field: EXPECTED_ACCOUNT_DIGEST_FIELD,
      message: `${EXPECTED_ACCOUNT_DIGEST_FIELD} must be an opaque "sha256:<64 lowercase hex>" digest produced by \`npm run claude-account-digest\` — never a raw account identifier`,
    };
  }
  const type = raw['type'] ?? options.effectiveType;
  if (type !== 'agent') {
    return {
      field: EXPECTED_ACCOUNT_DIGEST_FIELD,
      message: `${EXPECTED_ACCOUNT_DIGEST_FIELD} is only verified on agent instances (type "agent"); remove it from this instance`,
    };
  }
  const agentOptions = raw['agentOptions'];
  const provider = isRecord(agentOptions) && typeof agentOptions['provider'] === 'string'
    ? agentOptions['provider']
    : 'claude-cli';
  if (provider !== 'claude-cli') {
    return {
      field: EXPECTED_ACCOUNT_DIGEST_FIELD,
      message: `${EXPECTED_ACCOUNT_DIGEST_FIELD} requires agentOptions.provider "claude-cli" (the identity receipt is read from the claude CLI); remove it for provider "${provider}"`,
    };
  }
  return null;
}

/**
 * Read the ratified digest from a parsed instance config. Null when nothing
 * is configured (verification disabled); throws on a malformed value so a
 * caller can never start with a half-valid expectation.
 */
export function extractExpectedAccountDigest(
  raw: Record<string, unknown> | null | undefined,
): string | null {
  if (!raw) return null;
  const error = validateServiceIdentityConfig(raw);
  if (error) throw new Error(error.message);
  const digest = rawDigest(raw);
  return isAccountIdentityDigest(digest) ? digest : null;
}
