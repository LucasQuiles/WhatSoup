import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const QUALIFICATION_BUNDLE_MANIFEST_FILE = 'qualification-bundle.json';
export const QUALIFICATION_BUNDLE_EXECUTION_ROOT = 'deployment-qualification';

const QUALIFIER_SOURCE = 'deploy/scripts/qualify-health-deployment.py';
const SOURCE_TEST_PROFILE_SOURCE = 'docs/operations/runtime-test-qualification.json';
const DEPLOYMENT_PROFILE_SOURCES = [
  'deploy/scripts/health-deployment-qualification-profile.json',
  'deploy/scripts/deployment-qualification-profile.json',
] as const;
const DEPLOYMENT_POLICY_VERSION = 'whatsoup.deployment-qualification-profile.v1';
const HEALTH_PROFILE_SCHEMA_VERSION = 'health.deployment-qualification-profile.v1';

export interface DeploymentQualificationExportBinding {
  /** The exact WhatSoup source commit this binding intends to qualify. */
  sourceCommit: string;
  /** Full immutable ARC revision compatible with the source commit. */
  arcCommit: string;
  /** Full immutable qFleet revision compatible with the source commit. */
  qfleetCommit: string;
  /** The policy version consumed by the bundled qualifier. */
  policyVersion: string;
  /** Source path for the deployment qualifier. */
  qualifier: string;
  /** Source path for the declared source-test profile. */
  sourceTestProfile: string;
  /** The two deployment profile source paths required by the qualifier. */
  deploymentProfiles: readonly string[];
  /** Every direct `lib` helper imported by the deployment qualifier. */
  healthHelpers: readonly string[];
}

export interface QualificationBundleReleaseFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface DeploymentQualificationBundleReport {
  schemaVersion: 'whatsoup.qualification-bundle.v1';
  sourceCommit: string;
  arcCommit: string;
  qfleetCommit: string;
  policyVersion: string;
  executionRoot: string;
  qualifier: string;
  manifestPath: string;
  manifestSha256: string;
  fileCount: number;
}

export interface StagedDeploymentQualificationBundle {
  report: Omit<DeploymentQualificationBundleReport, 'manifestPath' | 'executionRoot'> & {
    manifestRelativePath: string;
    executionRootRelativePath: string;
  };
  releaseFiles: QualificationBundleReleaseFile[];
}

interface BundleFile {
  path: string;
  sha256: string;
  executable: boolean;
}

interface BundleSourceFile {
  sourcePath: string;
  executionPath: string;
  executable: boolean;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function qualificationError(message: string): Error {
  return new Error(`qualification bundle export refused: ${message}`);
}

function requireRelativePath(label: string, value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\')) {
    throw qualificationError(`${label} must be a nonempty POSIX relative path`);
  }
  const parsed = path.posix.normalize(value);
  if (value.startsWith('/') || parsed !== value || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw qualificationError(`${label} must be a contained POSIX relative path`);
  }
  return parsed;
}

function requireCommit(label: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw qualificationError(`${label} must be a full 40-hex commit id`);
  }
  return value;
}

function requirePolicyVersion(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 160
    || [...value].some((character) => character < '!' || character > '~')
  ) {
    throw qualificationError('policyVersion must be a nonempty printable ASCII identifier');
  }
  return value;
}

function requireStringList(label: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw qualificationError(`${label} must be a list`);
  const paths = value.map((item, index) => requireRelativePath(`${label}[${index}]`, item));
  if (new Set(paths).size !== paths.length) throw qualificationError(`${label} must not repeat paths`);
  return paths;
}

function samePathSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

function readRegularSourceFile(sourceRoot: string, sourcePath: string): Buffer {
  const absolute = path.resolve(sourceRoot, sourcePath);
  const relative = path.relative(sourceRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw qualificationError(`source path escapes the staged commit: ${sourcePath}`);
  }
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch {
    throw qualificationError(`declared source file is missing from the exact commit: ${sourcePath}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw qualificationError(`declared source file must be a single-link regular file: ${sourcePath}`);
  }
  return readFileSync(absolute);
}

function importedHealthHelperPaths(qualifierBytes: Buffer): string[] {
  const qualifier = qualifierBytes.toString('utf8');
  const matches = [...qualifier.matchAll(/^[ \t]*from[ \t]+lib[ \t]+import[ \t]+([^#\r\n]+)/gm)];
  const modules = matches.flatMap((match) => match[1].split(',').map((value) => value.trim()));
  if (!modules.length || modules.some((module) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(module))) {
    throw qualificationError('qualifier must declare its direct lib helper imports in the supported form');
  }
  const paths = modules.map((module) => `deploy/scripts/lib/${module}.py`).sort();
  if (new Set(paths).size !== paths.length) {
    throw qualificationError('qualifier repeats a direct lib helper import');
  }
  return paths;
}

function parseProfile(label: string, body: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw qualificationError(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw qualificationError(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requireProfileString(profile: Record<string, unknown>, label: string, key: string, expected: string): void {
  if (profile[key] !== expected) throw qualificationError(`${label}.${key} is incompatible`);
}

function validateSourceTestProfile(body: Buffer): void {
  const profile = parseProfile('source-test profile', body);
  if (profile['schema_version'] !== 1 || !Array.isArray(profile['commands']) || profile['commands'].length === 0) {
    throw qualificationError('source-test profile must declare its v1 command set');
  }
  const ids = new Set<string>();
  for (const command of profile['commands']) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw qualificationError('source-test profile command must be an object');
    }
    const record = command as Record<string, unknown>;
    const id = record['id'];
    const argv = record['argv'];
    const timeout = record['timeout'];
    const criteria = record['criteria'];
    if (
      typeof id !== 'string'
      || !id
      || ids.has(id)
      || !Array.isArray(argv)
      || argv.length === 0
      || argv.some((value) => typeof value !== 'string' || !value)
      || typeof timeout !== 'number'
      || !Number.isFinite(timeout)
      || timeout <= 0
      || !Array.isArray(criteria)
      || criteria.length === 0
      || criteria.some((value) => typeof value !== 'string' || !value)
    ) {
      throw qualificationError('source-test profile command is incomplete');
    }
    ids.add(id);
  }
}

function validateDeploymentProfiles(sourceRoot: string, sourceTestProfile: string, deploymentProfiles: readonly string[], policyVersion: string): void {
  if (policyVersion !== DEPLOYMENT_POLICY_VERSION) {
    throw qualificationError('binding.policyVersion is not supported by the maintained deployment qualifier');
  }
  validateSourceTestProfile(readRegularSourceFile(sourceRoot, sourceTestProfile));

  const byPath = new Map(deploymentProfiles.map((profile) => [profile, readRegularSourceFile(sourceRoot, profile)]));
  const health = parseProfile('health deployment profile', byPath.get(DEPLOYMENT_PROFILE_SOURCES[0]) as Buffer);
  requireProfileString(health, 'health deployment profile', 'schema_version', HEALTH_PROFILE_SCHEMA_VERSION);
  requireProfileString(health, 'health deployment profile', 'profile_kind', 'deployment');
  const timeout = health['timeout_seconds'];
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0.01 || timeout > 60) {
    throw qualificationError('health deployment profile.timeout_seconds is incompatible');
  }

  const deployment = parseProfile('deployment qualification profile', byPath.get(DEPLOYMENT_PROFILE_SOURCES[1]) as Buffer);
  requireProfileString(deployment, 'deployment qualification profile', 'schema_version', policyVersion);
  requireProfileString(deployment, 'deployment qualification profile', 'profile_kind', 'deployment_qualification');
}

function validateBinding(
  binding: DeploymentQualificationExportBinding,
  sourceCommit: string,
  sourceRoot: string,
): BundleSourceFile[] {
  if (!binding || typeof binding !== 'object') throw qualificationError('binding must be an object');
  if (requireCommit('binding.sourceCommit', binding.sourceCommit) !== sourceCommit) {
    throw qualificationError('binding.sourceCommit must equal the exported commit');
  }
  requireCommit('binding.arcCommit', binding.arcCommit);
  requireCommit('binding.qfleetCommit', binding.qfleetCommit);
  requirePolicyVersion(binding.policyVersion);

  const qualifier = requireRelativePath('binding.qualifier', binding.qualifier);
  const sourceTestProfile = requireRelativePath('binding.sourceTestProfile', binding.sourceTestProfile);
  const deploymentProfiles = requireStringList('binding.deploymentProfiles', binding.deploymentProfiles);
  const healthHelpers = requireStringList('binding.healthHelpers', binding.healthHelpers);
  if (qualifier !== QUALIFIER_SOURCE || sourceTestProfile !== SOURCE_TEST_PROFILE_SOURCE) {
    throw qualificationError('binding must name the maintained qualifier and source-test profile');
  }
  if (!samePathSet(deploymentProfiles, DEPLOYMENT_PROFILE_SOURCES)) {
    throw qualificationError('binding must name both maintained deployment profiles');
  }
  validateDeploymentProfiles(sourceRoot, sourceTestProfile, deploymentProfiles, binding.policyVersion);

  const qualifierBytes = readRegularSourceFile(sourceRoot, qualifier);
  const expectedHelpers = importedHealthHelperPaths(qualifierBytes);
  if (!samePathSet(healthHelpers, expectedHelpers)) {
    throw qualificationError('binding.healthHelpers must exactly cover the qualifier imports');
  }

  const sources: BundleSourceFile[] = [
    { sourcePath: qualifier, executionPath: path.posix.basename(qualifier), executable: true },
    { sourcePath: sourceTestProfile, executionPath: path.posix.basename(sourceTestProfile), executable: false },
    ...deploymentProfiles.map((sourcePath) => ({
      sourcePath,
      executionPath: path.posix.basename(sourcePath),
      executable: false,
    })),
    ...healthHelpers.map((sourcePath) => ({
      sourcePath,
      executionPath: `lib/${path.posix.basename(sourcePath)}`,
      executable: false,
    })),
  ];
  const destinations = sources.map((source) => source.executionPath);
  if (new Set(destinations).size !== destinations.length) {
    throw qualificationError('binding maps multiple source files to one execution path');
  }
  return sources.sort((left, right) => left.executionPath.localeCompare(right.executionPath));
}

/**
 * Materialize a verifier-compatible closure from already staged exact-commit
 * bytes. The release exporter owns publication and its standard self-check;
 * this helper only adds the immutable bundle files to its staging directory.
 */
export function stageDeploymentQualificationBundle(options: {
  sourceRoot: string;
  stagingReleaseRoot: string;
  sourceCommit: string;
  binding: DeploymentQualificationExportBinding;
}): StagedDeploymentQualificationBundle {
  const sourceRoot = path.resolve(options.sourceRoot);
  const stagingReleaseRoot = path.resolve(options.stagingReleaseRoot);
  const sourceCommit = requireCommit('sourceCommit', options.sourceCommit);
  const sources = validateBinding(options.binding, sourceCommit, sourceRoot);
  const executionRoot = path.join(stagingReleaseRoot, QUALIFICATION_BUNDLE_EXECUTION_ROOT);
  const manifestPath = path.join(stagingReleaseRoot, QUALIFICATION_BUNDLE_MANIFEST_FILE);
  if (existsSync(executionRoot) || existsSync(manifestPath)) {
    throw qualificationError('generated bundle paths collide with exact-commit release content');
  }

  mkdirSync(executionRoot, { recursive: true, mode: 0o700 });
  chmodSync(executionRoot, 0o700);
  const files: BundleFile[] = [];
  const releaseFiles: QualificationBundleReleaseFile[] = [];
  for (const source of sources) {
    const body = readRegularSourceFile(sourceRoot, source.sourcePath);
    const destination = path.join(executionRoot, source.executionPath);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, body, { mode: source.executable ? 0o700 : 0o600 });
    chmodSync(destination, source.executable ? 0o700 : 0o600);
    const digest = sha256(body);
    files.push({ path: source.executionPath, sha256: digest, executable: source.executable });
    releaseFiles.push({
      path: `${QUALIFICATION_BUNDLE_EXECUTION_ROOT}/${source.executionPath}`,
      sha256: digest,
      sizeBytes: body.byteLength,
    });
  }

  const manifestBody = `${JSON.stringify({
    schema_version: 'whatsoup.qualification-bundle.v1',
    source_commit: sourceCommit,
    compatibility: {
      arc_commit: options.binding.arcCommit,
      qfleet_commit: options.binding.qfleetCommit,
    },
    policy_version: options.binding.policyVersion,
    execution_root: QUALIFICATION_BUNDLE_EXECUTION_ROOT,
    qualifier: path.posix.basename(options.binding.qualifier),
    files,
  }, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBody, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  releaseFiles.push({
    path: QUALIFICATION_BUNDLE_MANIFEST_FILE,
    sha256: sha256(manifestBody),
    sizeBytes: Buffer.byteLength(manifestBody),
  });
  releaseFiles.sort((left, right) => left.path.localeCompare(right.path));

  return {
    report: {
      schemaVersion: 'whatsoup.qualification-bundle.v1',
      sourceCommit,
      arcCommit: options.binding.arcCommit,
      qfleetCommit: options.binding.qfleetCommit,
      policyVersion: options.binding.policyVersion,
      executionRootRelativePath: QUALIFICATION_BUNDLE_EXECUTION_ROOT,
      qualifier: path.posix.basename(options.binding.qualifier),
      manifestRelativePath: QUALIFICATION_BUNDLE_MANIFEST_FILE,
      manifestSha256: sha256(manifestBody),
      fileCount: files.length,
    },
    releaseFiles,
  };
}
