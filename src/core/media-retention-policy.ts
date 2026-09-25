/**
 * Owner-approved media-retention policy artifact (#3221 Debt 3, A-08).
 *
 * The capability-obligation release contract requires the retained-media
 * horizon to be an OWNER decision recorded in `policy/media-retention.json`,
 * not an engineering default — committing a value without approval would forge
 * one. The owner ruled the horizon 2026-08-28: 90 days.
 *
 * This module is the fail-closed loader/validator for that artifact plus the
 * compliance check the live config-load path runs for every ENABLED
 * capability-obligation activation (`src/config.ts`): the instance's
 * `retentionPolicyVersion` must name the ratified artifact exactly, and its
 * `retentionHorizonDays` may be equal to or STRICTER than (never longer than)
 * the approved horizon. A violation is a startup `ConfigValidationError`
 * (EX_CONFIG) — upstream of every DM/group media drain, so no drain can run
 * under a horizon the owner did not approve. Mirrors the all-or-inert rule:
 * a malformed enabled body never partially activates.
 *
 * Loading idiom: the artifact ships with the release (repo root `policy/`),
 * resolved relative to this module — the same release-tree-relative resolution
 * the config loader itself relies on. Parsing reuses the zod fail-closed style
 * of `capability-contract.ts` (strict shape; bounds unrepresentable-if-wrong:
 * the horizon is capped at 365 exactly like the config schema's A-08 bound).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const mediaRetentionPolicySchema = z
  .object({
    /** The version identifier enabled configs must reference verbatim. */
    policyVersion: z.string().min(1).max(128),
    /** The owner-approved finite retained-media horizon (A-08 bound, ≤365). */
    retentionHorizonDays: z.number().int().positive().max(365),
    /** Who approved the horizon (an owner decision, never an engineering one). */
    approvedBy: z.string().min(1).max(128),
    /** ISO date (YYYY-MM-DD) of the owner ruling. */
    approvedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'approvedAt must be an ISO date (YYYY-MM-DD)'),
    /** What the policy governs, for the reader (informational, required). */
    appliesTo: z.string().min(1),
  })
  .strict();

export type MediaRetentionPolicy = z.infer<typeof mediaRetentionPolicySchema>;

/** The artifact shipped with this release. */
export const MEDIA_RETENTION_POLICY_REPO_PATH = fileURLToPath(
  new URL('../../policy/media-retention.json', import.meta.url),
);

/** Parse and validate a raw policy document. Throws ZodError on any shape violation. */
export function parseMediaRetentionPolicy(raw: unknown): MediaRetentionPolicy {
  return mediaRetentionPolicySchema.parse(raw);
}

/**
 * Load the owner-approved artifact, fail-closed: a missing, unreadable, or
 * malformed policy file throws — there is no default horizon to fall back to.
 */
export function loadMediaRetentionPolicy(
  path: string = MEDIA_RETENTION_POLICY_REPO_PATH,
): MediaRetentionPolicy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `owner-approved media-retention policy ${path} could not be read (A-08 requires it; there is no default horizon): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `owner-approved media-retention policy ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseMediaRetentionPolicy(parsed);
}

/**
 * The drain-side verification (#3221 Debt 3 acceptance): an enabled
 * capability-obligation config must comply with the shipped owner-approved
 * artifact. Refuses (a) a horizon LONGER than the owner approved — a stricter
 * (shorter) horizon is allowed — and (b) a `retentionPolicyVersion` that does
 * not name the ratified artifact, so every obligation row's recorded
 * `retention_policy_version` provably refers to the approved policy.
 */
export function assertRetentionConfigCompliesWithPolicy(
  config: { retentionHorizonDays: number; retentionPolicyVersion: string },
  policy: MediaRetentionPolicy,
): void {
  if (config.retentionPolicyVersion !== policy.policyVersion) {
    throw new Error(
      `retentionPolicyVersion "${config.retentionPolicyVersion}" does not name the owner-approved media-retention policy version "${policy.policyVersion}" (policy/media-retention.json) — the config must reference the ratified artifact`,
    );
  }
  if (config.retentionHorizonDays > policy.retentionHorizonDays) {
    throw new Error(
      `retentionHorizonDays ${config.retentionHorizonDays} exceeds the owner-approved horizon of ${policy.retentionHorizonDays} days (policy/media-retention.json, approved ${policy.approvedAt}) — a longer retention than the owner ruled is refused; a stricter (shorter) horizon is allowed`,
    );
  }
}
