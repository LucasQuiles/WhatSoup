import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isRecord, requireNumber, requireRecord, requireString } from '../src/lib/type-guards.ts';

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

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'json' || key === 'npm-cooldown-config' || key === 'latest-eligible-version') {
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
