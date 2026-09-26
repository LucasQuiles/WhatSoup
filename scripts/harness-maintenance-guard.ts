import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  asNonEmptyString,
  isNonEmptyString,
  isRecord,
  requireNumber,
  requireRecord,
  requireString,
} from '../src/lib/type-guards.ts';

export const DEFAULT_COOLDOWN_MINUTES = 7 * 24 * 60;
export const DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS = 7;

export interface NpmVersionAge {
  version: string;
  publishedAt: string;
  ageMinutes: number;
  cooldownMinutes: number;
  eligible: boolean;
}

export interface LatestEligibleVersion {
  version: string | null;
  cooldownMinutes: number;
}

export interface FloatingReference {
  path: string;
  value: string;
}

export interface NpmCooldownConfigCheck {
  npmVersion: string;
  minVersion: string;
  expectedDays: string;
  npmrcValue: string | null;
  installExitCode: number;
  stderr: string;
  ok: boolean;
  reasons: string[];
}

export interface ManifestValidation {
  schemaVersion: number;
  cooldownMinutes: number;
  npmrcMinReleaseAgeDays: number;
  codexNodeNpmMinVersion: string;
  tier1Harnesses: string[];
  probes: string[];
  floatingReferences: FloatingReference[];
  allowedFloatingReferences: FloatingReference[];
  unexpectedFloatingReferences: FloatingReference[];
  warnings: string[];
}

type JsonRecord = Record<string, unknown>;

// Non-validating: only narrows to unknown[], element shape is checked by the
// caller. Left local (not requireArrayOfRecords/requireStringArray) because
// one call site (tier1[].smoke) discards the return value and just wants the
// array-shape assertion, not a typed element-by-element result.
function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

// Rejects whitespace-only in addition to empty — SSOT requireString only
// checks `.length === 0`. Every string field this guard validates (manifest
// paths/names/versions, CLI-arg file paths) is meaningless when
// whitespace-only, so this stays local rather than widening to the SSOT
// check (same pattern as disposable-client-canary-artifact.ts's
// requireNonNegativeNumber).
function requireTrimmedString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.trim() === '') {
    throw new Error(`${label} must be a string`);
  }
  return result;
}

function parseNpmrcMinReleaseAge(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const match = trimmed.match(/^min-release-age\s*=\s*(.+?)\s*$/);
    if (match) return match[1] ?? null;
  }
  return null;
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < max; i += 1) {
    const delta = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function walkForFloatingReferences(
  value: unknown,
  path: string,
  findings: FloatingReference[],
): void {
  if (typeof value === 'string') {
    if (/(^|[^a-z0-9_-])@latest\b/i.test(value) || /\blatest\b/i.test(value)) {
      findings.push({ path, value });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      walkForFloatingReferences(child, `${path}[${index}]`, findings),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkForFloatingReferences(child, path ? `${path}.${key}` : key, findings);
    }
  }
}

export function validateManifestPayload(payload: unknown): ManifestValidation {
  const root = requireRecord(payload, 'manifest');
  const schemaVersion = requireNumber(root.schema_version, 'schema_version');
  if (schemaVersion !== 1) {
    throw new Error(`schema_version must be 1, got ${schemaVersion}`);
  }

  const npm = requireRecord(root.npm, 'npm');
  const cooldownMinutes = requireNumber(npm.cooldown_minutes, 'npm.cooldown_minutes');
  if (cooldownMinutes < DEFAULT_COOLDOWN_MINUTES) {
    throw new Error(
      `npm.cooldown_minutes must be at least ${DEFAULT_COOLDOWN_MINUTES}`,
    );
  }
  const npmrcMinReleaseAgeDays = requireNumber(
    npm.npmrc_min_release_age_days,
    'npm.npmrc_min_release_age_days',
  );
  if (npmrcMinReleaseAgeDays < DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS) {
    throw new Error(
      `npm.npmrc_min_release_age_days must be at least ${DEFAULT_NPMRC_MIN_RELEASE_AGE_DAYS}`,
    );
  }
  const codexNode = requireRecord(npm.codex_node, 'npm.codex_node');
  requireTrimmedString(codexNode.node_bin, 'npm.codex_node.node_bin');
  const codexNodeNpmMinVersion = requireTrimmedString(
    codexNode.npm_min_version,
    'npm.codex_node.npm_min_version',
  );

  const tier1 = asArray(root.tier1, 'tier1');
  const tier1Harnesses = tier1.map((entry, index) => {
    const record = requireRecord(entry, `tier1[${index}]`);
    const name = requireTrimmedString(record.name, `tier1[${index}].name`);
    requireTrimmedString(record.kind, `tier1[${index}].kind`);
    asArray(record.smoke, `tier1[${index}].smoke`);
    return name;
  });
  for (const required of ['claude', 'codex', 'opencode']) {
    if (!tier1Harnesses.includes(required)) {
      throw new Error(`tier1 must include ${required}`);
    }
  }

  const tier2 = requireRecord(root.tier2, 'tier2');
  const probesPayload = asArray(tier2.probes, 'tier2.probes');
  const probes = probesPayload.map((entry, index) => {
    const record = requireRecord(entry, `tier2.probes[${index}]`);
    const name = requireTrimmedString(record.name, `tier2.probes[${index}].name`);
    requireTrimmedString(record.mode, `tier2.probes[${index}].mode`);
    return name;
  });

  const floatingReferences: FloatingReference[] = [];
  walkForFloatingReferences(payload, '', floatingReferences);

  // Paths matching ^tier1\[\d+\]\.(update|rollback) are intentional update/rollback
  // channels (e.g. "claude install latest") and are expected to contain floating refs.
  const allowedFloatingPattern = /^tier1\[\d+\]\.(update|rollback)(?:[.\[]|$)/;
  const allowedFloatingReferences: typeof floatingReferences = [];
  const unexpectedFloatingReferences: typeof floatingReferences = [];
  for (const ref of floatingReferences) {
    (allowedFloatingPattern.test(ref.path) ? allowedFloatingReferences : unexpectedFloatingReferences).push(ref);
  }

  const warnings: string[] = [];
  if (allowedFloatingReferences.length > 0) {
    warnings.push(
      `${allowedFloatingReferences.length} allowed floating latest reference(s) in tier1 update/rollback channels`,
    );
  }

  return {
    schemaVersion,
    cooldownMinutes,
    npmrcMinReleaseAgeDays,
    codexNodeNpmMinVersion,
    tier1Harnesses,
    probes,
    floatingReferences,
    allowedFloatingReferences,
    unexpectedFloatingReferences,
    warnings,
  };
}

export function validateManifestText(text: string): ManifestValidation {
  return validateManifestPayload(JSON.parse(text));
}

export function npmCooldownConfigCheck({
  npmVersion,
  minVersion,
  expectedDays,
  npmrcText,
  installExitCode,
  stderr,
}: {
  npmVersion: string;
  minVersion: string;
  expectedDays: string;
  npmrcText: string;
  installExitCode: number;
  stderr: string;
}): NpmCooldownConfigCheck {
  const npmrcValue = parseNpmrcMinReleaseAge(npmrcText);
  const reasons: string[] = [];
  if (compareVersion(npmVersion, minVersion) < 0) {
    reasons.push(`npm ${npmVersion} is below required ${minVersion}`);
  }
  if (/Unknown user config ["']min-release-age["']/i.test(stderr)) {
    reasons.push('npm does not recognize min-release-age');
  }
  if (npmrcValue !== expectedDays) {
    reasons.push(`npmrc min-release-age is ${npmrcValue ?? '(missing)'}, expected ${expectedDays}`);
  }
  if (installExitCode !== 0) {
    reasons.push('npm dry-run install failed with min-release-age enabled');
  }
  return {
    npmVersion,
    minVersion,
    expectedDays,
    npmrcValue,
    installExitCode,
    stderr,
    ok: reasons.length === 0,
    reasons,
  };
}

export function npmVersionAge(
  versionTimes: Record<string, string>,
  version: string,
  now: Date = new Date(),
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
): NpmVersionAge {
  const publishedAt = versionTimes[version];
  if (!publishedAt) throw new Error(`no npm publish time for ${version}`);
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) {
    throw new Error(`invalid npm publish time for ${version}: ${publishedAt}`);
  }
  const ageMinutes = Math.floor((now.getTime() - published.getTime()) / 60000);
  return {
    version,
    publishedAt,
    ageMinutes,
    cooldownMinutes,
    eligible: ageMinutes >= cooldownMinutes,
  };
}

export function latestEligibleVersion(
  versionTimes: Record<string, string>,
  now: Date = new Date(),
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
): LatestEligibleVersion {
  const versions = Object.entries(versionTimes)
    .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version))
    .map(([version, publishedAt]) => npmVersionAge(versionTimes, version, now, cooldownMinutes))
    .filter((entry) => entry.eligible)
    .sort((left, right) => compareVersion(left.version, right.version));
  return {
    version: versions.at(-1)?.version ?? null,
    cooldownMinutes,
  };
}

/**
 * A publish time this far ahead of the job clock is treated as a metadata or clock anomaly and
 * holds the update; smaller leads are ordinary clock skew between the registry and this host.
 */
export const PUBLISH_TIME_SKEW_MINUTES = 5;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const SEMVER_IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_RE = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-(${SEMVER_IDENT}(?:\\.${SEMVER_IDENT})*))?` +
    `(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

/**
 * Strict semver 2.0.0 parse. Returns null for anything looser (a leading "v", missing or extra
 * components, leading zeros), so a version the planner cannot order is never installed over.
 * compareVersion() above keeps its lenient contract for the npm-version callers.
 */
export function parseSemver(version: string): Semver | null {
  if (typeof version !== 'string' || version.length > 256) return null;
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return { major: major!, minor: minor!, patch: patch!, prerelease };
}

function compareParsedSemver(left: Semver, right: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  // A release ranks above any of its prereleases.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const max = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < max; i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a > b ? 1 : -1;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

/** Semver precedence of two strict versions; throws if either is not strict semver. */
export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`not a strict semver version: ${a ? right : left}`);
  return compareParsedSemver(a, b);
}

export type ClaudeServiceLayout = 'native' | 'wrapper' | 'npm' | 'other';

export interface ClaudeUpdatePlan {
  action: 'missing' | 'unknown' | 'held' | 'current' | 'unmanaged-layout' | 'install';
  current: string | null;
  target: string | null;
  cooldownMinutes: number;
  reason: string;
  anomalies?: string[];
}

interface EligibleTarget {
  target: string | null;
  anomalies: string[];
}

const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * A strict ISO 8601 timestamp with a real calendar date and time, or null. `new Date()` alone
 * accepts "2026" and "Sep 1 2026", rolls "2026-02-30" into March, and reads "T24:00" as the next
 * day; each component is therefore round-tripped through Date.UTC and must come back unchanged.
 */
export function parseStrictIsoTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const match = ISO_TIMESTAMP_RE.exec(raw);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const second = Number(match[6] ?? '0');
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
    || probe.getUTCHours() !== hour
    || probe.getUTCMinutes() !== minute
    || probe.getUTCSeconds() !== second
  ) {
    return null;
  }
  if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) return null;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

/**
 * Newest plain release (no prerelease/build) past the cooldown, validated per version. Unlike
 * latestEligibleVersion() this never throws on bad metadata: it reports an anomaly for a release
 * newer than the current one whose publish time is missing or invalid, and for any publish time
 * further in the future than PUBLISH_TIME_SKEW_MINUTES. Any anomaly holds the update.
 */
function eligibleClaudeTarget(
  versionTimes: unknown,
  current: Semver,
  now: Date,
  cooldownMinutes: number,
): EligibleTarget {
  if (!isRecord(versionTimes)) {
    return { target: null, anomalies: ['publish-time metadata is missing or not a JSON object'] };
  }
  const anomalies: string[] = [];
  let best: { version: string; parsed: Semver } | null = null;
  for (const [version, publishedAt] of Object.entries(versionTimes)) {
    // Keys that are not strict semver ("created", "modified", "v2.1.290", "2.1.290.1") are not
    // candidates and are ignored, not anomalies: the installer takes strict versions only.
    // Prereleases and build-metadata versions are never targets.
    const parsed = parseSemver(version);
    if (!parsed || parsed.prerelease.length > 0 || version.includes('+')) continue;
    const published = parseStrictIsoTimestamp(publishedAt);
    if (!published) {
      if (compareParsedSemver(parsed, current) > 0) {
        anomalies.push(`${version} has an invalid publish time`);
      }
      continue;
    }
    const ageMinutes = (now.getTime() - published.getTime()) / 60000;
    if (ageMinutes < -PUBLISH_TIME_SKEW_MINUTES) {
      anomalies.push(`${version} publish time is in the future`);
      continue;
    }
    if (ageMinutes < cooldownMinutes) continue;
    if (!best || compareParsedSemver(parsed, best.parsed) > 0) best = { version, parsed };
  }
  return { target: best?.version ?? null, anomalies };
}

/**
 * Decide the agent CLI update for the binary the bot service resolves. Order:
 * missing -> unknown -> held -> unmanaged-layout -> current -> install.
 * The target is the newest plain release past the publish-age cooldown (never a floating tag or
 * a prerelease); nothing is ever downgraded; a current version that is not strict semver never
 * installs; and the native installer only runs on its own symlink layout, because on a wrapper or
 * npm layout the installer can repoint ~/.local/bin past the wrapper.
 */
export function claudeUpdatePlan({
  current,
  versionTimes,
  now = new Date(),
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
  layout,
}: {
  current: string | null;
  versionTimes: unknown;
  now?: Date;
  cooldownMinutes?: number;
  layout: ClaudeServiceLayout;
}): ClaudeUpdatePlan {
  if (typeof cooldownMinutes !== 'number' || !Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
    throw new Error(`cooldownMinutes must be a finite non-negative number, got ${cooldownMinutes}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('now must be a valid Date');
  }
  const base = { current: current || null, cooldownMinutes };
  if (!current) {
    return { ...base, action: 'missing', target: null, reason: 'service agent CLI binary not found or not runnable' };
  }
  const parsedCurrent = parseSemver(current);
  if (!parsedCurrent) {
    return { ...base, action: 'unknown', target: null, reason: `current version is not strict semver: ${current}` };
  }
  const { target, anomalies } = eligibleClaudeTarget(versionTimes, parsedCurrent, now, cooldownMinutes);
  if (anomalies.length > 0) {
    return { ...base, action: 'held', target: null, reason: 'publish-time metadata anomaly', anomalies };
  }
  if (!target) {
    return { ...base, action: 'held', target: null, reason: 'no release is past the publish-age cooldown' };
  }
  if (layout !== 'native') {
    return {
      ...base,
      action: 'unmanaged-layout',
      target,
      reason: `service binary is a ${layout} layout; the native installer could overwrite it`,
    };
  }
  if (compareSemver(current, target) >= 0) {
    return { ...base, action: 'current', target, reason: `service version ${current} >= eligible ${target}` };
  }
  return { ...base, action: 'install', target, reason: `${current} -> ${target}` };
}

/** Error codes the agent CLI modes emit; exit 2 = the request was rejected, nothing was decided. */
export type ClaudeCliErrorCode = 'INVALID_ARGUMENT' | 'EVIDENCE_MISSING' | 'UNEXPECTED';

export interface ClaudeCliError {
  action: 'error';
  current: null;
  target: null;
  error: { code: ClaudeCliErrorCode; message: string };
}

export interface ClaudeCliOutcome {
  exitCode: 0 | 2;
  result: unknown;
}

class ClaudeCliRejection extends Error {
  code: ClaudeCliErrorCode;

  constructor(code: ClaudeCliErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Strict flag parser for the agent CLI modes: every flag is known, appears once, and takes a
 * value unless it is the mode flag or --json. Only flags in `emptyAllowed` accept "" (the shell
 * passes an empty --current when the service binary is missing).
 */
function parseClaudeCliArgs(
  argv: string[],
  modeFlag: string,
  valueFlags: readonly string[],
  emptyAllowed: readonly string[] = [],
): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  const reject = (message: string): never => {
    throw new ClaudeCliRejection('INVALID_ARGUMENT', message);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) reject(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (parsed.has(key)) reject(`--${key} given more than once`);
    if (key === modeFlag || key === 'json') {
      parsed.set(key, true);
      continue;
    }
    if (!valueFlags.includes(key)) reject(`unknown flag for --${modeFlag}: --${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) reject(`missing value for --${key}`);
    if (value === '' && !emptyAllowed.includes(key)) reject(`empty value for --${key}`);
    parsed.set(key, value!);
    i += 1;
  }
  return parsed;
}

function stringArg(args: Map<string, string | true>, key: string): string | undefined {
  const value = args.get(key);
  return typeof value === 'string' ? value : undefined;
}

function parseCliCooldown(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_COOLDOWN_MINUTES;
  const value = /^\d{1,12}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < DEFAULT_COOLDOWN_MINUTES) {
    throw new ClaudeCliRejection(
      'INVALID_ARGUMENT',
      `--cooldown-minutes must be an integer of at least ${DEFAULT_COOLDOWN_MINUTES}, got "${raw}"`,
    );
  }
  return value;
}

function parseCliNow(raw: string | undefined): Date {
  if (raw === undefined) return new Date();
  const value = parseStrictIsoTimestamp(raw);
  if (!value) {
    throw new ClaudeCliRejection('INVALID_ARGUMENT', `--now must be an ISO 8601 timestamp, got "${raw}"`);
  }
  return value;
}

function claudeCliError(err: unknown): ClaudeCliOutcome {
  const code = err instanceof ClaudeCliRejection ? err.code : 'UNEXPECTED';
  const message = err instanceof Error ? err.message : String(err);
  const result: ClaudeCliError = { action: 'error', current: null, target: null, error: { code, message } };
  return { exitCode: 2, result };
}

const CLAUDE_LAYOUTS: readonly ClaudeServiceLayout[] = ['native', 'wrapper', 'npm', 'other'];

/**
 * --claude-update-plan: exit 0 with the plan (any action), or exit 2 with action "error". An
 * empty, absent or "none" --current is the missing action. A publish-time file that cannot be
 * read is missing evidence; one that is not valid JSON is a metadata anomaly and holds.
 */
export function claudeUpdatePlanCli(argv: string[]): ClaudeCliOutcome {
  try {
    const args = parseClaudeCliArgs(
      argv,
      'claude-update-plan',
      ['current', 'time-json', 'cooldown-minutes', 'layout', 'now'],
      ['current'],
    );
    const timeJsonPath = stringArg(args, 'time-json');
    if (timeJsonPath === undefined) throw new ClaudeCliRejection('INVALID_ARGUMENT', '--time-json is required');
    const layout = stringArg(args, 'layout') ?? 'other';
    if (!(CLAUDE_LAYOUTS as readonly string[]).includes(layout)) {
      throw new ClaudeCliRejection('INVALID_ARGUMENT', '--layout must be native, wrapper, npm or other');
    }
    const cooldownMinutes = parseCliCooldown(stringArg(args, 'cooldown-minutes'));
    const now = parseCliNow(stringArg(args, 'now'));
    const currentArg = stringArg(args, 'current');
    const current = currentArg === undefined || currentArg === '' || currentArg === 'none' ? null : currentArg;
    let text: string;
    try {
      text = readFileSync(timeJsonPath, 'utf8');
    } catch (err) {
      throw new ClaudeCliRejection('EVIDENCE_MISSING', `cannot read --time-json: ${(err as Error).message}`);
    }
    let versionTimes: unknown;
    try {
      versionTimes = JSON.parse(text);
    } catch {
      versionTimes = undefined;
    }
    const result = claudeUpdatePlan({
      current,
      versionTimes,
      now,
      cooldownMinutes,
      layout: layout as ClaudeServiceLayout,
    });
    return { exitCode: 0, result };
  } catch (err) {
    return claudeCliError(err);
  }
}

export type ClaudeExecutableKind =
  | 'missing'
  | 'broken-link'
  | 'link-loop'
  | 'untrusted'
  | 'not-executable'
  | 'native'
  | 'npm'
  | 'wrapper'
  | 'wrapper-unresolved'
  | 'other';

/**
 * Static classification of the service binary. `configuredVersion` comes from the native version
 * path or the npm package.json and is what the layout is configured to run; it is never an
 * observed runtime version, so `observedVersion` is always null here.
 */
export interface ClaudeExecutableClassification {
  kind: ClaudeExecutableKind;
  layout: ClaudeServiceLayout;
  bin: string;
  chain: string[];
  resolved: string | null;
  configuredVersion: string | null;
  configuredVersionSource: 'native-path' | 'package-json' | null;
  observedVersion: null;
  wrapperTarget?: string;
  target?: ClaudeExecutableClassification;
  reasons: string[];
}

export const CLAUDE_RESOLVE_MAX_HOPS = 32;
const CLAUDE_NPM_PACKAGE = '@anthropic-ai/claude-code';
const WRAPPER_MAX_BYTES = 64 * 1024;
const PACKAGE_WALK_MAX_LEVELS = 6;
const NATIVE_MAGIC = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O 64-bit
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // Mach-O 32-bit
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O universal
];
const WRAPPER_SHEBANG_RE = /^#!\s*(?:\/bin\/sh|\/bin\/bash|\/usr\/bin\/bash|\/usr\/bin\/env\s+(?:ba)?sh)\s*$/;
const WRAPPER_EXEC_RE = /^exec\s+("?)(\/[A-Za-z0-9._\/+@-]+)\1(?:\s+"\$@")?$/;

const LAYOUT_BY_KIND: Record<ClaudeExecutableKind, ClaudeServiceLayout> = {
  missing: 'other',
  'broken-link': 'other',
  'link-loop': 'other',
  untrusted: 'other',
  'not-executable': 'other',
  native: 'native',
  npm: 'npm',
  wrapper: 'wrapper',
  'wrapper-unresolved': 'wrapper',
  other: 'other',
};

function errnoCode(err: unknown): string | undefined {
  return isRecord(err) ? asNonEmptyString(err.code) : undefined;
}

/** Reads at most `limit` bytes of a regular file; O_NONBLOCK keeps a swapped-in FIFO from hanging. */
function readHead(file: string, limit: number): Buffer {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit);
    const bytes = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Owner must be trusted, and neither the entry nor its directory may be world-writable (sticky dirs excepted). */
function untrustedReason(entry: string, trustedUids: readonly number[]): string | null {
  const own = lstatSync(entry);
  if (!trustedUids.includes(own.uid)) return `${entry} is owned by untrusted uid ${own.uid}`;
  if (!own.isSymbolicLink() && (own.mode & 0o002) !== 0) return `${entry} is world-writable`;
  const dir = statSync(path.dirname(entry));
  if (!trustedUids.includes(dir.uid)) return `${path.dirname(entry)} is owned by untrusted uid ${dir.uid}`;
  if ((dir.mode & 0o002) !== 0 && (dir.mode & 0o1000) === 0) {
    return `${path.dirname(entry)} is world-writable without the sticky bit`;
  }
  return null;
}

/** package.json of the package that owns `file`; the walk stops at a node_modules boundary. */
function owningPackage(file: string): { name: unknown; version: unknown } | null {
  let dir = path.dirname(file);
  for (let level = 0; level < PACKAGE_WALK_MAX_LEVELS; level += 1) {
    if (path.basename(dir) === 'node_modules') return null;
    const manifest = path.join(dir, 'package.json');
    let text: string | null = null;
    try {
      if (statSync(manifest).isFile()) text = readFileSync(manifest, 'utf8');
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTDIR') throw err;
    }
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? { name: parsed.name, version: parsed.version } : { name: null, version: null };
      } catch {
        return { name: null, version: null };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function nativeVersionsDir(home: string): string | null {
  try {
    return realpathSync(path.join(home, '.local', 'share', 'claude', 'versions'));
  } catch {
    return null;
  }
}

/**
 * Classify the executable at `bin` without executing anything: follow the link chain (relative
 * targets resolve against the real directory holding the link; loops and chains longer than
 * maxHops are link-loop), then check trust, the executable bit, the native versions path (which
 * must hold an ELF or Mach-O file), an owning npm package.json (before any shebang test), and
 * finally a wrapper script whose only command is `exec /abs/path "$@"`.
 */
export function classifyClaudeExecutable({
  bin,
  home,
  maxHops = CLAUDE_RESOLVE_MAX_HOPS,
  trustedUids = [process.getuid?.() ?? 0, 0],
  allowWrapper = true,
}: {
  bin: string;
  home: string;
  maxHops?: number;
  trustedUids?: readonly number[];
  allowWrapper?: boolean;
}): ClaudeExecutableClassification {
  const chain: string[] = [bin];
  const reasons: string[] = [];
  const done = (
    kind: ClaudeExecutableKind,
    extra: Partial<ClaudeExecutableClassification> = {},
  ): ClaudeExecutableClassification => ({
    kind,
    layout: LAYOUT_BY_KIND[kind],
    bin,
    chain,
    resolved: null,
    configuredVersion: null,
    configuredVersionSource: null,
    observedVersion: null,
    reasons,
    ...extra,
  });

  let current = bin;
  const seen = new Set<string>();
  for (;;) {
    let info: Stats;
    try {
      info = lstatSync(current);
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      reasons.push(`${current} does not exist`);
      return done(chain.length === 1 ? 'missing' : 'broken-link');
    }
    if (!info.isSymbolicLink()) break;
    const trust = untrustedReason(current, trustedUids);
    if (trust) {
      reasons.push(trust);
      return done('untrusted');
    }
    const linkTarget = readlinkSync(current);
    const next = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(realpathSync(path.dirname(current)), linkTarget);
    if (seen.has(next) || chain.length > maxHops) {
      reasons.push(seen.has(next) ? `link cycle at ${next}` : `more than ${maxHops} link hops`);
      return done('link-loop');
    }
    seen.add(current);
    chain.push(next);
    current = next;
  }

  const resolved = realpathSync(current);
  const stat = statSync(resolved);
  if (!stat.isFile()) {
    reasons.push(`${resolved} is not a regular file`);
    return done('other', { resolved });
  }
  const trust = untrustedReason(resolved, trustedUids);
  if (trust) {
    reasons.push(trust);
    return done('untrusted', { resolved });
  }
  if ((stat.mode & 0o111) === 0) {
    reasons.push(`${resolved} is not executable`);
    return done('not-executable', { resolved });
  }

  const head = readHead(resolved, WRAPPER_MAX_BYTES + 1);
  const versionsDir = nativeVersionsDir(home);
  if (versionsDir !== null && path.dirname(resolved) === versionsDir) {
    const name = path.basename(resolved);
    if (parseSemver(name) && NATIVE_MAGIC.some((magic) => head.subarray(0, 4).equals(magic))) {
      return done('native', { resolved, configuredVersion: name, configuredVersionSource: 'native-path' });
    }
    reasons.push(`${resolved} is in the native versions directory but is not a native executable`);
    return done('other', { resolved });
  }

  const pkg = owningPackage(resolved);
  if (pkg && pkg.name === CLAUDE_NPM_PACKAGE) {
    const version = isNonEmptyString(pkg.version) && parseSemver(pkg.version) ? pkg.version : null;
    if (version === null) reasons.push('npm package.json has no strict semver version');
    return done('npm', {
      resolved,
      configuredVersion: version,
      configuredVersionSource: version === null ? null : 'package-json',
    });
  }

  if (head.subarray(0, 2).toString('latin1') !== '#!') {
    reasons.push(`${resolved} is neither a native, npm nor script layout`);
    return done('other', { resolved });
  }
  if (!allowWrapper) {
    reasons.push('wrapper target is itself a script');
    return done('wrapper-unresolved', { resolved });
  }
  if (head.length > WRAPPER_MAX_BYTES) {
    reasons.push('wrapper script is too large to inspect');
    return done('wrapper-unresolved', { resolved });
  }
  const lines = head.toString('utf8').split(/\r?\n/);
  const commands = lines.slice(1).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const exec = commands.length === 1 ? WRAPPER_EXEC_RE.exec(commands[0]!) : null;
  if (!WRAPPER_SHEBANG_RE.test(lines[0] ?? '') || !exec) {
    reasons.push('wrapper is not a single `exec /abs/path "$@"` script');
    return done('wrapper-unresolved', { resolved });
  }
  const wrapperTarget = exec[2]!;
  const target = classifyClaudeExecutable({
    bin: wrapperTarget,
    home,
    maxHops: Math.max(0, maxHops - chain.length),
    trustedUids,
    allowWrapper: false,
  });
  return done('wrapper', { resolved, wrapperTarget, target });
}

/** --claude-resolve: exit 0 with the classification, or exit 2 with action "error". */
export function claudeResolveCli(argv: string[]): ClaudeCliOutcome {
  try {
    const args = parseClaudeCliArgs(argv, 'claude-resolve', ['bin', 'home']);
    const bin = stringArg(args, 'bin');
    const home = stringArg(args, 'home');
    if (bin === undefined || !path.isAbsolute(bin)) {
      throw new ClaudeCliRejection('INVALID_ARGUMENT', '--bin must be an absolute path');
    }
    if (home === undefined || !path.isAbsolute(home)) {
      throw new ClaudeCliRejection('INVALID_ARGUMENT', '--home must be an absolute path');
    }
    return { exitCode: 0, result: classifyClaudeExecutable({ bin, home }) };
  } catch (err) {
    return claudeCliError(err);
  }
}

function emitClaudeCliOutcome(outcome: ClaudeCliOutcome): unknown {
  console.log(JSON.stringify(outcome.result));
  if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
  return outcome.result;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'json' || key === 'npm-cooldown-config' || key === 'latest-eligible-version' || key === 'claude-update-plan') {
      parsed[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    parsed[key] = value;
    i += 1;
  }
  return parsed;
}

export function run(argv: string[] = process.argv.slice(2)): unknown {
  if (argv.includes('--claude-update-plan')) return emitClaudeCliOutcome(claudeUpdatePlanCli(argv));
  if (argv.includes('--claude-resolve')) return emitClaudeCliOutcome(claudeResolveCli(argv));
  const args = parseArgs(argv);
  if (args['npm-cooldown-config']) {
    const npmVersion = requireTrimmedString(args['npm-version'], '--npm-version');
    const minVersion = requireTrimmedString(args['min-version'], '--min-version');
    const expectedDays = requireTrimmedString(args['expected-days'], '--expected-days');
    const npmrcPath = requireTrimmedString(args['npmrc-file'], '--npmrc-file');
    const stderrPath = requireTrimmedString(args['stderr-file'], '--stderr-file');
    const installExitCode = Number(args['install-exit-code']);
    if (!Number.isInteger(installExitCode) || installExitCode < 0) {
      throw new Error('--install-exit-code must be a non-negative integer');
    }
    const result = npmCooldownConfigCheck({
      npmVersion,
      minVersion,
      expectedDays,
      npmrcText: readFileSync(npmrcPath, 'utf8'),
      installExitCode,
      stderr: readFileSync(stderrPath, 'utf8'),
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.ok ? 'codex npm cooldown config ok' : result.reasons.join('; '));
    }
    if (!result.ok) process.exitCode = 2;
    return result;
  }

  if (args['version-eligible']) {
    const version = String(args['version-eligible']);
    const timeJsonPath = requireTrimmedString(args['time-json'], '--time-json');
    const cooldownMinutes = args['cooldown-minutes']
      ? Number(args['cooldown-minutes'])
      : DEFAULT_COOLDOWN_MINUTES;
    const now = args.now ? new Date(String(args.now)) : new Date();
    const result = npmVersionAge(
      JSON.parse(readFileSync(timeJsonPath, 'utf8')) as Record<string, string>,
      version,
      now,
      cooldownMinutes,
    );
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${version} eligible=${result.eligible}`);
    if (!result.eligible) process.exitCode = 2;
    return result;
  }

  if (args['latest-eligible-version']) {
    const timeJsonPath = requireTrimmedString(args['time-json'], '--time-json');
    const cooldownMinutes = args['cooldown-minutes']
      ? Number(args['cooldown-minutes'])
      : DEFAULT_COOLDOWN_MINUTES;
    const now = args.now ? new Date(String(args.now)) : new Date();
    const result = latestEligibleVersion(
      JSON.parse(readFileSync(timeJsonPath, 'utf8')) as Record<string, string>,
      now,
      cooldownMinutes,
    );
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.version ?? '');
    if (!result.version) process.exitCode = 2;
    return result;
  }

  const manifestPath = String(args.manifest ?? 'deploy/managed-components.json');
  const result = validateManifestText(readFileSync(manifestPath, 'utf8'));
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `harness-maintenance manifest ok: tier1=${result.tier1Harnesses.join(',')} probes=${result.probes.join(',')}`,
    );
    for (const warning of result.warnings) console.warn(warning);
    for (const ref of result.unexpectedFloatingReferences) {
      console.error(`unexpected floating latest reference at ${ref.path}: ${ref.value}`);
    }
  }
  if (result.unexpectedFloatingReferences.length > 0) process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
