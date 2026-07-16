#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../src/lib/type-guards.ts';

export const DEFAULT_FLEET_BOT_HARDENING_PARITY_PATH =
  'docs/reliability-runner/fleet-bot-hardening-parity.json';

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
  | 'source-anchor-missing-anchor';

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

function arrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

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
    if (typeof filePath !== 'string' || !isSafeRepoRelativePath(filePath)) {
      findings.push(finding('source-anchor-unsafe-path', `${context}.file must be a safe repo-relative path`));
      continue;
    }
    const absolutePath = path.resolve(cwd, filePath);
    if (!absolutePath.startsWith(path.resolve(cwd) + path.sep) && absolutePath !== path.resolve(cwd)) {
      findings.push(finding('source-anchor-unsafe-path', `${filePath} escapes repository`, filePath));
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
  const rows = validateRows(payload, runtimeFindings, now);
  validateSummary(payload, rows, runtimeFindings);
  if (isRecord(scope) && typeof scope['cohortSize'] === 'number' && scope['cohortSize'] !== rows.length) {
    runtimeFindings.push(finding(
      'summary-count-mismatch',
      `scope cohortSize=${scope['cohortSize']} does not match row count ${rows.length}`,
    ));
  }
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
