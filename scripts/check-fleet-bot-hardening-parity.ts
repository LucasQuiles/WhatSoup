#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../src/lib/type-guards.ts';
import { receiptCapabilityDigest } from './lib/fleet-receipt-digest.ts';
import { rosterEpoch, rosterInventory } from './lib/fleet-roster-inventory.ts';

export const DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH =
  'docs/reliability-runner/fleet-bot-hardening-parity.json';

// Conventional path of the committed fleet roster SSOT, same file
// `deploy/scripts/lib/bot_errors_roster.py`'s `default_roster_path()` resolves
// to by default. The inventory-epoch binding check (#1867 criterion 3)
// recomputes the roster digest/inventory from this file independently,
// mirroring how `bot-errors-heartbeat-watchdog.py` never trusts the
// sentinel's declared digest without recomputing it from disk first.
export const FLEET_ROSTER_PATH = 'deploy/bot-errors-expected-fleet.json';

// Documented freshness backstop for the source-side parity manifest. The fleet
// hardening standard expires rows on runtime events (restart, re-cut, config or
// credential change); this age budget is a coarse fail-closed floor so a manifest
// that is never refreshed cannot stay green forever. It is deliberately generous
// (the tracked manifest ages out ~90 days after its `updated` date) so it never
// second-guesses a manifest that is being actively maintained. Event-based
// expiry is tracked separately from this age check.
export const FLEET_BOT_HARDENING_PARITY_MAX_AGE_DAYS = 90;
const FLEET_BOT_HARDENING_PARITY_MAX_AGE_MS =
  FLEET_BOT_HARDENING_PARITY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

export const REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES = [
  'turn-capability-health',
  'primary-model-usability-probe',
  'release-drift-check-job',
  'fallback-chain',
] as const;

const rowStatuses = new Set([
  'hardened',
  'pending-rollout',
  'blocked',
  'accepted-exception',
]);

const capabilityStates = new Set([
  'proven',
  'missing-live-proof',
  'deferred',
  'blocked',
  'accepted-exception',
]);

const privateInstanceLabel = `${['m', 'w'].join('')}-bot`;
const privateHostLabelAlternates = [
  ['m', 'w', 'lab'].join(''),
  ['n', 'u', 'cles'].join(''),
  ['ana', 'bot'].join(''),
  ['m', 'ac', 'lab'].join(''),
].join('|');
const privateTailnetAddressPatterns = [
  ['100', '91', '13', '7'].join('.'),
  ['100', '84', '79', '77'].join('.'),
].map((address) => new RegExp(String.raw`\b${address.replaceAll('.', String.raw`\.`)}\b`));

const privateLabelPatterns = [
  new RegExp(String.raw`\b${privateInstanceLabel}\b`, 'i'),
  new RegExp(String.raw`\bwhatsapp:${privateInstanceLabel}\b`, 'i'),
  new RegExp(String.raw`\b(?:${privateHostLabelAlternates})\b`, 'i'),
  /\/(?:Users|home)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/,
  ...privateTailnetAddressPatterns,
];

export type FleetBotHardeningParityFindingCode =
  | 'manifest-unreadable'
  | 'manifest-not-object'
  | 'unsupported-schema'
  | 'invalid-updated'
  | 'future-updated'
  | 'stale-updated'
  | 'missing-standard'
  | 'invalid-scope'
  | 'summary-not-object'
  | 'summary-count-mismatch'
  | 'capabilities-not-list'
  | 'missing-required-capability'
  | 'unknown-capability'
  | 'rows-not-list'
  | 'row-not-object'
  | 'invalid-row-id'
  | 'duplicate-row-id'
  | 'invalid-row-status'
  | 'missing-row-verified-at'
  | 'invalid-row-verified-at'
  | 'future-row-verified-at'
  | 'stale-row-verified-at'
  | 'row-capabilities-not-object'
  | 'missing-row-capability'
  | 'unknown-row-capability'
  | 'invalid-capability-state'
  | 'hardened-row-not-proven'
  | 'pending-row-without-gap'
  | 'pending-row-without-next-action'
  | 'blocked-row-without-next-action'
  | 'exception-row-without-exception'
  | 'evidence-not-list'
  | 'hardened-row-without-evidence'
  | 'private-label'
  | 'source-anchors-not-list'
  | 'source-anchor-not-object'
  | 'source-anchor-missing-file'
  | 'source-anchor-unsafe-path'
  | 'source-anchor-anchors-not-list'
  | 'source-anchor-missing-anchor'
  | 'invalid-inventory-binding'
  | 'roster-unreadable'
  | 'roster-digest-mismatch'
  | 'roster-instance-count-mismatch'
  | 'future-roster-epoch'
  | 'invalid-row-release-commit'
  | 'invalid-row-release-identity'
  | 'invalid-row-receipt'
  | 'invalid-row-receipt-digest'
  | 'invalid-row-receipt-captured-at'
  | 'future-row-receipt-captured-at'
  | 'stale-row-receipt'
  | 'receipt-file-missing'
  | 'receipt-digest-mismatch';

export interface FleetBotHardeningParityFinding {
  code: FleetBotHardeningParityFindingCode;
  message: string;
  path?: string;
}

export interface FleetBotHardeningParityResult {
  ok: boolean;
  rows: number;
  sourceAnchors: number;
  findings: FleetBotHardeningParityFinding[];
  // Source-anchor validation (docs/tests exist and contain required markers)
  // reported separately from runtime parity (#1867 criterion 4), so a docs-only
  // fix cannot masquerade as fleet-runtime proof and vice versa. `ok` above
  // remains the AND of both, for CI-gating back-compat.
  sourceAnchorParity: { ok: boolean; findings: FleetBotHardeningParityFinding[] };
  runtimeParity: { ok: boolean; findings: FleetBotHardeningParityFinding[] };
}

function finding(
  code: FleetBotHardeningParityFindingCode,
  message: string,
  entryPath?: string,
): FleetBotHardeningParityFinding {
  return entryPath === undefined ? { code, message } : { code, message, path: entryPath };
}

function isSafeRepoRelativePath(filePath: string): boolean {
  if (filePath.trim() !== filePath || filePath === '') return false;
  if (path.isAbsolute(filePath)) return false;
  const parts = filePath.split(/[\\/]+/);
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

// Repo-relative-path escape check shared by the receipt-file lookup
// (`validateRows`'s `receipt.path` branch) and the source-anchor file lookup
// (`validateSourceAnchors`). Resolves `filePath` against `cwd` only when it
// is BOTH a syntactically safe repo-relative path (`isSafeRepoRelativePath`)
// AND its resolved absolute path stays within `cwd`. Returns `null` for
// either failure mode -- the `isSafeRepoRelativePath` check already rejects
// `..` components, absolute paths, and other unsafe shapes, so the
// resolve-and-compare check below is deliberate defense-in-depth (mirrors
// the sentinel/watchdog "never trust, always recompute" pattern used
// elsewhere in this file), not the primary gate. Callers own their own
// finding code/message and any subsequent existence check.
function resolveSafeRepoPath(cwd: string, filePath: string): string | null {
  if (!isSafeRepoRelativePath(filePath)) return null;
  const absolutePath = path.resolve(cwd, filePath);
  const cwdResolved = path.resolve(cwd);
  if (absolutePath !== cwdResolved && !absolutePath.startsWith(cwdResolved + path.sep)) {
    return null;
  }
  return absolutePath;
}

function arrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

// Same 40-hex full-git-sha shape `FULL_GIT_SHA_RE` enforces in
// `src/lib/git-env.ts:33`, mirrored here (that constant is not exported) but
// lowercase-only rather than case-insensitive, matching this file's existing
// lowercase-only hex conventions (e.g. `inventoryBinding.rosterDigest`'s
// `/^[0-9a-f]{64}$/` check above) since committed manifest identity fields are
// expected to already be canonical lowercase.
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/;

// Shape of a manifest row's `receipt.digest` (design §6): `sha256:` prefix
// plus lowercase 64-hex, so the guard can reject a malformed digest string
// cheaply before ever trying to open the referenced receipt file.
const RECEIPT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// Shape of a manifest row's `receipt.capturedAt` (design §6, "ISO-8601
// timestamp", e.g. `2026-07-16T03:00:00Z`): `YYYY-MM-DDTHH:MM:SS`, an
// optional fractional-seconds component, and a mandatory `Z` or numeric
// UTC-offset suffix. Raw `Date.parse` alone is not a shape check -- it also
// accepts strings like `2026/06/18` or the bare year `2026`, which would
// silently pass a check whose finding message promises "ISO-8601". This
// regex is a pre-check in front of `Date.parse`, not a replacement for it:
// it only enforces the timestamp's shape, so a value that matches but is
// still not a real calendar date/time (e.g. month 13) is left for
// `Date.parse` to reject.
const ISO_8601_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Parse a `YYYY-MM-DD` manifest date as UTC midnight. Returns null when the
// value is not that exact shape or is not a real calendar date, so callers can
// distinguish a malformed date from a freshness violation.
function parseManifestDateMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

function recordPrivateLabelFindings(
  findings: FleetBotHardeningParityFinding[],
  value: unknown,
  context: string,
): void {
  if (typeof value === 'string') {
    for (const pattern of privateLabelPatterns) {
      if (pattern.test(value)) {
        findings.push(finding('private-label', `private label-like value is not allowed in parity manifest at ${context}`));
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => recordPrivateLabelFindings(findings, item, `${context}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      recordPrivateLabelFindings(findings, nested, `${context}.${key}`);
    }
  }
}

function validateSummary(
  payload: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  findings: FleetBotHardeningParityFinding[],
): void {
  const summary = payload['summary'];
  if (!isRecord(summary)) {
    findings.push(finding('summary-not-object', 'parity manifest summary must be an object'));
    return;
  }

  const counts = {
    total: rows.length,
    hardened: rows.filter((row) => row['status'] === 'hardened').length,
    pendingRollout: rows.filter((row) => row['status'] === 'pending-rollout').length,
    blocked: rows.filter((row) => row['status'] === 'blocked').length,
    acceptedException: rows.filter((row) => row['status'] === 'accepted-exception').length,
  };

  for (const [key, actual] of Object.entries(counts)) {
    if (summary[key] !== actual) {
      findings.push(finding(
        'summary-count-mismatch',
        `parity summary ${key}=${String(summary[key])} does not match row count ${actual}`,
      ));
    }
  }
}

function validateCapabilities(payload: Record<string, unknown>, findings: FleetBotHardeningParityFinding[]): void {
  const capabilities = arrayOfStrings(payload['capabilities']);
  if (capabilities === null) {
    findings.push(finding('capabilities-not-list', 'parity manifest capabilities must be an array of strings'));
    return;
  }

  const declared = new Set(capabilities);
  for (const required of REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES) {
    if (!declared.has(required)) {
      findings.push(finding('missing-required-capability', `parity manifest is missing required capability: ${required}`));
    }
  }
  for (const capability of declared) {
    if (!REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES.includes(
      capability as typeof REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES[number],
    )) {
      findings.push(finding('unknown-capability', `unknown parity capability: ${capability}`));
    }
  }
}

function validateRows(
  cwd: string,
  payload: Record<string, unknown>,
  findings: FleetBotHardeningParityFinding[],
  now: Date,
): Array<Record<string, unknown>> {
  const rawRows = payload['rows'];
  if (!Array.isArray(rawRows)) {
    findings.push(finding('rows-not-list', 'parity manifest rows must be a list'));
    return [];
  }

  const rows: Array<Record<string, unknown>> = [];
  const seenIds = new Set<string>();
  for (const [index, rawRow] of rawRows.entries()) {
    const context = `rows[${index}]`;
    if (!isRecord(rawRow)) {
      findings.push(finding('row-not-object', `${context} must be an object`));
      continue;
    }
    rows.push(rawRow);

    const rowId = rawRow['id'];
    if (typeof rowId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(rowId)) {
      findings.push(finding('invalid-row-id', `${context}.id must be a safe redacted id`));
    } else if (seenIds.has(rowId)) {
      findings.push(finding('duplicate-row-id', `duplicate parity row id: ${rowId}`));
    } else {
      seenIds.add(rowId);
    }

    const status = rawRow['status'];
    if (typeof status !== 'string' || !rowStatuses.has(status)) {
      findings.push(finding('invalid-row-status', `${context}.status is invalid: ${String(status)}`));
    }

    const capabilities = rawRow['capabilities'];
    if (!isRecord(capabilities)) {
      findings.push(finding('row-capabilities-not-object', `${context}.capabilities must be an object`));
      continue;
    }

    let provenCount = 0;
    let gapCount = 0;
    for (const capability of REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES) {
      const state = capabilities[capability];
      if (state === undefined) {
        findings.push(finding('missing-row-capability', `${context} is missing capability ${capability}`));
        continue;
      }
      if (typeof state !== 'string' || !capabilityStates.has(state)) {
        findings.push(finding('invalid-capability-state', `${context}.${capability} has invalid state ${String(state)}`));
        continue;
      }
      if (state === 'proven') provenCount += 1;
      else gapCount += 1;
    }

    for (const capability of Object.keys(capabilities)) {
      if (!REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES.includes(
        capability as typeof REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES[number],
      )) {
        findings.push(finding('unknown-row-capability', `${context} has unknown capability ${capability}`));
      }
    }

    const evidence = arrayOfStrings(rawRow['evidence']);
    if (evidence === null) {
      findings.push(finding('evidence-not-list', `${context}.evidence must be an array of strings`));
    }

    // Per-row runtime verification date. A hardened row asserts current runtime
    // parity, so it must carry a `verifiedAt` (fail closed with
    // missing-row-verified-at otherwise). Non-hardened rows may omit it, but
    // whenever it is present it must be a real YYYY-MM-DD, not in the future,
    // and within the freshness budget, so no row can carry a stale runtime
    // timestamp. (An immutable runtime-receipt digest that would upgrade this
    // operator-written assertion into captured proof is producer-gated and not
    // validated here.)
    const verifiedAt = rawRow['verifiedAt'];
    if (verifiedAt === undefined) {
      if (status === 'hardened') {
        findings.push(finding('missing-row-verified-at', `${context} is hardened but has no verifiedAt runtime-verification date`));
      }
    } else if (typeof verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) {
      findings.push(finding('invalid-row-verified-at', `${context}.verifiedAt must be YYYY-MM-DD`));
    } else {
      const verifiedMs = parseManifestDateMs(verifiedAt);
      if (verifiedMs === null) {
        findings.push(finding('invalid-row-verified-at', `${context}.verifiedAt must be a valid calendar date`));
      } else if (verifiedMs > now.getTime()) {
        findings.push(finding('future-row-verified-at', `${context}.verifiedAt ${verifiedAt} is in the future`));
      } else if (now.getTime() - verifiedMs > FLEET_BOT_HARDENING_PARITY_MAX_AGE_MS) {
        findings.push(finding(
          'stale-row-verified-at',
          `${context}.verifiedAt ${verifiedAt} is older than the ${FLEET_BOT_HARDENING_PARITY_MAX_AGE_DAYS}-day freshness budget`,
        ));
      }
    }

    // Row-level release/config identity (#1867 criterion 2, partial;
    // design §6/§7.3). Validate-when-present: a row that omits
    // `releaseIdentity` gets no finding at all -- the tracked manifest's rows
    // do not declare this field yet, and requiring it is a deferred,
    // separate change (the later manifest-migration increment). Whenever a
    // row *does* declare it, its shape/format must be fail-closed-correct:
    // `commit` must look like a real full git sha (mirroring
    // `FULL_GIT_SHA_RE` above), and `schemaMigration`/`provider` must be
    // present with the right type. This increment deliberately does NOT
    // cross-check the declared identity against a captured runtime receipt
    // (`release-identity-receipt-mismatch` / `verified-before-service-restart`
    // per design §7.3) -- that needs the receipt, which is a later increment.
    const releaseIdentity = rawRow['releaseIdentity'];
    if (releaseIdentity !== undefined) {
      if (!isRecord(releaseIdentity)) {
        findings.push(finding('invalid-row-release-identity', `${context}.releaseIdentity must be an object`));
      } else {
        const commit = releaseIdentity['commit'];
        const schemaMigration = releaseIdentity['schemaMigration'];
        const provider = releaseIdentity['provider'];

        if (typeof commit === 'string') {
          if (!FULL_GIT_SHA_RE.test(commit)) {
            findings.push(finding(
              'invalid-row-release-commit',
              `${context}.releaseIdentity.commit must be a full 40-hex git sha`,
            ));
          }
        } else {
          findings.push(finding(
            'invalid-row-release-identity',
            `${context}.releaseIdentity.commit must be a string`,
          ));
        }

        if (typeof schemaMigration !== 'number' || !Number.isInteger(schemaMigration) || schemaMigration < 0) {
          findings.push(finding(
            'invalid-row-release-identity',
            `${context}.releaseIdentity.schemaMigration must be a non-negative integer`,
          ));
        }

        if (typeof provider !== 'string' || provider.trim() === '') {
          findings.push(finding(
            'invalid-row-release-identity',
            `${context}.releaseIdentity.provider must be a non-empty string`,
          ));
        }
      }
    }

    // Runtime receipt reference (#1867 criterion 1, guard-side half; design
    // §6/§7.2, storage Option B). Validate-when-present: a row that omits
    // `receipt` gets no finding at all -- the tracked manifest's rows do not
    // declare this field yet, and requiring it on hardened rows is a
    // deferred, separate change (the manifest-migration increment). Whenever
    // a row *does* declare a receipt, its shape/format must be
    // fail-closed-correct, and -- because the referenced receipt file is
    // committed (Option B) -- the guard never trusts the declared digest: it
    // independently recomputes the capability-identity digest
    // (`fleet-receipt-digest.ts`, mirroring the roster digest recompute in
    // `validateInventoryBinding` below) from the file's own bytes and rejects
    // on mismatch. This increment deliberately does NOT cross-check `receipt`
    // against `releaseIdentity` (`release-identity-receipt-mismatch` /
    // `verified-before-service-restart` per design §7.3) -- that needs both
    // fields meaningfully populated on real rows, which is a later increment.
    const receipt = rawRow['receipt'];
    if (receipt !== undefined) {
      if (!isRecord(receipt)) {
        findings.push(finding('invalid-row-receipt', `${context}.receipt must be an object`));
      } else {
        const receiptDigest = receipt['digest'];
        const capturedAt = receipt['capturedAt'];
        const receiptPath = receipt['path'];

        const receiptDigestOk = typeof receiptDigest === 'string' && RECEIPT_DIGEST_RE.test(receiptDigest);
        if (!receiptDigestOk) {
          findings.push(finding(
            'invalid-row-receipt-digest',
            `${context}.receipt.digest must match ^sha256:[0-9a-f]{64}$`,
          ));
        }

        if (typeof capturedAt !== 'string') {
          findings.push(finding(
            'invalid-row-receipt-captured-at',
            `${context}.receipt.capturedAt must be a string`,
          ));
        } else if (!ISO_8601_TIMESTAMP_RE.test(capturedAt)) {
          findings.push(finding(
            'invalid-row-receipt-captured-at',
            `${context}.receipt.capturedAt must be an ISO-8601 timestamp (e.g. 2026-07-16T03:00:00Z)`,
          ));
        } else {
          const capturedMs = Date.parse(capturedAt);
          if (Number.isNaN(capturedMs)) {
            findings.push(finding(
              'invalid-row-receipt-captured-at',
              `${context}.receipt.capturedAt must be a parseable ISO-8601 timestamp`,
            ));
          } else if (capturedMs > now.getTime()) {
            findings.push(finding(
              'future-row-receipt-captured-at',
              `${context}.receipt.capturedAt ${capturedAt} is in the future`,
            ));
          } else if (now.getTime() - capturedMs > FLEET_BOT_HARDENING_PARITY_MAX_AGE_MS) {
            // CI-loose freshness budget (design §7.6): this reuses the same
            // 90-day cadence as `verifiedAt`/`updated`, matching human commit
            // cadence, NOT the hours/day-scale operator-side capture-time
            // gate that belongs in the (separate, not-yet-built) receipt
            // producer. Collapsing the two into one budget would make this
            // CI guard go red on unrelated pushes.
            findings.push(finding(
              'stale-row-receipt',
              `${context}.receipt.capturedAt ${capturedAt} is older than the ${FLEET_BOT_HARDENING_PARITY_MAX_AGE_DAYS}-day freshness budget`,
            ));
          }
        }

        let resolvedReceiptPath: string | null = null;
        if (typeof receiptPath !== 'string') {
          findings.push(finding(
            'receipt-file-missing',
            `${context}.receipt.path must be a safe repo-relative path`,
          ));
        } else {
          const safeReceiptPath = resolveSafeRepoPath(cwd, receiptPath);
          if (safeReceiptPath === null) {
            findings.push(finding(
              'receipt-file-missing',
              `${context}.receipt.path must be a safe repo-relative path`,
            ));
          } else if (!existsSync(safeReceiptPath)) {
            findings.push(finding(
              'receipt-file-missing',
              `receipt file is missing: ${receiptPath}`,
              receiptPath,
            ));
          } else {
            resolvedReceiptPath = safeReceiptPath;
          }
        }

        // Only attempt the recompute-and-compare once we have a
        // well-formed declared digest AND a real file to read -- a
        // malformed digest string or a missing file is already reported by
        // the checks above, and re-reporting the same problem as a
        // "mismatch" would be noise, not a distinct fact.
        if (receiptDigestOk && resolvedReceiptPath) {
          try {
            const receiptFileData: unknown = JSON.parse(readFileSync(resolvedReceiptPath, 'utf8'));
            const recomputedDigest = `sha256:${receiptCapabilityDigest(receiptFileData)}`;
            if (recomputedDigest !== receiptDigest) {
              findings.push(finding(
                'receipt-digest-mismatch',
                `${context}.receipt.digest=${String(receiptDigest)} does not match recomputed capability-identity digest=${recomputedDigest}`,
                receiptPath as string,
              ));
            }
          } catch (err) {
            findings.push(finding(
              'receipt-digest-mismatch',
              `cannot recompute capability-identity digest from receipt file ${String(receiptPath)}: ${(err as Error).message}`,
              receiptPath as string,
            ));
          }
        }
      }
    }

    if (status === 'hardened') {
      if (provenCount !== REQUIRED_FLEET_BOT_HARDENING_CAPABILITIES.length || gapCount !== 0) {
        findings.push(finding('hardened-row-not-proven', `${context} is hardened but not all capabilities are proven`));
      }
      if (evidence === null || evidence.length === 0) {
        findings.push(finding('hardened-row-without-evidence', `${context} is hardened but has no evidence`));
      }
    }

    if (status === 'pending-rollout') {
      if (gapCount === 0) findings.push(finding('pending-row-without-gap', `${context} is pending-rollout without a gap`));
      if (typeof rawRow['nextAction'] !== 'string' || rawRow['nextAction'].trim() === '') {
        findings.push(finding('pending-row-without-next-action', `${context} needs a nextAction`));
      }
    }

    if (status === 'blocked' && (typeof rawRow['nextAction'] !== 'string' || rawRow['nextAction'].trim() === '')) {
      findings.push(finding('blocked-row-without-next-action', `${context} needs a nextAction`));
    }

    if (status === 'accepted-exception' && !isRecord(rawRow['exception'])) {
      findings.push(finding('exception-row-without-exception', `${context} needs an exception object`));
    }
  }

  return rows;
}

function validateSourceAnchors(
  cwd: string,
  payload: Record<string, unknown>,
  findings: FleetBotHardeningParityFinding[],
): number {
  const anchors = payload['sourceAnchors'];
  if (!Array.isArray(anchors)) {
    findings.push(finding('source-anchors-not-list', 'sourceAnchors must be a list'));
    return 0;
  }

  let checked = 0;
  for (const [index, rawAnchor] of anchors.entries()) {
    const context = `sourceAnchors[${index}]`;
    if (!isRecord(rawAnchor)) {
      findings.push(finding('source-anchor-not-object', `${context} must be an object`));
      continue;
    }
    const filePath = rawAnchor['file'];
    if (typeof filePath !== 'string') {
      findings.push(finding('source-anchor-unsafe-path', `${context}.file must be a safe repo-relative path`));
      continue;
    }
    const absolutePath = resolveSafeRepoPath(cwd, filePath);
    if (absolutePath === null) {
      findings.push(finding('source-anchor-unsafe-path', `${context}.file must be a safe repo-relative path`));
      continue;
    }
    if (!existsSync(absolutePath)) {
      findings.push(finding('source-anchor-missing-file', `source anchor file is missing: ${filePath}`, filePath));
      continue;
    }
    const requiredAnchors = arrayOfStrings(rawAnchor['anchors']);
    if (requiredAnchors === null || requiredAnchors.length === 0) {
      findings.push(finding('source-anchor-anchors-not-list', `${context}.anchors must be a non-empty string list`, filePath));
      continue;
    }
    const text = readFileSync(absolutePath, 'utf8');
    checked += 1;
    for (const anchor of requiredAnchors) {
      if (!text.includes(anchor)) {
        findings.push(finding(
          'source-anchor-missing-anchor',
          `source anchor ${filePath} is missing marker: ${anchor}`,
          filePath,
        ));
      }
    }
  }

  return checked;
}

// Inventory-epoch / membership validation (#1867 criterion 3, design §7.4).
//
// `inventoryBinding` is manifest-level (a property of the whole redacted
// cohort, not one row) and validate-when-present: absent -> no finding at
// all, so the guard stays green on the tracked manifest
// (`docs/reliability-runner/fleet-bot-hardening-parity.json`), which does not
// yet declare this field (populating it is a deferred, separate change).
// Whenever a manifest *does* declare it, the guard never trusts the declared
// values -- it independently recomputes the roster digest/inventory from the
// committed roster file and rejects on mismatch, mirroring the existing
// sentinel/watchdog split (`bot-errors-heartbeat-watchdog.py`'s
// `declared_digest != independent_digest`) so membership drift cannot pass
// through self-consistent row counts.
function validateInventoryBinding(
  cwd: string,
  payload: Record<string, unknown>,
  findings: FleetBotHardeningParityFinding[],
): void {
  const inventoryBinding = payload['inventoryBinding'];
  if (inventoryBinding === undefined) return;

  if (!isRecord(inventoryBinding)) {
    findings.push(finding('invalid-inventory-binding', 'inventoryBinding must be an object'));
    return;
  }

  const declaredDigest = inventoryBinding['rosterDigest'];
  const declaredEpoch = inventoryBinding['rosterEpoch'];
  const declaredCount = inventoryBinding['expectedInstanceCount'];

  const digestOk = typeof declaredDigest === 'string' && /^[0-9a-f]{64}$/.test(declaredDigest);
  const epochOk = typeof declaredEpoch === 'number' && Number.isInteger(declaredEpoch) && declaredEpoch >= 0;
  const countOk = typeof declaredCount === 'number' && Number.isInteger(declaredCount) && declaredCount >= 0;

  if (!digestOk || !epochOk || !countOk) {
    findings.push(finding(
      'invalid-inventory-binding',
      'inventoryBinding.rosterDigest must be 64-hex, rosterEpoch and expectedInstanceCount must be non-negative integers',
    ));
    return;
  }

  const rosterPath = path.resolve(cwd, FLEET_ROSTER_PATH);
  let rosterData: unknown;
  try {
    rosterData = JSON.parse(readFileSync(rosterPath, 'utf8'));
  } catch (err) {
    findings.push(finding(
      'roster-unreadable',
      `cannot read fleet roster ${FLEET_ROSTER_PATH} to independently recompute inventoryBinding: ${(err as Error).message}`,
    ));
    return;
  }

  let inventory: ReturnType<typeof rosterInventory>;
  try {
    inventory = rosterInventory(rosterData);
  } catch (err) {
    findings.push(finding(
      'roster-unreadable',
      `cannot recompute roster inventory from ${FLEET_ROSTER_PATH}: ${(err as Error).message}`,
    ));
    return;
  }
  const independentEpoch = rosterEpoch(rosterPath);

  if (declaredDigest !== inventory.digest) {
    findings.push(finding(
      'roster-digest-mismatch',
      `inventoryBinding.rosterDigest=${declaredDigest} does not match independently recomputed roster digest=${inventory.digest}`,
    ));
  }
  if (declaredCount !== inventory.expectedInstanceCount) {
    findings.push(finding(
      'roster-instance-count-mismatch',
      `inventoryBinding.expectedInstanceCount=${declaredCount} does not match roster_inventory().expectedInstanceCount=${inventory.expectedInstanceCount}`,
    ));
  }
  if (independentEpoch !== null && declaredEpoch > independentEpoch) {
    findings.push(finding(
      'future-roster-epoch',
      `inventoryBinding.rosterEpoch=${declaredEpoch} is later than the roster file's current mtime epoch=${independentEpoch}`,
    ));
  }
}

export function checkFleetBotHardeningParity(
  cwd = process.cwd(),
  manifestPath = DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH,
  now: Date = new Date(),
): FleetBotHardeningParityResult {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path.resolve(cwd, manifestPath), 'utf8'));
  } catch (err) {
    const runtimeFindings = [finding('manifest-unreadable', `cannot read parity manifest ${manifestPath}: ${(err as Error).message}`)];
    return {
      ok: false,
      rows: 0,
      sourceAnchors: 0,
      findings: runtimeFindings,
      sourceAnchorParity: { ok: true, findings: [] },
      runtimeParity: { ok: false, findings: runtimeFindings },
    };
  }

  // Everything below is bucketed into exactly one of two sub-verdicts
  // (#1867 criterion 4): `sourceAnchorFindings` holds only what
  // `validateSourceAnchors` produces (docs/tests exist and carry required
  // markers); `runtimeFindings` holds every other finding (manifest shape,
  // capability enums, summary arithmetic, private-label redaction, and the
  // `updated`/`verifiedAt` date checks). This keeps a docs-only fix from
  // masquerading as fleet-runtime proof, and vice versa.
  const runtimeFindings: FleetBotHardeningParityFinding[] = [];
  const sourceAnchorFindings: FleetBotHardeningParityFinding[] = [];
  if (!isRecord(payload)) {
    runtimeFindings.push(finding('manifest-not-object', 'fleet bot hardening parity manifest must be a JSON object'));
    return {
      ok: false,
      rows: 0,
      sourceAnchors: 0,
      findings: runtimeFindings,
      sourceAnchorParity: { ok: true, findings: [] },
      runtimeParity: { ok: false, findings: runtimeFindings },
    };
  }

  if (payload['schemaVersion'] !== 1) {
    runtimeFindings.push(finding('unsupported-schema', `unsupported schemaVersion=${String(payload['schemaVersion'])}`));
  }
  const updated = payload['updated'];
  if (typeof updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) {
    runtimeFindings.push(finding('invalid-updated', 'parity manifest updated must be YYYY-MM-DD'));
  } else {
    const updatedMs = parseManifestDateMs(updated);
    if (updatedMs === null) {
      runtimeFindings.push(finding('invalid-updated', 'parity manifest updated must be a valid calendar date'));
    } else if (updatedMs > now.getTime()) {
      runtimeFindings.push(finding('future-updated', `parity manifest updated ${updated} is in the future`));
    } else if (now.getTime() - updatedMs > FLEET_BOT_HARDENING_PARITY_MAX_AGE_MS) {
      runtimeFindings.push(finding(
        'stale-updated',
        `parity manifest updated ${updated} is older than the ${FLEET_BOT_HARDENING_PARITY_MAX_AGE_DAYS}-day freshness budget; refresh the runtime parity evidence`,
      ));
    }
  }
  if (typeof payload['standard'] !== 'string' || !isSafeRepoRelativePath(payload['standard'])) {
    runtimeFindings.push(finding('missing-standard', 'parity manifest standard must be a safe repo-relative path'));
  } else if (!existsSync(path.resolve(cwd, payload['standard']))) {
    runtimeFindings.push(finding('missing-standard', `parity standard file is missing: ${payload['standard']}`, payload['standard']));
  }
  const scope = payload['scope'];
  if (!isRecord(scope) || typeof scope['cohortSize'] !== 'number' || scope['cohortSize'] <= 0) {
    runtimeFindings.push(finding('invalid-scope', 'parity manifest scope must include positive cohortSize'));
  }

  recordPrivateLabelFindings(runtimeFindings, payload, '$');
  validateCapabilities(payload, runtimeFindings);
  const rows = validateRows(cwd, payload, runtimeFindings, now);
  validateSummary(payload, rows, runtimeFindings);
  if (isRecord(scope) && typeof scope['cohortSize'] === 'number' && scope['cohortSize'] !== rows.length) {
    runtimeFindings.push(finding(
      'summary-count-mismatch',
      `scope cohortSize=${scope['cohortSize']} does not match row count ${rows.length}`,
    ));
  }
  validateInventoryBinding(cwd, payload, runtimeFindings);
  const sourceAnchors = validateSourceAnchors(cwd, payload, sourceAnchorFindings);

  return {
    ok: runtimeFindings.length === 0 && sourceAnchorFindings.length === 0,
    rows: rows.length,
    sourceAnchors,
    findings: [...runtimeFindings, ...sourceAnchorFindings],
    sourceAnchorParity: { ok: sourceAnchorFindings.length === 0, findings: sourceAnchorFindings },
    runtimeParity: { ok: runtimeFindings.length === 0, findings: runtimeFindings },
  };
}

function parseArgs(argv: string[]): { manifestPath: string; help: boolean } {
  let manifestPath = DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--manifest') {
      const value = argv[index + 1];
      if (!value) throw new Error('--manifest requires a path');
      manifestPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { manifestPath, help };
}

export function run(argv = process.argv.slice(2), cwd = process.cwd()): FleetBotHardeningParityResult {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`Usage: check-fleet-bot-hardening-parity.ts [--manifest ${DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH}]`);
    return {
      ok: true,
      rows: 0,
      sourceAnchors: 0,
      findings: [],
      sourceAnchorParity: { ok: true, findings: [] },
      runtimeParity: { ok: true, findings: [] },
    };
  }

  const result = checkFleetBotHardeningParity(cwd, args.manifestPath);
  if (!result.ok) {
    console.error('fleet bot hardening parity guard failed');
    // Print the two sub-verdicts under separate headers (#1867 criterion 4)
    // so a failing run shows which class of proof is missing: source
    // documentation being stale reads very differently from runtime receipts
    // being stale, and a single flat list can't say which.
    console.error(`source anchor parity: ${result.sourceAnchorParity.ok ? 'ok' : 'FAIL'}`);
    for (const item of result.sourceAnchorParity.findings) {
      console.error(`  ${item.code}: ${item.message}`);
    }
    console.error(`runtime parity: ${result.runtimeParity.ok ? 'ok' : 'FAIL'}`);
    for (const item of result.runtimeParity.findings) {
      console.error(`  ${item.code}: ${item.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`fleet bot hardening parity guard passed (${result.rows} row(s), ${result.sourceAnchors} source anchor file(s))`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
