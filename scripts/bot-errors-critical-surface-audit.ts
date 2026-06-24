import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../src/lib/type-guards.ts';

type FileKind = 'missing' | 'regular' | 'directory' | 'symlink' | 'other';
type ExpectedKind = 'file' | 'directory';

export type CriticalSurfaceIssueKind =
  | 'invalid-manifest'
  | 'remote-error'
  | 'runtime-missing'
  | 'runtime-kind'
  | 'runtime-sha256-drift'
  | 'runtime-marker-drift'
  | 'credential-missing'
  | 'credential-parent-unsafe'
  | 'credential-kind'
  | 'credential-unreadable'
  | 'credential-mode-too-open'
  | 'credential-empty'
  | 'critical-path-missing'
  | 'critical-path-kind'
  | 'critical-path-owner-access-missing'
  | 'critical-path-mode-too-open'
  | 'critical-path-sensitive-content'
  | 'critical-path-sensitive-scan-failed';

export interface RuntimeManifestEntry {
  path: string;
  sha256: string;
  mustContain: string[];
}

export interface RuntimeManifest {
  schemaVersion: 1;
  files: RuntimeManifestEntry[];
}

export interface HealthProfile {
  requiredCredentialFiles: string[];
  expectDispatcher: boolean;
  expectQLoop: boolean;
  expectFleetApi: boolean;
  fleetApiTokenFile?: string;
  expectConfigInventory: boolean;
  expectPrimaryPhoneVerification: boolean;
  instances: HealthProfileInstance[];
}

export interface HealthProfileInstance {
  name: string;
  expected: string;
}

export interface RuntimeFileObservation {
  path: string;
  exists: boolean;
  kind: FileKind;
  sha256?: string;
  mode?: number;
  missingMarkers?: string[];
  error?: string;
}

export interface CredentialObservation {
  requirement: string;
  expected: string;
  required: boolean;
  source: 'required' | 'profile-derived' | 'discovered';
  path?: string;
  exists: boolean;
  kind: FileKind;
  mode?: number;
  size?: number;
  readable?: boolean;
  parentIssues: ParentPathIssue[];
  error?: string;
}

export interface ParentPathIssue {
  path: string;
  kind: 'missing' | 'symlink' | 'not-directory' | 'owner-access-missing' | 'mode-too-open' | 'stat-failed';
  mode?: number;
  error?: string;
}

export interface CriticalPathObservation {
  label: string;
  path: string;
  required: boolean;
  expectedKind: ExpectedKind;
  exists: boolean;
  kind: FileKind;
  mode?: number;
  sensitiveContentKinds?: string[];
  sensitiveScanError?: string;
  error?: string;
}

export interface CriticalSurfaceObservations {
  runtime: RuntimeFileObservation[];
  credentials: CredentialObservation[];
  criticalPaths: CriticalPathObservation[];
}

export interface CriticalSurfaceIssue {
  kind: CriticalSurfaceIssueKind;
  severity: 'error';
  surface: 'runtime' | 'credential' | 'critical-path' | 'remote';
  path?: string;
  label?: string;
  requirement?: string;
  expected?: string;
  actual?: string;
  message: string;
}

interface AuditOptions {
  cwd: string;
  manifestPath: string;
  profilePath?: string;
  remote?: string;
  repoRoot?: string;
  home?: string;
  json: boolean;
}

const rootCredentialFiles = new Set([
  'bot-errors.env',
  'fleet-token',
  'fleet.env',
  'fleet-tokens.json',
  'secrets.env',
]);

const credentialLikeBasenames = new Set([
  ...rootCredentialFiles,
  'config.json',
  'tokens.env',
]);

const maxSensitiveScanBytes = 1024 * 1024;
const sensitiveContentPatterns: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'authorization-bearer', pattern: /\bAuthorization:\s*Bearer\s+(?!\[REDACTED\])[\w._~+/=-]{6,}/i },
  { kind: 'bearer-token', pattern: /\bBearer\s+(?!\[REDACTED\])[\w._~+/=-]{6,}/i },
  { kind: 'keyed-secret', pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|credential)\b\s*[:=]\s*["']?(?!\[REDACTED\]|redacted\b|<redacted>)[^\s"',}]{6,}/i },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  {
    kind: 'credential-path',
    pattern: /(?:\.config\/(?:secrets|whatsoup)\/[^\s"',;}]+|\.local\/share\/whatsoup\/instances\/[^\s"',;}]+\/auth(?:\/[^\s"',;}]+)?|auth-bond-backups\/[^\s"',;}]+|\/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env|\.env(?:\.[^\s"',;}]+)?))\b/i,
  },
];

interface SensitiveContentScan {
  kinds: string[];
  error?: string;
}

function normalizeMarkers(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) {
    throw new Error('mustContain/requiredText must be a string or string array');
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error('mustContain/requiredText entries must be non-empty strings');
    }
    return item;
  });
}

export function parseRuntimeManifest(payload: unknown): RuntimeManifest {
  if (!isRecord(payload)) {
    throw new Error('runtime manifest must be an object');
  }
  if (payload['schemaVersion'] !== 1) {
    throw new Error(`unsupported runtime manifest schemaVersion=${String(payload['schemaVersion'])}`);
  }
  const files = payload['files'];
  if (!Array.isArray(files)) {
    throw new Error('runtime manifest files must be a list');
  }
  const entries: RuntimeManifestEntry[] = [];
  const seen = new Set<string>();
  files.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`runtime manifest entry[${index}] must be an object`);
    }
    const filePath = item['path'];
    const sha256 = item['sha256'];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error(`runtime manifest entry[${index}] missing path`);
    }
    if (path.isAbsolute(filePath) || filePath.includes('\0')) {
      throw new Error(`runtime manifest entry[${index}] path must be repo-relative`);
    }
    if (seen.has(filePath)) {
      throw new Error(`runtime manifest duplicate path ${filePath}`);
    }
    seen.add(filePath);
    if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      throw new Error(`runtime manifest ${filePath} invalid sha256`);
    }
    entries.push({
      path: filePath,
      sha256: sha256.toLowerCase(),
      mustContain: normalizeMarkers(item['mustContain'] ?? item['requiredText']),
    });
  });
  return { schemaVersion: 1, files: entries };
}

function parseProfileInstances(value: unknown): HealthProfileInstance[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (!isRecord(item)) return null;
      const name = item['name'];
      if (typeof name !== 'string' || name.trim().length === 0) return null;
      const trimmed = name.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        throw new Error(`health profile instances[${index}].name must be a safe instance name`);
      }
      const expected = typeof item['expected'] === 'string' && item['expected'].trim().length > 0
        ? item['expected'].trim()
        : 'always_on';
      return { name: trimmed, expected };
    })
    .filter((item): item is HealthProfileInstance => item !== null);
}

function profileStringValue(profile: Record<string, unknown>, key: string): string | undefined {
  const value = profile[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  const nested = profile['fleetApi'];
  if (isRecord(nested)) {
    const nestedValue = nested[key];
    if (typeof nestedValue === 'string' && nestedValue.trim().length > 0) return nestedValue.trim();
  }
  return undefined;
}

function normalizeProfilePathField(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.includes('\0')
    || trimmed.includes('\\')
    || trimmed.includes('$')
  ) {
    throw new Error(`health profile ${field} must be a safe literal path`);
  }
  const withoutHome = trimmed.startsWith('~/') ? trimmed.slice(2) : trimmed;
  const relativeCandidate = path.isAbsolute(withoutHome) ? path.relative(path.parse(withoutHome).root, withoutHome) : withoutHome;
  const parts = relativeCandidate.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`health profile ${field} must not contain relative traversal segments`);
  }
  return trimmed;
}

export function parseHealthProfile(payload: unknown): HealthProfile {
  const profile = isRecord(payload) ? payload : {};
  const required = Array.isArray(profile['requiredCredentialFiles'])
    ? profile['requiredCredentialFiles'].filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return {
    requiredCredentialFiles: required.map(normalizeCredentialRequirement),
    expectDispatcher: profile['expectDispatcher'] === true,
    expectQLoop: profile['expectQLoop'] === true,
    expectFleetApi: profile['expectFleetApi'] === true,
    fleetApiTokenFile: normalizeProfilePathField(profileStringValue(profile, 'fleetApiTokenFile'), 'fleetApiTokenFile'),
    expectConfigInventory: profile['expectConfigInventory'] === true,
    expectPrimaryPhoneVerification: profile['expectPrimaryPhoneVerification'] === true,
    instances: parseProfileInstances(profile['instances']),
  };
}

function loadJson(pathName: string): unknown {
  return JSON.parse(readFileSync(pathName, 'utf8')) as unknown;
}

export function loadRuntimeManifest(cwd: string, manifestPath = 'deploy/bot-errors-runtime-manifest.json'): RuntimeManifest {
  return parseRuntimeManifest(loadJson(path.resolve(cwd, manifestPath)));
}

export function loadHealthProfile(cwd: string, profilePath?: string): HealthProfile {
  if (!profilePath) return parseHealthProfile({});
  return parseHealthProfile(loadJson(path.resolve(cwd, profilePath)));
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function kindFromMode(mode: number): FileKind {
  const type = mode & 0o170000;
  if (type === 0o100000) return 'regular';
  if (type === 0o040000) return 'directory';
  if (type === 0o120000) return 'symlink';
  return 'other';
}

function lstatKind(filePath: string): { exists: boolean; kind: FileKind; mode?: number; error?: string } {
  try {
    const stat = lstatSync(filePath);
    return { exists: true, kind: kindFromMode(stat.mode), mode: modeBits(stat.mode) };
  } catch (error) {
    const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : '';
    if (code === 'ENOENT') return { exists: false, kind: 'missing' };
    return { exists: false, kind: 'missing', error: error instanceof Error ? error.message : String(error) };
  }
}

function safeErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error['code'] === 'string' && error['code'].length > 0) {
    return error['code'];
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return 'unknown-error';
}

function sensitiveContentScan(filePath: string): SensitiveContentScan {
  try {
    const body = readFileSync(filePath);
    const slice = body.length > maxSensitiveScanBytes ? body.subarray(body.length - maxSensitiveScanBytes) : body;
    const text = slice.toString('utf8');
    return {
      kinds: sensitiveContentPatterns
        .filter((item) => item.pattern.test(text))
        .map((item) => item.kind),
    };
  } catch (error) {
    return { kinds: [], error: safeErrorCode(error) };
  }
}

function readRuntimeObservation(cwd: string, entry: RuntimeManifestEntry): RuntimeFileObservation {
  const filePath = path.resolve(cwd, entry.path);
  const observed = lstatKind(filePath);
  const base: RuntimeFileObservation = {
    path: entry.path,
    exists: observed.exists,
    kind: observed.kind,
    mode: observed.mode,
    error: observed.error,
  };
  if (!observed.exists || observed.kind !== 'regular') return base;
  try {
    const body = readFileSync(filePath);
    const text = body.toString('utf8');
    return {
      ...base,
      sha256: sha256(body),
      missingMarkers: entry.mustContain.filter((marker) => !text.includes(marker)),
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

function pathFingerprint(value: string): string {
  return sha256(value).slice(0, 16);
}

function credentialPathRef(filePath: string): string {
  return `${safeName(path.basename(filePath))}#${pathFingerprint(filePath)}`;
}

function authTreeRootForPath(filePath: string): string | null {
  const parts = path.resolve(filePath).split(path.sep);
  const authIndex = parts.lastIndexOf('auth');
  if (authIndex < 0 || authIndex >= parts.length - 1) return null;
  const prefix = parts[0] === '' ? path.sep : '';
  return path.join(prefix, ...parts.slice(parts[0] === '' ? 1 : 0, authIndex + 1));
}

function requirementRef(requirement: string): string {
  if (!requirement.includes('/') && !requirement.startsWith('~')) {
    return safeName(requirement);
  }
  return `${safeName(path.basename(requirement))}#${pathFingerprint(requirement)}`;
}

function normalizeCredentialRequirement(requirement: string, index: number): string {
  const trimmed = requirement.trim();
  if (
    trimmed.length === 0
    || trimmed.includes('\0')
    || trimmed.includes('\\')
    || trimmed.includes('$')
    || trimmed.startsWith('~')
    || path.isAbsolute(trimmed)
  ) {
    throw new Error(`health profile requiredCredentialFiles[${index}] must be a safe path under ~/.config/whatsoup`);
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`health profile requiredCredentialFiles[${index}] must not contain relative traversal segments`);
  }
  return trimmed;
}

function resolveCredentialPath(configRoot: string, requirement: string): string {
  return path.join(configRoot, requirement);
}

function walkNoFollow(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current).map((name) => path.join(current, name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      out.push(entry);
      const observed = lstatKind(entry);
      if (observed.kind === 'directory') stack.push(entry);
    }
  }
  return out;
}

function credentialRequirementPaths(configRoot: string, requirement: string): { paths: string[]; expected: string } {
  if (rootCredentialFiles.has(requirement) || requirement.includes('/') || requirement.startsWith('~')) {
    const expected = resolveCredentialPath(configRoot, requirement);
    const exists = existsSync(expected) || lstatKind(expected).kind === 'symlink';
    return { paths: exists ? [expected] : [], expected };
  }
  if (!existsSync(configRoot)) return { paths: [], expected: path.join(configRoot, requirement) };
  const paths = walkNoFollow(configRoot).filter((candidate) => {
    if (path.basename(candidate) !== requirement) return false;
    const observed = lstatKind(candidate);
    return observed.kind === 'regular' || observed.kind === 'symlink';
  });
  return { paths, expected: path.join(configRoot, '**', requirement) };
}

function shouldRequireInstanceConfig(profile: HealthProfile, instance: HealthProfileInstance): boolean {
  return profile.expectConfigInventory && (instance.expected === 'always_on' || instance.expected === 'on_demand');
}

function shouldRequireInstanceCredential(profile: HealthProfile, instance: HealthProfileInstance): boolean {
  return profile.expectPrimaryPhoneVerification && instance.expected === 'always_on';
}

function profileDerivedCredentialRequirements(profile: HealthProfile): string[] {
  const requirements: string[] = [];
  if (profile.expectDispatcher || profile.expectQLoop) {
    requirements.push('bot-errors.env');
  }
  for (const instance of profile.instances) {
    if (shouldRequireInstanceConfig(profile, instance)) {
      requirements.push(`instances/${instance.name}/config.json`);
    }
    if (instance.expected === 'always_on') {
      requirements.push(`instances/${instance.name}/tokens.env`);
    }
    if (shouldRequireInstanceCredential(profile, instance)) {
      requirements.push(`instances/${instance.name}/auth/creds.json`);
    }
  }
  return [...new Set(requirements)];
}

function isCredentialLikePath(configRoot: string, filePath: string): boolean {
  const relative = path.relative(configRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).filter(Boolean);
  const base = path.basename(filePath);
  if (credentialLikeBasenames.has(base) || base.endsWith('.env')) return true;
  return segments.includes('auth');
}

function isDataAuthCredentialPath(dataInstancesRoot: string, filePath: string): boolean {
  const relative = path.relative(dataInstancesRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).filter(Boolean);
  const authIndex = segments.indexOf('auth');
  return authIndex > 0 && authIndex < segments.length - 1;
}

function discoverAuthRoots(instancesRoot: string): string[] {
  if (!existsSync(instancesRoot)) return [];
  return walkNoFollow(instancesRoot).filter((candidate) => {
    if (path.basename(candidate) !== 'auth') return false;
    const relative = path.relative(instancesRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    return relative.split(path.sep).filter(Boolean).length >= 2;
  });
}

function hasProfileAuditScope(profile: HealthProfile): boolean {
  return profile.requiredCredentialFiles.length > 0
    || profile.instances.length > 0
    || profile.expectDispatcher
    || profile.expectQLoop
    || profile.expectFleetApi
    || profile.expectConfigInventory
    || profile.expectPrimaryPhoneVerification;
}

function parentIssues(configRoot: string, filePath: string): ParentPathIssue[] {
  const issues: ParentPathIssue[] = [];
  const parents: string[] = [];
  const absoluteRoot = path.resolve(configRoot);
  const absolutePath = path.resolve(filePath);
  if (absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    let current = absoluteRoot;
    parents.push(current);
    for (const part of path.relative(absoluteRoot, path.dirname(absolutePath)).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      parents.push(current);
    }
  } else {
    parents.push(path.dirname(absolutePath));
  }

  for (const parent of parents) {
    const observed = lstatKind(parent);
    if (!observed.exists) {
      issues.push({ path: parent, kind: 'missing', error: observed.error });
    } else if (observed.kind === 'symlink') {
      issues.push({ path: parent, kind: 'symlink', mode: observed.mode });
    } else if (observed.kind !== 'directory') {
      issues.push({ path: parent, kind: 'not-directory', mode: observed.mode });
    } else if (((observed.mode ?? 0) & 0o500) !== 0o500) {
      issues.push({ path: parent, kind: 'owner-access-missing', mode: observed.mode });
    } else if ((observed.mode ?? 0) > 0o700) {
      issues.push({ path: parent, kind: 'mode-too-open', mode: observed.mode });
    }
  }
  return issues;
}

function ownerAccessGaps(mode: number, expectedKind: ExpectedKind): string[] {
  const gaps: string[] = [];
  if ((mode & 0o400) === 0) gaps.push('owner-read');
  if (expectedKind === 'directory' && (mode & 0o100) === 0) gaps.push('owner-execute');
  return gaps;
}

function credentialObservation(
  configRoot: string,
  requirement: string,
  expected: string,
  required: boolean,
  source: CredentialObservation['source'],
  filePath?: string,
): CredentialObservation {
  if (!filePath) {
    return {
      requirement,
      expected,
      required,
      source,
      exists: false,
      kind: 'missing',
      parentIssues: [],
    };
  }
  const observed = lstatKind(filePath);
  let readable = false;
  let size: number | undefined;
  if (observed.exists && observed.kind === 'regular') {
    readable = ((observed.mode ?? 0) & 0o400) !== 0;
    try {
      const stat = statSync(filePath);
      size = stat.size;
    } catch {
      size = undefined;
    }
  }
  return {
    requirement,
    expected,
    required,
    source,
    path: filePath,
    exists: observed.exists,
    kind: observed.kind,
    mode: observed.mode,
    size,
    readable,
    parentIssues: parentIssues(configRoot, filePath),
    error: observed.error,
  };
}

function collectCredentialObservations(home: string, profile: HealthProfile): CredentialObservation[] {
  const configRoot = path.join(home, '.config', 'whatsoup');
  const dataInstancesRoot = path.join(home, '.local', 'share', 'whatsoup', 'instances');
  const observations: CredentialObservation[] = [];
  const observedPaths = new Set<string>();
  const missingRequirements = new Set<string>();
  const addRequirement = (
    requirement: string,
    required: boolean,
    source: CredentialObservation['source'],
  ): void => {
    const { paths, expected } = credentialRequirementPaths(configRoot, requirement);
    if (paths.length === 0) {
      const key = path.resolve(expected);
      if (required && !missingRequirements.has(key) && !observedPaths.has(key)) {
        missingRequirements.add(key);
        observations.push(credentialObservation(configRoot, requirement, expected, required, source));
      }
      return;
    }
    for (const filePath of paths) {
      const key = path.resolve(filePath);
      if (observedPaths.has(key)) continue;
      observedPaths.add(key);
      observations.push(credentialObservation(configRoot, requirement, expected, required, source, filePath));
    }
  };
  const addPathRequirement = (
    requirement: string,
    expected: string,
    required: boolean,
    source: CredentialObservation['source'],
  ): void => {
    const key = path.resolve(expected);
    const exists = existsSync(expected) || lstatKind(expected).kind === 'symlink';
    if (!exists) {
      if (required && !missingRequirements.has(key) && !observedPaths.has(key)) {
        missingRequirements.add(key);
        observations.push(credentialObservation(configRoot, requirement, expected, required, source));
      }
      return;
    }
    if (observedPaths.has(key)) return;
    observedPaths.add(key);
    observations.push(credentialObservation(configRoot, requirement, expected, required, source, expected));
  };

  for (const requirement of profile.requiredCredentialFiles) {
    addRequirement(requirement, true, 'required');
  }
  for (const requirement of profileDerivedCredentialRequirements(profile)) {
    addRequirement(requirement, true, 'profile-derived');
  }
  if (profile.expectFleetApi) {
    addPathRequirement(
      'fleetApiTokenFile',
      resolveProfileCredentialPath(home, configRoot, profile.fleetApiTokenFile ?? 'fleet-tokens.json'),
      true,
      'profile-derived',
    );
  }
  if (hasProfileAuditScope(profile) && existsSync(configRoot)) {
    for (const filePath of walkNoFollow(configRoot)) {
      const key = path.resolve(filePath);
      if (observedPaths.has(key) || !isCredentialLikePath(configRoot, filePath)) {
        continue;
      }
      const observed = lstatKind(filePath);
      if (observed.kind !== 'regular' && observed.kind !== 'symlink') {
        continue;
      }
      observedPaths.add(key);
      observations.push(credentialObservation(configRoot, filePath, filePath, false, 'discovered', filePath));
    }
  }
  if (hasProfileAuditScope(profile) && existsSync(dataInstancesRoot)) {
    for (const filePath of walkNoFollow(dataInstancesRoot)) {
      const key = path.resolve(filePath);
      if (observedPaths.has(key) || !isDataAuthCredentialPath(dataInstancesRoot, filePath)) {
        continue;
      }
      const observed = lstatKind(filePath);
      if (observed.kind !== 'regular' && observed.kind !== 'symlink') {
        continue;
      }
      observedPaths.add(key);
      observations.push(credentialObservation(dataInstancesRoot, filePath, filePath, false, 'discovered', filePath));
    }
  }
  return observations;
}

function resolveProfileCredentialPath(home: string, configRoot: string, value: string): string {
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  if (path.isAbsolute(value)) return value;
  return path.join(configRoot, value);
}

function criticalPathObservation(label: string, filePath: string, expectedKind: ExpectedKind, required: boolean): CriticalPathObservation {
  const observed = lstatKind(filePath);
  const observation: CriticalPathObservation = {
    label,
    path: filePath,
    required,
    expectedKind,
    exists: observed.exists,
    kind: observed.kind,
    mode: observed.mode,
    error: observed.error,
  };
  if (observed.kind === 'regular') {
    const scan = sensitiveContentScan(filePath);
    if (scan.kinds.length > 0) observation.sensitiveContentKinds = scan.kinds;
    if (scan.error) observation.sensitiveScanError = scan.error;
  }
  return observation;
}

function collectCriticalPathObservations(home: string, profile: HealthProfile): CriticalPathObservation[] {
  if (!hasProfileAuditScope(profile)) return [];
  const paths: CriticalPathObservation[] = [];
  const seenPaths = new Set<string>();
  const configRoot = path.join(home, '.config', 'whatsoup');
  const instancesRoot = path.join(configRoot, 'instances');
  const dataInstancesRoot = path.join(home, '.local', 'share', 'whatsoup', 'instances');
  const stateRoot = path.join(home, '.local', 'state', 'bot-errors');
  const qLoopRoot = path.join(home, '.local', 'state', 'bot-errors-q-loop');
  const addPath = (label: string, filePath: string, expectedKind: ExpectedKind, required: boolean): void => {
    const key = `${expectedKind}:${path.resolve(filePath)}`;
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    paths.push(criticalPathObservation(label, filePath, expectedKind, required));
  };

  addPath(
    'whatsoup-config-root',
    configRoot,
    'directory',
    profile.requiredCredentialFiles.length > 0 || profile.instances.length > 0 || profile.expectDispatcher || profile.expectQLoop || profile.expectFleetApi,
  );
  addPath('fleet-silences-file', path.join(configRoot, 'fleet-silences.json'), 'file', false);
  addPath('fleet-alert-throttle-file', path.join(configRoot, 'fleet-alert-throttle.json'), 'file', false);
  addPath('whatsoup-instances-root', instancesRoot, 'directory', profile.instances.length > 0);
  addPath('whatsoup-data-instances-root', dataInstancesRoot, 'directory', false);
  for (const instance of profile.instances) {
    const requireInstanceRoot = shouldRequireInstanceConfig(profile, instance)
      || shouldRequireInstanceCredential(profile, instance)
      || instance.expected === 'always_on';
    const instanceRoot = path.join(instancesRoot, instance.name);
    const dataInstanceRoot = path.join(dataInstancesRoot, instance.name);
    addPath(`instance-root:${instance.name}`, instanceRoot, 'directory', requireInstanceRoot);
    addPath(`data-instance-root:${instance.name}`, dataInstanceRoot, 'directory', requireInstanceRoot);
    addPath(`instance-auth-root:${instance.name}`, path.join(instanceRoot, 'auth'), 'directory', shouldRequireInstanceCredential(profile, instance));
    addPath(`data-auth-root:${instance.name}`, path.join(dataInstanceRoot, 'auth'), 'directory', false);
  }
  for (const authRoot of discoverAuthRoots(instancesRoot)) {
    addPath(`discovered-config-auth-root:${path.basename(path.dirname(authRoot))}`, authRoot, 'directory', false);
  }
  for (const authRoot of discoverAuthRoots(dataInstancesRoot)) {
    addPath(`discovered-data-auth-root:${path.basename(path.dirname(authRoot))}`, authRoot, 'directory', false);
  }
  addPath('bot-errors-state-root', stateRoot, 'directory', profile.expectDispatcher || profile.expectQLoop);
  addPath('bot-errors-outbox-dir', path.join(stateRoot, 'outbox'), 'directory', false);
  addPath('bot-errors-writefail-dir', path.join(stateRoot, 'writefail'), 'directory', false);
  addPath('bot-errors-failed-dir', path.join(stateRoot, 'failed'), 'directory', false);
  addPath('bot-errors-sent-dir', path.join(stateRoot, 'sent'), 'directory', false);
  addPath('bot-errors-suppressed-dir', path.join(stateRoot, 'suppressed'), 'directory', false);
  addPath('bot-errors-archive-dir', path.join(stateRoot, 'archive'), 'directory', false);
  addPath('q-loop-state-root', qLoopRoot, 'directory', profile.expectQLoop);
  addPath('q-loop-state-file', path.join(qLoopRoot, 'state.json'), 'file', profile.expectQLoop);
  addPath('dispatcher-state-file', path.join(stateRoot, 'dispatcher-state.json'), 'file', false);
  addPath('collector-state-file', path.join(stateRoot, 'collector-state.json'), 'file', false);
  addPath('heartbeat-watchdog-state-file', path.join(stateRoot, 'heartbeat-watchdog-state.json'), 'file', false);
  return paths;
}

export function collectLocalObservations(
  cwd: string,
  manifest: RuntimeManifest,
  profile: HealthProfile,
  home = process.env.HOME ?? '',
): CriticalSurfaceObservations {
  return {
    runtime: manifest.files.map((entry) => readRuntimeObservation(cwd, entry)),
    credentials: collectCredentialObservations(home, profile),
    criticalPaths: collectCriticalPathObservations(home, profile),
  };
}

export function evaluateCriticalSurfaces(
  manifest: RuntimeManifest,
  observations: CriticalSurfaceObservations,
): CriticalSurfaceIssue[] {
  const issues: CriticalSurfaceIssue[] = [];
  const emittedCredentialParentIssues = new Set<string>();
  const emittedCredentialModeIssues = new Set<string>();
  const runtimeByPath = new Map(observations.runtime.map((item) => [item.path, item]));
  for (const entry of manifest.files) {
    const observed = runtimeByPath.get(entry.path);
    if (!observed || !observed.exists) {
      issues.push(issue('runtime', 'runtime-missing', entry.path, `runtime script missing: ${entry.path}`));
      continue;
    }
    if (observed.kind !== 'regular') {
      issues.push(issue('runtime', 'runtime-kind', entry.path, `runtime script is ${observed.kind}, expected regular file: ${entry.path}`));
      continue;
    }
    if (observed.sha256 !== entry.sha256) {
      issues.push(issue('runtime', 'runtime-sha256-drift', entry.path, `runtime script hash drift: ${entry.path}`, entry.sha256, observed.sha256 ?? '<unreadable>'));
    }
    const missingMarkers = observed.missingMarkers ?? [];
    if (missingMarkers.length > 0) {
      issues.push(issue('runtime', 'runtime-marker-drift', entry.path, `runtime script missing required markers: ${entry.path} markers=${missingMarkers.join(',')}`));
    }
  }

  for (const observed of observations.credentials) {
    const req = requirementRef(observed.requirement);
    if (!observed.exists) {
      if (!observed.required) continue;
      issues.push({
        kind: 'credential-missing',
        severity: 'error',
        surface: 'credential',
        requirement: req,
        expected: credentialPathRef(observed.expected),
        message: `required credential missing: requirement=${req} expected=${credentialPathRef(observed.expected)}`,
      });
      continue;
    }
    const target = observed.path ? credentialPathRef(observed.path) : credentialPathRef(observed.expected);
    for (const parent of observed.parentIssues) {
      const parentKey = `${path.resolve(parent.path)}:${parent.kind}:${parent.mode ?? ''}`;
      if (emittedCredentialParentIssues.has(parentKey)) continue;
      emittedCredentialParentIssues.add(parentKey);
      issues.push({
        kind: 'credential-parent-unsafe',
        severity: 'error',
        surface: 'credential',
        requirement: req,
        path: target,
        actual: parent.mode === undefined ? parent.kind : `${parent.kind}:${parent.mode.toString(8)}`,
        message: `credential parent unsafe: requirement=${req} path=${target} parent=${credentialPathRef(parent.path)} reason=${parent.kind}${parent.mode === undefined ? '' : ` mode=${parent.mode.toString(8)}`}`,
      });
    }
    if (observed.kind !== 'regular') {
      issues.push({
        kind: 'credential-kind',
        severity: 'error',
        surface: 'credential',
        requirement: req,
        path: target,
        actual: observed.kind,
        message: `credential path is ${observed.kind}, expected regular file: requirement=${req} path=${target}`,
      });
    } else if (!observed.readable) {
      issues.push({
        kind: 'credential-unreadable',
        severity: 'error',
        surface: 'credential',
        requirement: req,
        path: target,
        message: `credential path is not owner-readable: requirement=${req} path=${target}`,
      });
    } else if ((observed.mode ?? 0) > 0o600 || ((observed.mode ?? 0) & 0o022) !== 0) {
      const authTreeRoot = observed.source === 'discovered' && observed.path ? authTreeRootForPath(observed.path) : null;
      const groupedTarget = authTreeRoot ? credentialPathRef(authTreeRoot) : target;
      const modeKey = `${groupedTarget}:${observed.mode ?? 0}`;
      if (emittedCredentialModeIssues.has(modeKey)) continue;
      emittedCredentialModeIssues.add(modeKey);
      issues.push({
        kind: 'credential-mode-too-open',
        severity: 'error',
        surface: 'credential',
        requirement: req,
        path: groupedTarget,
        actual: (observed.mode ?? 0).toString(8),
        expected: '600',
        message: `credential mode too open: requirement=${req} path=${groupedTarget} mode=${(observed.mode ?? 0).toString(8)} expected<=600`,
      });
    } else if ((observed.size ?? 1) === 0) {
      issues.push({
        kind: 'credential-empty',
        severity: 'error',
        surface: 'credential',
        requirement: req,
        path: target,
        message: `credential file is empty: requirement=${req} path=${target}`,
      });
    }
  }

  for (const observed of observations.criticalPaths) {
    const expectedKind = observed.expectedKind === 'file' ? 'regular' : 'directory';
    const ref = credentialPathRef(observed.path);
    if (!observed.exists) {
      if (observed.required) {
        issues.push({
          kind: 'critical-path-missing',
          severity: 'error',
          surface: 'critical-path',
          label: observed.label,
          path: ref,
          message: `critical path missing: label=${observed.label} path=${ref}`,
        });
      }
      continue;
    }
    if (observed.kind !== expectedKind) {
      issues.push({
        kind: 'critical-path-kind',
        severity: 'error',
        surface: 'critical-path',
        label: observed.label,
        path: ref,
        actual: observed.kind,
        expected: expectedKind,
        message: `critical path is ${observed.kind}, expected ${expectedKind}: label=${observed.label} path=${ref}`,
      });
      continue;
    }
    const maxMode = observed.expectedKind === 'file' ? 0o600 : 0o700;
    const accessGaps = ownerAccessGaps(observed.mode ?? 0, observed.expectedKind);
    if (accessGaps.length > 0) {
      issues.push({
        kind: 'critical-path-owner-access-missing',
        severity: 'error',
        surface: 'critical-path',
        label: observed.label,
        path: ref,
        actual: accessGaps.join(','),
        expected: observed.expectedKind === 'file' ? 'owner-read' : 'owner-read,owner-execute',
        message: `critical path missing owner access: label=${observed.label} path=${ref} missing=${accessGaps.join(',')}`,
      });
    }
    if ((observed.mode ?? 0) > maxMode || ((observed.mode ?? 0) & 0o022) !== 0) {
      issues.push({
        kind: 'critical-path-mode-too-open',
        severity: 'error',
        surface: 'critical-path',
        label: observed.label,
        path: ref,
        actual: (observed.mode ?? 0).toString(8),
        expected: maxMode.toString(8),
        message: `critical path mode too open: label=${observed.label} path=${ref} mode=${(observed.mode ?? 0).toString(8)} expected<=${maxMode.toString(8)}`,
      });
    }
    if ((observed.sensitiveContentKinds ?? []).length > 0) {
      const kinds = [...new Set(observed.sensitiveContentKinds)].sort();
      issues.push({
        kind: 'critical-path-sensitive-content',
        severity: 'error',
        surface: 'critical-path',
        label: observed.label,
        path: ref,
        actual: kinds.join(','),
        message: `critical path contains unredacted sensitive marker: label=${observed.label} path=${ref} kinds=${kinds.join(',')}`,
      });
    }
    if (observed.sensitiveScanError) {
      issues.push({
        kind: 'critical-path-sensitive-scan-failed',
        severity: 'error',
        surface: 'critical-path',
        label: observed.label,
        path: ref,
        actual: observed.sensitiveScanError,
        message: `critical path sensitive-content scan failed: label=${observed.label} path=${ref} error=${observed.sensitiveScanError}`,
      });
    }
  }

  return issues;
}

function issue(
  surface: CriticalSurfaceIssue['surface'],
  kind: CriticalSurfaceIssueKind,
  pathName: string,
  message: string,
  expected?: string,
  actual?: string,
): CriticalSurfaceIssue {
  return { kind, severity: 'error', surface, path: pathName, message, expected, actual };
}

function parseArgs(argv: string[], cwd: string): AuditOptions {
  const options: AuditOptions = {
    cwd,
    manifestPath: 'deploy/bot-errors-runtime-manifest.json',
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
    if (arg === '--manifest') options.manifestPath = next();
    else if (arg === '--profile') options.profilePath = next();
    else if (arg === '--remote') options.remote = next();
    else if (arg === '--repo-root') options.repoRoot = next();
    else if (arg === '--home') options.home = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      throw new Error([
        'Usage: npm run guard:bot-errors-critical-surfaces -- [--profile deploy/health-profiles/<host>.json]',
        '       [--remote <host>] [--repo-root <repo-root>] [--json]',
      ].join('\n'));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.remote && !options.repoRoot) options.repoRoot = '~/LAB/WhatSoup';
  return options;
}

function remoteProbeScript(manifest: RuntimeManifest, profile: HealthProfile, repoRoot: string): string {
  const payload = Buffer.from(JSON.stringify({ manifest, profile, repoRoot }), 'utf8').toString('base64');
  const extraCredentialBasenames = [...credentialLikeBasenames]
    .filter((name) => !rootCredentialFiles.has(name))
    .sort();
  return String.raw`
import base64, hashlib, json, os, re, stat, sys
from pathlib import Path

payload = json.loads(base64.b64decode("${payload}").decode("utf-8"))
manifest = payload["manifest"]
profile = payload["profile"]
repo = Path(os.path.expanduser(payload["repoRoot"]))
home = Path.home()
ROOT_CREDENTIAL_FILES = {"bot-errors.env", "fleet-token", "fleet.env", "fleet-tokens.json", "secrets.env"}
CREDENTIAL_LIKE_BASENAMES = set(ROOT_CREDENTIAL_FILES) | set(${JSON.stringify(extraCredentialBasenames)})
MAX_SENSITIVE_SCAN_BYTES = 1024 * 1024
SENSITIVE_PATTERNS = [
    ("authorization-bearer", re.compile(r"\bAuthorization:\s*Bearer\s+(?!\[REDACTED\])[\w._~+/=-]{6,}", re.I)),
    ("bearer-token", re.compile(r"\bBearer\s+(?!\[REDACTED\])[\w._~+/=-]{6,}", re.I)),
    ("keyed-secret", re.compile(r"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|credential)\b\s*[:=]\s*[\"']?(?!\[REDACTED\]|redacted\b|<redacted>)[^\s\"',}]{6,}", re.I)),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("private-key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
    ("credential-path", re.compile(r"(?:(?<![A-Za-z0-9._~-])~|(?<![A-Za-z0-9._~-])/)[^\s\"',;}]*?(?:\.config/secrets/[^\s\"',;}]+|\.config/whatsoup/[^\s\"',;}]+|\.local/share/whatsoup/instances/[^\s\"',;}]*/auth(?:/[^\s\"',;}]+)?|auth-bond-backups/[^\s\"',;}]+|/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env|\.env(?:\.[^\s\"',;}]+)?))\b", re.I)),
]

if not repo.exists() or not repo.is_dir():
    sys.stderr.write(f"remote repo root missing or not a directory: {repo}\n")
    sys.exit(2)

def kind(mode):
    if stat.S_ISREG(mode): return "regular"
    if stat.S_ISDIR(mode): return "directory"
    if stat.S_ISLNK(mode): return "symlink"
    return "other"

def lstat_kind(p):
    try:
        st = p.lstat()
        return {"exists": True, "kind": kind(st.st_mode), "mode": stat.S_IMODE(st.st_mode)}
    except FileNotFoundError:
        return {"exists": False, "kind": "missing"}
    except OSError as exc:
        return {"exists": False, "kind": "missing", "error": str(exc)}

def sensitive_scan_error(exc):
    code = getattr(exc, "errno", None)
    if code is not None:
        return "errno:" + str(code)
    return type(exc).__name__

def sensitive_content_scan(p):
    try:
        body = p.read_bytes()
    except OSError as exc:
        return {"kinds": [], "error": sensitive_scan_error(exc)}
    if len(body) > MAX_SENSITIVE_SCAN_BYTES:
        body = body[-MAX_SENSITIVE_SCAN_BYTES:]
    text = body.decode("utf-8", errors="replace")
    return {"kinds": [kind for kind, pattern in SENSITIVE_PATTERNS if pattern.search(text)]}

def runtime_obs(entry):
    rel = entry["path"]
    p = repo / rel
    obs = {"path": rel, **lstat_kind(p)}
    if not obs["exists"] or obs["kind"] != "regular":
        return obs
    try:
        body = p.read_bytes()
        text = body.decode("utf-8", errors="replace")
        obs["sha256"] = hashlib.sha256(body).hexdigest()
        obs["missingMarkers"] = [m for m in entry.get("mustContain", []) if m not in text]
    except OSError as exc:
        obs["error"] = str(exc)
    return obs

def walk_no_follow(root):
    out = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = [current / name for name in os.listdir(current)]
        except OSError:
            continue
        for entry in entries:
            out.append(entry)
            info = lstat_kind(entry)
            if info["kind"] == "directory":
                stack.append(entry)
    return out

def resolve_credential(config_root, requirement):
    return config_root / requirement

def credential_paths(config_root, requirement):
    if requirement in ROOT_CREDENTIAL_FILES or "/" in requirement or requirement.startswith("~"):
        expected = resolve_credential(config_root, requirement)
        info = lstat_kind(expected)
        return ([expected] if info["exists"] or info["kind"] == "symlink" else []), str(expected)
    if not config_root.exists():
        return [], str(config_root / requirement)
    matches = []
    for candidate in walk_no_follow(config_root):
        if candidate.name != requirement:
            continue
        info = lstat_kind(candidate)
        if info["kind"] in {"regular", "symlink"}:
            matches.append(candidate)
    return sorted(matches), str(config_root / "**" / requirement)

def should_require_instance_config(profile, instance):
    return bool(profile.get("expectConfigInventory")) and instance.get("expected") in {"always_on", "on_demand"}

def should_require_instance_credential(profile, instance):
    return bool(profile.get("expectPrimaryPhoneVerification")) and instance.get("expected") == "always_on"

def profile_derived_credentials(profile):
    requirements = []
    if bool(profile.get("expectDispatcher")) or bool(profile.get("expectQLoop")):
        requirements.append("bot-errors.env")
    for instance in profile.get("instances", []):
        if not isinstance(instance, dict):
            continue
        name = str(instance.get("name") or "").strip()
        if not name:
            continue
        if should_require_instance_config(profile, instance):
            requirements.append(f"instances/{name}/config.json")
        if instance.get("expected") == "always_on":
            requirements.append(f"instances/{name}/tokens.env")
        if should_require_instance_credential(profile, instance):
            requirements.append(f"instances/{name}/auth/creds.json")
    return sorted(set(requirements))

def resolve_profile_credential(home, config_root, raw):
    value = str(raw or "").strip() or "fleet-tokens.json"
    if value.startswith("~/"):
        return home / value[2:]
    p = Path(value)
    if p.is_absolute():
        return p
    return config_root / value

def is_credential_like(config_root, p):
    try:
        rel = p.relative_to(config_root)
    except ValueError:
        return False
    if p.name in CREDENTIAL_LIKE_BASENAMES or p.name.endswith(".env"):
        return True
    return "auth" in rel.parts

def is_data_auth_credential(data_instances_root, p):
    try:
        rel = p.relative_to(data_instances_root)
    except ValueError:
        return False
    parts = rel.parts
    try:
        auth_index = parts.index("auth")
    except ValueError:
        return False
    return auth_index > 0 and auth_index < len(parts) - 1

def discover_auth_roots(instances_root):
    roots = []
    if not instances_root.exists():
        return roots
    for p in walk_no_follow(instances_root):
        if p.name != "auth":
            continue
        try:
            rel = p.relative_to(instances_root)
        except ValueError:
            continue
        if len(rel.parts) >= 2:
            roots.append(p)
    return sorted(roots)

def has_profile_audit_scope(profile):
    return (
        len(profile.get("requiredCredentialFiles", [])) > 0
        or len(profile.get("instances", [])) > 0
        or bool(profile.get("expectDispatcher"))
        or bool(profile.get("expectQLoop"))
        or bool(profile.get("expectFleetApi"))
        or bool(profile.get("expectConfigInventory"))
        or bool(profile.get("expectPrimaryPhoneVerification"))
    )

def parent_issues(config_root, p):
    issues = []
    try:
        rel = p.resolve().relative_to(config_root.resolve())
        parents = [config_root]
        current = config_root
        for part in rel.parts[:-1]:
            current = current / part
            parents.append(current)
    except Exception:
        parents = [p.parent]
    for parent in parents:
        info = lstat_kind(parent)
        if not info["exists"]:
            issues.append({"path": str(parent), "kind": "missing", "error": info.get("error")})
        elif info["kind"] == "symlink":
            issues.append({"path": str(parent), "kind": "symlink", "mode": info.get("mode")})
        elif info["kind"] != "directory":
            issues.append({"path": str(parent), "kind": "not-directory", "mode": info.get("mode")})
        elif (int(info.get("mode", 0)) & 0o500) != 0o500:
            issues.append({"path": str(parent), "kind": "owner-access-missing", "mode": info.get("mode")})
        elif int(info.get("mode", 0)) > 0o700:
            issues.append({"path": str(parent), "kind": "mode-too-open", "mode": info.get("mode")})
    return issues

def credential_obs(config_root, requirement, expected, required, source, p=None):
    if p is None:
        return {
            "requirement": requirement,
            "expected": expected,
            "required": required,
            "source": source,
            "exists": False,
            "kind": "missing",
            "parentIssues": [],
        }
    info = lstat_kind(p)
    size = None
    if info["kind"] == "regular":
        try:
            size = p.stat().st_size
        except OSError:
            size = None
    return {
        "requirement": requirement,
        "expected": expected,
        "required": required,
        "source": source,
        "path": str(p),
        **info,
        "size": size,
        "readable": bool(int(info.get("mode", 0)) & 0o400) if info["kind"] == "regular" else False,
        "parentIssues": parent_issues(config_root, p),
    }

def critical_path(label, p, expected_kind, required):
    obs = {"label": label, "path": str(p), "expectedKind": expected_kind, "required": required, **lstat_kind(p)}
    if obs.get("kind") == "regular":
        scan = sensitive_content_scan(p)
        kinds = scan.get("kinds") or []
        if kinds:
            obs["sensitiveContentKinds"] = kinds
        if scan.get("error"):
            obs["sensitiveScanError"] = scan["error"]
    return obs

config_root = home / ".config" / "whatsoup"
instances_root = config_root / "instances"
data_instances_root = home / ".local" / "share" / "whatsoup" / "instances"
state_root = home / ".local" / "state" / "bot-errors"
q_loop_root = home / ".local" / "state" / "bot-errors-q-loop"
credentials = []
observed_paths = set()
missing_requirements = set()
def add_credential_requirement(requirement, required, source):
    paths, expected = credential_paths(config_root, requirement)
    if not paths:
        key = str(Path(expected).absolute())
        if required and key not in missing_requirements and key not in observed_paths:
            missing_requirements.add(key)
            credentials.append(credential_obs(config_root, requirement, expected, required, source))
        return
    for p in paths:
        key = str(p.absolute())
        if key in observed_paths:
            continue
        observed_paths.add(key)
        credentials.append(credential_obs(config_root, requirement, expected, required, source, p))

def add_credential_path_requirement(requirement, expected, required, source):
    key = str(expected.absolute())
    info = lstat_kind(expected)
    if not info["exists"] and info["kind"] != "symlink":
        if required and key not in missing_requirements and key not in observed_paths:
            missing_requirements.add(key)
            credentials.append(credential_obs(config_root, requirement, str(expected), required, source))
        return
    if key in observed_paths:
        return
    observed_paths.add(key)
    credentials.append(credential_obs(config_root, requirement, str(expected), required, source, expected))

for requirement in profile.get("requiredCredentialFiles", []):
    add_credential_requirement(requirement, True, "required")
for requirement in profile_derived_credentials(profile):
    add_credential_requirement(requirement, True, "profile-derived")
if bool(profile.get("expectFleetApi")):
    add_credential_path_requirement(
        "fleetApiTokenFile",
        resolve_profile_credential(home, config_root, profile.get("fleetApiTokenFile")),
        True,
        "profile-derived",
    )
if has_profile_audit_scope(profile) and config_root.exists():
    for p in walk_no_follow(config_root):
        key = str(p.absolute())
        if key in observed_paths or not is_credential_like(config_root, p):
            continue
        info = lstat_kind(p)
        if info["kind"] not in {"regular", "symlink"}:
            continue
        observed_paths.add(key)
        credentials.append(credential_obs(config_root, str(p), str(p), False, "discovered", p))
if has_profile_audit_scope(profile) and data_instances_root.exists():
    for p in walk_no_follow(data_instances_root):
        key = str(p.absolute())
        if key in observed_paths or not is_data_auth_credential(data_instances_root, p):
            continue
        info = lstat_kind(p)
        if info["kind"] not in {"regular", "symlink"}:
            continue
        observed_paths.add(key)
        credentials.append(credential_obs(data_instances_root, str(p), str(p), False, "discovered", p))

critical_paths = []
if has_profile_audit_scope(profile):
    seen_critical_paths = set()
    def add_critical_path(label, p, expected_kind, required):
        key = f"{expected_kind}:{p.absolute()}"
        if key in seen_critical_paths:
            return
        seen_critical_paths.add(key)
        critical_paths.append(critical_path(label, p, expected_kind, required))

    for item in [
        (
            "whatsoup-config-root",
            config_root,
            "directory",
            len(profile.get("requiredCredentialFiles", [])) > 0
            or len(profile.get("instances", [])) > 0
            or bool(profile.get("expectDispatcher"))
            or bool(profile.get("expectQLoop"))
            or bool(profile.get("expectFleetApi")),
        ),
        ("fleet-silences-file", config_root / "fleet-silences.json", "file", False),
        ("fleet-alert-throttle-file", config_root / "fleet-alert-throttle.json", "file", False),
        ("whatsoup-instances-root", instances_root, "directory", len(profile.get("instances", [])) > 0),
        ("whatsoup-data-instances-root", data_instances_root, "directory", False),
    ]:
        add_critical_path(*item)
    for instance in profile.get("instances", []):
        if not isinstance(instance, dict):
            continue
        name = str(instance.get("name") or "").strip()
        if not name:
            continue
        instance_root = instances_root / name
        require_instance_root = (
            should_require_instance_config(profile, instance)
            or should_require_instance_credential(profile, instance)
            or instance.get("expected") == "always_on"
        )
        data_instance_root = data_instances_root / name
        add_critical_path(f"instance-root:{name}", instance_root, "directory", require_instance_root)
        add_critical_path(f"data-instance-root:{name}", data_instance_root, "directory", require_instance_root)
        add_critical_path(f"instance-auth-root:{name}", instance_root / "auth", "directory", should_require_instance_credential(profile, instance))
        add_critical_path(f"data-auth-root:{name}", data_instance_root / "auth", "directory", False)
    for auth_root in discover_auth_roots(instances_root):
        add_critical_path(f"discovered-config-auth-root:{auth_root.parent.name}", auth_root, "directory", False)
    for auth_root in discover_auth_roots(data_instances_root):
        add_critical_path(f"discovered-data-auth-root:{auth_root.parent.name}", auth_root, "directory", False)
    for item in [
        ("bot-errors-state-root", state_root, "directory", bool(profile.get("expectDispatcher")) or bool(profile.get("expectQLoop"))),
        ("bot-errors-outbox-dir", state_root / "outbox", "directory", False),
        ("bot-errors-writefail-dir", state_root / "writefail", "directory", False),
        ("bot-errors-failed-dir", state_root / "failed", "directory", False),
        ("bot-errors-sent-dir", state_root / "sent", "directory", False),
        ("bot-errors-suppressed-dir", state_root / "suppressed", "directory", False),
        ("bot-errors-archive-dir", state_root / "archive", "directory", False),
        ("q-loop-state-root", q_loop_root, "directory", bool(profile.get("expectQLoop"))),
        ("q-loop-state-file", q_loop_root / "state.json", "file", bool(profile.get("expectQLoop"))),
        ("dispatcher-state-file", state_root / "dispatcher-state.json", "file", False),
        ("collector-state-file", state_root / "collector-state.json", "file", False),
        ("heartbeat-watchdog-state-file", state_root / "heartbeat-watchdog-state.json", "file", False),
    ]:
        add_critical_path(*item)

result = {
    "runtime": [runtime_obs(entry) for entry in manifest.get("files", [])],
    "credentials": credentials,
    "criticalPaths": critical_paths,
}
print(json.dumps(result))
`;
}

export function buildRemoteProbeScript(manifest: RuntimeManifest, profile: HealthProfile, repoRoot: string): string {
  return remoteProbeScript(manifest, profile, repoRoot);
}

function collectRemoteObservations(remote: string, script: string): CriticalSurfaceObservations | CriticalSurfaceIssue[] {
  const proc = spawnSync('ssh', [remote, 'python3 -'], {
    input: script,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (proc.error) {
    return [issue('remote', 'remote-error', remote, `remote audit failed: ${proc.error.message}`)];
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr.trim().slice(0, 1200);
    return [issue('remote', 'remote-error', remote, `remote audit failed rc=${proc.status} stderr=${stderr}`)];
  }
  try {
    return JSON.parse(proc.stdout) as CriticalSurfaceObservations;
  } catch (error) {
    return [issue('remote', 'remote-error', remote, `remote audit returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)];
  }
}

function printIssues(issues: CriticalSurfaceIssue[]): void {
  for (const current of issues) {
    console.error(`FAIL ${current.surface} ${current.kind}: ${current.message}`);
  }
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): CriticalSurfaceIssue[] {
  const options = parseArgs(argv, cwd);
  const manifest = loadRuntimeManifest(cwd, options.manifestPath);
  const profile = loadHealthProfile(cwd, options.profilePath);
  const observationsOrIssues = options.remote
    ? collectRemoteObservations(options.remote, remoteProbeScript(manifest, profile, options.repoRoot ?? ''))
    : collectLocalObservations(cwd, manifest, profile, options.home ?? env.HOME ?? '');
  const issues = Array.isArray(observationsOrIssues)
    ? observationsOrIssues
    : evaluateCriticalSurfaces(manifest, observationsOrIssues);
  if (options.json) {
    console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
  } else if (issues.length === 0) {
    console.log(`bot-errors critical surface audit passed (${options.remote ? `remote=${options.remote}` : 'local'})`);
  } else {
    printIssues(issues);
  }
  if (issues.length > 0) process.exitCode = 1;
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
