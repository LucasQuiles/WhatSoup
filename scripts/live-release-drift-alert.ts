#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isNonEmptyString } from '../src/lib/type-guards.ts';
import {
  createReleaseSnapshotDriftReport,
  parseReleaseSnapshotManifest,
  type ReleaseSnapshotDriftIssue,
  type ReleaseSnapshotDriftReport,
  type ReleaseSnapshotManifest,
} from './release-snapshot-plan.ts';
import { emitReleaseAlert, type ReleaseAlertEmitResult } from './lib/live-release-alert.ts';
import {
  hasWorkingDirectoryMismatch,
  resolveLaunchdReleaseSelection,
  type LaunchdReleaseSelection,
} from './lib/launchd-release-selector.ts';

/**
 * A launchd configuration finding, distinct from release-content drift: the
 * release the job runs verifies fine, but the plist describes a different one.
 */
export interface LaunchdSelectorIssue {
  kind: 'launchd-working-directory-mismatch';
  /** The release the job actually executes. */
  expected: string;
  /** The release `WorkingDirectory` names. */
  actual: string;
  message: string;
}

export type LiveReleaseDriftIssue = ReleaseSnapshotDriftIssue | LaunchdSelectorIssue;

export interface LiveReleaseDriftAlertOptions {
  repoRoot: string;
  releasePath: string;
  manifestPath?: string;
  instance: string;
  source: string;
  emit: boolean;
  emitHelper: string;
  python: string;
  clearOnOk: boolean;
  /**
   * The launchd job this release was resolved from, when it was. Supplies the
   * `WorkingDirectory` cross-check; absent for a direct `--release` check.
   */
  launchdSelection?: LaunchdReleaseSelection;
  /** Injected clock for deterministic observedAt in tests. */
  now?: () => Date;
}

export type LiveReleaseDriftOutcome = 'passed' | 'drift' | 'checker_failed' | 'emit_failed';

/**
 * Content-free (#2458): one JSON record per invocation. No absolute paths,
 * release basenames, instance labels, PIDs, raw manifest content, or issue
 * messages — only counts, digests, and bounded enums.
 */
export interface LiveReleaseDriftLogRecord {
  schemaVersion: 1;
  check: 'live-release-drift-alert';
  observedAt: string;
  invocationId: string;
  ok: boolean;
  outcome: LiveReleaseDriftOutcome;
  issueKinds: Record<string, number>;
  /** Domain-separated hash of the issue-kind set + release identity digest. */
  conditionFingerprint: string;
  desiredReleaseDigest: string;
  observedReleaseDigest: string;
  alert: {
    required: boolean;
    attempted: boolean;
    kind: 'alert' | 'clear' | null;
    status: number | null;
  };
  /** sha256 over a domain separator + the emitted BOT ERRORS event id; never the id itself. */
  correlationDigest: string | null;
}

export interface LiveReleaseDriftAlertResult {
  check: 'live-release-drift-alert';
  ok: boolean;
  releasePath: string;
  manifestPath: string;
  source: ReleaseSnapshotDriftReport['source'];
  issues: LiveReleaseDriftIssue[];
  /**
   * How this release was selected, when it came from a launchd job. Carried in
   * `--json` output only — the content-free record never names paths.
   */
  launchd: {
    plistPath: string;
    label: string | null;
    selector: LaunchdReleaseSelection['selector'];
    selectorPath: string;
    workingDirectory: string | null;
  } | null;
  record: LiveReleaseDriftLogRecord;
  alert: {
    required: boolean;
    attempted: boolean;
    kind: 'alert' | 'clear' | null;
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

interface ParsedArgs {
  releasePath?: string;
  /** Repeatable: one entry per launchd job to check in this invocation. */
  launchdPlistPaths: string[];
  manifestPath?: string;
  repoRoot: string;
  instance: string;
  source: string;
  emit: boolean;
  emitHelper?: string;
  python: string;
  clearOnOk: boolean;
  json: boolean;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_SOURCE = 'release-drift';
const DEFAULT_INSTANCE = 'release-bot';

function usage(): string {
  return [
    'Usage: scripts/live-release-drift-alert.ts (--release /absolute/release/path | --launchd-plist /absolute/plist ...) [options]',
    '',
    'Options:',
    '  --launchd-plist /absolute/plist     Check the release the job runs, derived from ProgramArguments',
    '                                      (repeatable — one record per job; WorkingDirectory is only cross-checked)',
    '  --manifest /absolute/manifest.json   Override manifest path for archived checks',
    '  --repo-root /absolute/repo            Repo root containing deploy/scripts/bot-errors-emit.py',
    '  --instance name                      BOT ERRORS instance label (default: release-bot)',
    '  --source name                        BOT ERRORS source label (default: release-drift)',
    '  --emit-helper /path/to/bot-errors-emit.py',
    '  --python /path/to/python             Python executable for emit helper (default: python3)',
    '  --no-emit                            Do not enqueue BOT ERRORS; still exits nonzero on drift',
    '  --clear-on-ok                        Enqueue a clear event when the release is clean',
    '  --json                               Print structured result',
  ].join('\n');
}

function requireAbsolute(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  return path.resolve(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    repoRoot: REPO_ROOT,
    launchdPlistPaths: [],
    instance: DEFAULT_INSTANCE,
    source: DEFAULT_SOURCE,
    emit: true,
    python: 'python3',
    clearOnOk: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--release') parsed.releasePath = next();
    else if (arg === '--launchd-plist') parsed.launchdPlistPaths.push(next());
    else if (arg === '--manifest') parsed.manifestPath = next();
    else if (arg === '--repo-root') parsed.repoRoot = next();
    else if (arg === '--instance') parsed.instance = next();
    else if (arg === '--source') parsed.source = next();
    else if (arg === '--emit-helper') parsed.emitHelper = next();
    else if (arg === '--python') parsed.python = next();
    else if (arg === '--no-emit') parsed.emit = false;
    else if (arg === '--clear-on-ok') parsed.clearOnOk = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') throw new Error(usage());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!parsed.releasePath && parsed.launchdPlistPaths.length === 0) throw new Error('one of --release or --launchd-plist is required');
  if (parsed.releasePath && parsed.launchdPlistPaths.length > 0) throw new Error('--release and --launchd-plist are mutually exclusive');
  if (parsed.releasePath) parsed.releasePath = requireAbsolute('--release', parsed.releasePath);
  parsed.launchdPlistPaths = parsed.launchdPlistPaths.map((plistPath) => requireAbsolute('--launchd-plist', plistPath));
  // BOT ERRORS keys an incident by machine|instance|source, and every target in
  // one invocation shares that key. A clean job's clear would therefore resolve
  // the incident a drifted job just opened — silent green, which is the failure
  // mode this check exists to remove. Refuse the combination rather than pick an
  // emit order and hope.
  if (parsed.clearOnOk && parsed.launchdPlistPaths.length > 1) {
    throw new Error('--clear-on-ok cannot be combined with several --launchd-plist targets: they share one BOT ERRORS incident key, so a clean job would clear another job\'s alert');
  }
  parsed.repoRoot = requireAbsolute('--repo-root', parsed.repoRoot);
  if (parsed.manifestPath) parsed.manifestPath = requireAbsolute('--manifest', parsed.manifestPath);
  if (!isNonEmptyString(parsed.instance)) throw new Error('--instance must be non-empty');
  if (!isNonEmptyString(parsed.source)) throw new Error('--source must be non-empty');
  return parsed;
}

/**
 * The release a launchd job runs, derived from `ProgramArguments`.
 *
 * This used to read `WorkingDirectory`, which selects nothing — see
 * `scripts/lib/launchd-release-selector.ts` for why that could not have caught
 * the incident this observer exists for.
 */
export function resolveReleasePathFromLaunchdPlist(plistPath: string): string {
  return resolveLaunchdReleaseSelection(requireAbsolute('--launchd-plist', plistPath)).releasePath;
}

function defaultEmitHelper(repoRoot: string): string {
  return path.join(repoRoot, 'deploy/scripts/bot-errors-emit.py');
}

/**
 * The release-content report plus the launchd findings that surround it. Kept
 * as one value so `ok` is derived ONCE, before the alert decision: a job whose
 * files verify but whose plist disagrees must alert, not clear.
 */
interface DriftAssessment {
  report: ReleaseSnapshotDriftReport;
  issues: LiveReleaseDriftIssue[];
  ok: boolean;
}

function assess(report: ReleaseSnapshotDriftReport, selection?: LaunchdReleaseSelection): DriftAssessment {
  const issues: LiveReleaseDriftIssue[] = [...report.issues];
  if (selection && hasWorkingDirectoryMismatch(selection)) {
    issues.push({
      kind: 'launchd-working-directory-mismatch',
      expected: selection.releasePath,
      actual: selection.workingDirectoryReleasePath!,
      message: `${selection.label ?? selection.plistPath} runs ${selection.releasePath} `
        + `(selected by ${selection.selector} ${selection.selectorPath}) but WorkingDirectory names `
        + `${selection.workingDirectoryReleasePath}`,
    });
  }
  return { report, issues, ok: report.ok && issues.length === 0 };
}

/**
 * The identity token carried in the alert text: the leading hex of the ratified
 * release identity, or the sentinel unchanged.
 *
 * Truncated rather than whole because the summary is human-facing incident text
 * and 64 hex characters would dominate it. Eight trades collision resistance
 * for that readability: it puts 32 bits of release identity into the three
 * dispatcher fingerprints that read this text (`storm_fingerprint`,
 * `recovery_episode_fingerprint` and `recovery_duplicate_fingerprint`).
 *
 * There is an on-point precedent against a short identity prefix in a grouping
 * key, and it is cited here rather than left for a reader to find.
 * `deploy/scripts/lib/bot_errors_redaction.py` names both widths as constants
 * (`LEGACY_DISPLAY_DIGEST_CHARS = 8`, `LEGACY_FULL_DIGEST_CHARS = 64`), and
 * `alert_text_for_fingerprint` renders with the 64 one because the display
 * rendering had put identity on an eight-character prefix and two incidents
 * sharing that prefix merged into one. A test pins that renderer
 * (`deploy/scripts/tests/test_bot_errors_legacy_alert_content.py:784-785`).
 * Read its scope exactly: it pins the fingerprint renderer's OWN digest field,
 * not the summary field this token travels in, and no test asserts a width
 * floor on the summary. The precedent is an argued analogy about entropy in a
 * grouping key, not a constraint this change breaks.
 *
 * Eight is accepted anyway, for reasons specific to what this token identifies.
 * It identifies a RELEASE, and the fleet is expected to run only a handful
 * of distinct releases at once, so a 32-bit prefix collision between two
 * concurrently alerting releases is negligible under that expectation
 * rather than merely improbable per pair. The full 64-hex identity
 * still rides the event's typed diagnostics (`desired_release_identity`, built
 * in `typedDriftDiagnostics` below), so the truncation is not the only copy.
 * The residual cost is disclosed rather than hidden: two distinct releases
 * sharing a token would group as one incident, and no test constructs that
 * collision.
 *
 * Widening is a judgement about the same trade-off rather than something the
 * redactor forbids, and it is a THREE-site change rather than a two-site one:
 * the slice below, the `RELEASE_IDENTITY_TOKEN_LENGTH` constant in the focused
 * test file, and the hardcoded width in that file's anchored token-shape regex,
 * which is a second deliberate oracle and does not read the constant.
 *
 * No redaction rule bounds the width, and that is worth stating because the
 * obvious reading is the wrong one. `PHONE_LIKE_RE`
 * (`deploy/scripts/lib/bot_errors_redaction.py`) does match a long bare digit
 * run, but `redact_phone_like_match` then declines it: the candidate has to
 * start with `+` or contain one of `[\s().-]` before the ten-to-fifteen digit
 * test is ever reached (`bot_errors_redaction.py:97-98`). A bare hex or digit
 * token has neither, so it passes through at any length. No other rule reaches
 * it either: every digest-shaped pattern there is anchored to a prefix (`AKIA`,
 * `gh?_`, `eyJ`) that a bare hex slice does not have.
 *
 * What is load-bearing is where the token goes, not how long it is. It is
 * appended last so it cannot merge with the parenthesised issue count: the
 * parentheses and the space are separator characters `PHONE_LIKE_RE` accepts,
 * so a token placed before the count contributes its own digits to a single
 * candidate, and an all-digit token that reaches the ten-digit floor that way
 * IS redacted. It is appended after a space rather than a comma so the
 * dispatcher's `normalize_token_lists`
 * (`deploy/scripts/bot-errors-dispatcher.py:6009-6014`) never reorders it; see
 * `alertSummary` below for why that matters to grouping.
 *
 * The sentinel is passed through as the literal word, never digested. Hashing it
 * would produce a token indistinguishable in shape from a real identity, so an
 * operator reading the incident could not tell an attested release from one that
 * had no readable manifest.
 *
 * The early return for the sentinel is a deliberate explicit contract rather
 * than a branch the current behaviour needs. `UNKNOWN_RELEASE_IDENTITY` is
 * seven characters, so the slice below already returns it unchanged, and
 * deleting the guard leaves this suite green. It is kept so the intent survives
 * a sentinel longer than the token width; no test in this file asserts it,
 * because none can distinguish its presence.
 */
function releaseIdentityToken(identity: string): string {
  if (identity === UNKNOWN_RELEASE_IDENTITY) return UNKNOWN_RELEASE_IDENTITY;
  return identity.slice(0, 8);
}

/**
 * The alert text, carrying the release identity but no release directory name
 * (#2385 L1b).
 *
 * The summary is the only free-text input to the dispatcher's
 * `storm_fingerprint` (source, severity, normalised summary). While it named the
 * release directory, two hosts running the SAME bytes under different directory
 * names produced two fingerprints and two incidents, which is exactly the
 * correlation the path-free identity above exists to establish. The name is an
 * accident of a rollout, so it is gone from the text.
 *
 * What replaces it is the identity token, and it deliberately DOES key the
 * storm. Dropping the basename without it left the text varying only by issue
 * count, so two unrelated releases drifting by the same amount would have
 * grouped into one incident. The token restores that discrimination on the
 * property that actually identifies a release. It is appended after a space, not
 * a comma: the dispatcher's `normalize_token_lists` sorts comma-joined runs, so
 * a comma would let the token reorder against its neighbours and make the
 * emitted text differ from the grouped text for no gain.
 *
 * Coverage limit, stated rather than implied, and it is ONE drift kind rather
 * than two. For `manifest-missing` there is no readable manifest:
 * `createReleaseSnapshotDriftReport` returns that kind early, before parsing
 * anything, so `readManifestFacts` below fails its own read, the identity is the
 * sentinel, and the token is that same constant on every host. Those events
 * still group across unrelated releases.
 *
 * `release-missing` is NOT such a kind, despite the adjacent name. It is pushed
 * inside `collectReleaseSnapshotDrift`, which is reached only after the manifest
 * has been read and parsed, so the manifest exists and is well formed,
 * `readManifestFacts` returns a real 64-hex identity, and the token is a
 * per-release digest that discriminates exactly as every other kind's does.
 * With the default manifest path the two kinds never compete: the manifest lives
 * inside the release directory, so a missing release directory makes the
 * manifest missing too and the kind reported is `manifest-missing`.
 * `release-missing` is reachable through the documented `--manifest` override,
 * and a test pins its token there as a real digest rather than the sentinel.
 *
 * Discrimination is restored for every drift kind except `manifest-missing`,
 * and except any event whose identity computation degrades to the sentinel:
 * `readManifestFacts` re-reads the manifest the drift report already read, so a
 * manifest that stops being readable or parseable in between either fails that
 * read or leaves `releaseIdentityFromManifestText` with unparseable JSON or a
 * rejected schema, and `containedReleaseIdentity` below degrades any unexpected
 * error to the sentinel rather than let it suppress the alert.
 *
 * The issue count stays, and it is a property of the drift rather than of the
 * release. Two hosts running the same release that drift to different extents
 * report different counts, and those alerts do land in different groups: what
 * groups is hosts that drifted the same way on the same release, not every host
 * running it.
 *
 * Cost, accepted by the owner ruling rather than overlooked: alerts emitted
 * before this change and alerts emitted after fingerprint differently, so one
 * 120-second storm window at cutover groups the two texts separately.
 */
function alertSummary(assessment: DriftAssessment, facts: ReleaseManifestFacts): string {
  const token = releaseIdentityToken(facts.identity);
  if (assessment.ok) return `release drift recovered release ${token}`;
  const count = assessment.issues.length;
  return `release drift detected (${count} issue${count === 1 ? '' : 's'}) release ${token}`;
}

function alertEvidence(assessment: DriftAssessment): string {
  return JSON.stringify({
    check: assessment.report.check,
    ok: assessment.ok,
    releasePath: assessment.report.releasePath,
    manifestPath: assessment.report.manifestPath,
    source: assessment.report.source,
    issueCount: assessment.issues.length,
    issues: assessment.issues.slice(0, 20),
  }, null, 2);
}

const RELEASE_IDENTITY_DOMAIN = 'whatsoup-release-identity-v1';
/** Unchanged #2458 domain: the digest over the manifest FILE bytes. */
const MANIFEST_DIGEST_DOMAIN = 'whatsoup-release-drift-manifest-v1';
/** Explicit sentinel for an identity that cannot be attested, never an empty string. */
const UNKNOWN_RELEASE_IDENTITY = 'unknown';

/** One member of the closed drift-kind union carried on the event. */
export type DriftKindMember = LiveReleaseDriftIssue['kind'];

/**
 * The `drift_kind` field: `none`, one kind, or a comma-joined ascending join of
 * kinds.
 *
 * What this type guarantees: the value is `none`, or it BEGINS with a member of
 * the closed kind union. What it does NOT guarantee: the tail after the first
 * comma. TypeScript rejects a recursive template literal (TS2456) and the
 * non-recursive expansion of nine kinds exceeds the union size limit, so the
 * tail is `${string}` and the type cannot reject `file-sha256-drift,anything`.
 * Boundedness of the tail is a RUNTIME property, asserted on the emitted value
 * in the two-kind test rather than claimed here.
 */
export type DriftKindField = 'none' | DriftKindMember | `${DriftKindMember},${string}`;

/**
 * The manifest-derived facts this invocation needs, taken from ONE read of the
 * manifest. Deriving them from two reads would let the manifest change between
 * them and let the log record and the event disagree about the same release.
 *
 * The drift report performs its own read of the same file. That second read is
 * kept separate BY CHOICE, not by contract necessity: reusing the report's
 * parse would mean rebuilding the report here, and one duplicated read is a
 * smaller cost than a duplicated report builder.
 */
interface ReleaseManifestFacts {
  /** sha256 over the manifest FILE bytes — the pre-existing #2458 semantics. */
  desiredDigest: string;
  /** Path-free identity over the PARSED manifest, or the unknown sentinel. */
  identity: string;
  /**
   * Class name of an unexpected error raised while computing the identity, or
   * null. The class name only — a message could carry a path or file content
   * into the event.
   */
  identityErrorClass: string | null;
}

/**
 * Path-free release identity (#2385 C1): a digest over the identity-bearing
 * fields of the VALIDATED manifest — schema version, source ref and commit, the
 * ascending repo-relative file list with hashes and sizes, and the required
 * outputs. `release.path`, `release.createdAt` and `rollback.path` are excluded
 * on purpose: the release directory name is an accident of a rollout, so two
 * assets deployed from the same bytes under different directory names are the
 * same release and must correlate.
 *
 * The input is the manifest the schema parser returns, not raw JSON, so the
 * parser's normalisations (repo-relative paths, lowercased hashes) are part of
 * the identity and a manifest that fails validation yields the sentinel rather
 * than a digest over whatever fields happened to be present.
 *
 * This is deliberately NOT `desiredReleaseDigest`, which hashes the manifest
 * FILE. That digest answers a different question (did this invocation see the
 * same manifest bytes?) and moves with the directory name, so it can never
 * correlate two differently-named assets.
 */
export function releaseIdentityFromManifestText(manifestText: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(manifestText);
  } catch (error) {
    if (error instanceof SyntaxError) return UNKNOWN_RELEASE_IDENTITY;
    throw error;
  }
  let manifest: ReleaseSnapshotManifest;
  try {
    manifest = parseReleaseSnapshotManifest(payload);
  } catch (error) {
    // The parser rejects every schema violation with a plain Error. A TypeError
    // or RangeError from here is a defect in this script, not a bad manifest,
    // and must surface instead of being laundered into the sentinel.
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    return UNKNOWN_RELEASE_IDENTITY;
  }
  // Encoded as an array of objects rather than a delimiter join: a joined
  // string admits crafted path/hash/size combinations that collide with a
  // different release, and JSON keeps every field boundary explicit.
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    sourceRef: manifest.source.ref,
    sourceCommit: manifest.source.commit,
    files: [...manifest.files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes })),
    requiredOutputs: [...manifest.requiredOutputs].sort(),
  });
  return domainDigest(RELEASE_IDENTITY_DOMAIN, canonical);
}

/**
 * Read the manifest once and derive both facts from the same bytes. An
 * unreadable manifest is not an error here: the drift report has already
 * classified that as `manifest-missing`, and both facts fail closed to the
 * sentinel.
 */
function readManifestFacts(manifestPath: string): ReleaseManifestFacts {
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, 'utf8');
  } catch {
    return { desiredDigest: UNKNOWN_RELEASE_IDENTITY, identity: UNKNOWN_RELEASE_IDENTITY, identityErrorClass: null };
  }
  const identity = containedReleaseIdentity(() => releaseIdentityFromManifestText(manifestText));
  return {
    desiredDigest: domainDigest(MANIFEST_DIGEST_DOMAIN, manifestText),
    identity: identity.identity,
    identityErrorClass: identity.errorClass,
  };
}

/**
 * Containment boundary for the identity computation. The identity is a side
 * fact; the drift alert is the product. `releaseIdentityFromManifestText`
 * deliberately re-throws anything that is not a parse or schema failure, so
 * without this boundary an unexpected error there would propagate out of
 * `checkLiveReleaseDrift` and suppress the alert the check exists to raise.
 *
 * Any unexpected error therefore degrades to the sentinel identity plus the
 * error's class name, and the alert still goes out.
 */
export function containedReleaseIdentity(compute: () => string): { identity: string; errorClass: string | null } {
  try {
    return { identity: compute(), errorClass: null };
  } catch (error) {
    const errorClass = error instanceof Error ? error.constructor.name : typeof error;
    return { identity: UNKNOWN_RELEASE_IDENTITY, errorClass };
  }
}

/**
 * The bounded drift kind for the event: the ascending set of issue kinds
 * present, or `none` when the release verifies. Every member comes from the
 * closed `LiveReleaseDriftIssue` union, so the result is a closed-enum join and
 * carries no content. Deliberately the same set `conditionFingerprint` is built
 * from, rather than a new precedence ordering no test pins.
 */
function driftKind(issues: readonly LiveReleaseDriftIssue[]): DriftKindField {
  const kinds: DriftKindMember[] = [...new Set(issues.map((issue) => issue.kind))].sort();
  const [first, ...rest] = kinds;
  if (first === undefined) return 'none';
  return rest.length === 0 ? first : `${first},${rest.join(',')}`;
}

/**
 * Typed drift facts as structured event data (#2385 L1a). They ride the emit
 * helper's existing repeatable `--diagnostic key=value` channel, which lands
 * them verbatim in the event's `diagnostics` object. This channel leaves the
 * human-readable summary untouched: `storm_fingerprint` keys on source,
 * severity and the normalized summary only, so adding diagnostics cannot re-key
 * an in-flight incident.
 *
 * Scoped to the diagnostics channel, and only to it. L1b since put the release
 * identity token into the summary itself, where it deliberately DOES key the
 * storm — see `releaseIdentityToken` and `alertSummary` above. Nothing here
 * says identity stays out of the grouping key; it says this channel is not how
 * identity gets there.
 */
function typedDriftDiagnostics(assessment: DriftAssessment, facts: ReleaseManifestFacts): string[] {
  // The observed tree identity is only attestable when verification passed —
  // the same rule the structured log record already applies. Reconstructing a
  // drifted tree's real identity needs a re-walk this leaf does not do, so it
  // stays the explicit sentinel rather than a guess.
  const observed = assessment.ok && facts.identity !== UNKNOWN_RELEASE_IDENTITY
    ? facts.identity
    : UNKNOWN_RELEASE_IDENTITY;
  // Annotated, not inferred: if driftKind is ever retyped to return a bare
  // `string`, this assignment stops compiling. It is the only type-level guard
  // on the field, so it is deliberately a declaration and not an inline call.
  const kindField: DriftKindField = driftKind(assessment.issues);
  const diagnostics = [
    `drift_kind=${kindField}`,
    `desired_release_identity=${facts.identity}`,
    `observed_release_identity=${observed}`,
  ];
  if (facts.identityErrorClass !== null) diagnostics.push(`release_identity_error=${facts.identityErrorClass}`);
  return diagnostics;
}

function runEmit(
  options: LiveReleaseDriftAlertOptions,
  assessment: DriftAssessment,
  eventType: 'alert' | 'clear',
  facts: ReleaseManifestFacts,
): ReleaseAlertEmitResult {
  return emitReleaseAlert({ ...options, eventId: randomUUID() }, {
    summary: alertSummary(assessment, facts),
    evidence: alertEvidence(assessment),
    diagnostics: [
      `release=${assessment.report.releasePath}`,
      `manifest=${assessment.report.manifestPath}`,
      ...typedDriftDiagnostics(assessment, facts),
    ],
    severity: 'critical',
  }, eventType);
}

const CONDITION_FINGERPRINT_DOMAIN = 'whatsoup-release-drift-condition-v1';
const CORRELATION_DIGEST_DOMAIN = 'whatsoup-release-drift-correlation-v1';

function domainDigest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}|${value}`).digest('hex');
}

function countIssueKinds(issues: readonly LiveReleaseDriftIssue[]): Record<string, number> {
  const issueKinds: Record<string, number> = {};
  for (const issue of issues) issueKinds[issue.kind] = (issueKinds[issue.kind] ?? 0) + 1;
  return issueKinds;
}

function buildLogRecord(input: {
  assessment: DriftAssessment;
  alertKind: 'alert' | 'clear' | null;
  emitResult: ReleaseAlertEmitResult | null;
  emitFailedOutcome: boolean;
  manifestFacts: ReleaseManifestFacts;
  now: () => Date;
}): LiveReleaseDriftLogRecord {
  const issueKinds = countIssueKinds(input.assessment.issues);
  const desired = input.manifestFacts.desiredDigest;
  // The observed tree identity is only attestable when verification passed.
  const observed = input.assessment.ok && desired !== 'unknown' ? desired : 'unknown';
  const kindSet = Object.keys(issueKinds).sort().join(',');
  const outcome: LiveReleaseDriftOutcome = input.emitFailedOutcome
    ? 'emit_failed'
    : input.assessment.ok ? 'passed' : 'drift';
  return {
    schemaVersion: 1,
    check: 'live-release-drift-alert',
    observedAt: input.now().toISOString(),
    invocationId: randomUUID(),
    ok: input.assessment.ok && (!input.emitResult || input.emitResult.status === 0),
    outcome,
    issueKinds,
    conditionFingerprint: domainDigest(CONDITION_FINGERPRINT_DOMAIN, `${kindSet}|${desired}`),
    desiredReleaseDigest: desired,
    observedReleaseDigest: observed,
    alert: {
      required: input.alertKind !== null,
      attempted: Boolean(input.emitResult),
      kind: input.alertKind,
      status: input.emitResult?.status ?? null,
    },
    correlationDigest: input.emitResult?.eventId && input.emitResult.status === 0
      ? domainDigest(CORRELATION_DIGEST_DOMAIN, input.emitResult.eventId)
      : null,
  };
}

export function checkLiveReleaseDrift(options: LiveReleaseDriftAlertOptions): LiveReleaseDriftAlertResult {
  const report = createReleaseSnapshotDriftReport(options.releasePath, options.manifestPath);
  // Fold the launchd findings in BEFORE deciding whether to alert. A release
  // that verifies against its own manifest while the plist points elsewhere is
  // the false pass this check exists to catch; treating it as ok would emit a
  // clear event under --clear-on-ok, which is worse than staying silent.
  const assessment = assess(report, options.launchdSelection);
  // Read the manifest once, before emitting, so the event and the log record
  // describe the same bytes even if the release changes underneath us.
  const manifestFacts = readManifestFacts(assessment.report.manifestPath);
  const alertKind: 'alert' | 'clear' | null = assessment.ok ? (options.clearOnOk ? 'clear' : null) : 'alert';
  let emitResult: ReleaseAlertEmitResult | null = null;
  if (alertKind && options.emit) {
    emitResult = runEmit(options, assessment, alertKind, manifestFacts);
  }
  const emitFailedOutcome = Boolean(emitResult && emitResult.status !== 0);
  const record = buildLogRecord({ assessment, alertKind, emitResult, emitFailedOutcome, manifestFacts, now: options.now ?? (() => new Date()) });
  const selection = options.launchdSelection;
  return {
    check: 'live-release-drift-alert',
    ok: assessment.ok && (!emitResult || emitResult.status === 0),
    releasePath: report.releasePath,
    manifestPath: report.manifestPath,
    source: report.source,
    issues: assessment.issues,
    launchd: selection
      ? {
          plistPath: selection.plistPath,
          label: selection.label,
          selector: selection.selector,
          selectorPath: selection.selectorPath,
          workingDirectory: selection.workingDirectory,
        }
      : null,
    record,
    alert: {
      required: alertKind !== null,
      attempted: Boolean(emitResult),
      kind: alertKind,
      status: emitResult?.status ?? null,
      stdout: emitResult?.stdout ?? '',
      stderr: emitResult?.stderr ?? '',
    },
  };
}

/** One job (or one `--release`) to check in this invocation. */
interface DriftTarget {
  releasePath?: string;
  launchdPlistPath?: string;
}

function toOptions(parsed: ParsedArgs, target: DriftTarget): LiveReleaseDriftAlertOptions {
  const launchdSelection = target.launchdPlistPath
    ? resolveLaunchdReleaseSelection(target.launchdPlistPath)
    : undefined;
  return {
    repoRoot: parsed.repoRoot,
    releasePath: target.releasePath ?? launchdSelection!.releasePath,
    manifestPath: parsed.manifestPath,
    instance: parsed.instance,
    source: parsed.source,
    emit: parsed.emit,
    emitHelper: parsed.emitHelper ? requireAbsolute('--emit-helper', parsed.emitHelper) : defaultEmitHelper(parsed.repoRoot),
    python: parsed.python,
    clearOnOk: parsed.clearOnOk,
    launchdSelection,
  };
}

function checkerFailedResult(): LiveReleaseDriftAlertResult {
  const record: LiveReleaseDriftLogRecord = {
    schemaVersion: 1,
    check: 'live-release-drift-alert',
    observedAt: new Date().toISOString(),
    invocationId: randomUUID(),
    ok: false,
    outcome: 'checker_failed',
    issueKinds: {},
    conditionFingerprint: domainDigest(CONDITION_FINGERPRINT_DOMAIN, 'checker_failed'),
    desiredReleaseDigest: 'unknown',
    observedReleaseDigest: 'unknown',
    alert: { required: false, attempted: false, kind: null, status: null },
    correlationDigest: null,
  };
  return {
    check: 'live-release-drift-alert',
    ok: false,
    releasePath: '',
    manifestPath: '',
    source: null,
    issues: [],
    launchd: null,
    record,
    alert: { ...record.alert, stdout: '', stderr: '' },
  };
}

function exitCodeFor(result: LiveReleaseDriftAlertResult): number {
  if (result.ok) return 0;
  return result.issues.length > 0 ? 1 : 2;
}

/**
 * Check every requested target and return one result each.
 *
 * A target that cannot be resolved fails closed on its own — it never aborts
 * the remaining jobs, and it never degrades to a pass. The invocation exits on
 * the WORST status across the set, so a healthy job cannot mask a bad one.
 */
export function run(argv: string[] = process.argv.slice(2)): LiveReleaseDriftAlertResult[] {
  const parsed = parseArgs(argv);
  const targets: DriftTarget[] = parsed.releasePath
    ? [{ releasePath: parsed.releasePath }]
    : parsed.launchdPlistPaths.map((launchdPlistPath) => ({ launchdPlistPath }));

  const results: LiveReleaseDriftAlertResult[] = [];
  let worst = 0;
  for (const target of targets) {
    let result: LiveReleaseDriftAlertResult;
    try {
      result = checkLiveReleaseDrift(toOptions(parsed, target));
    } catch (error) {
      // Checker failure (unresolvable job, unreadable/invalid manifest, bad
      // paths): still one structured record, no error-message leakage —
      // messages embed paths.
      void error;
      result = checkerFailedResult();
    }
    results.push(result);
    worst = Math.max(worst, exitCodeFor(result));
  }

  // Single-target output is unchanged: `--json` prints one result object, and a
  // checker failure prints its bare record line. Only the new multi-target form
  // prints an array (or one record line per job).
  const single = results.length === 1 ? results[0] : null;
  const singleJsonResult = single !== null && parsed.json && single.record.outcome !== 'checker_failed';
  if (singleJsonResult) console.log(JSON.stringify(single, null, 2));
  else if (single) console.log(JSON.stringify(single.record));
  else if (parsed.json) console.log(JSON.stringify(results, null, 2));
  else for (const result of results) console.log(JSON.stringify(result.record));

  if (worst !== 0) process.exitCode = worst;
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
