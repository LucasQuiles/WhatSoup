import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../src/lib/type-guards.ts';

const POLICY_PATH = 'requirements/python/lock-policy.json';
const EXPECTED_RUNTIME = { implementation: 'cpython', version: '3.13.16' } as const;
const EXPECTED_INDEX = 'https://pypi.org/simple';
const EXCLUDED_TOP_LEVEL = new Set(['.git', 'coverage', 'dist', 'docs', 'node_modules', 'tests']);
const EXCLUDED_PREFIXES = [
  'console/node_modules/',
  'tools/agent-runtime-probes/',
];

interface LockPolicy {
  schemaVersion: number;
  runtime: { implementation: string; version: string };
  indexUrl: string;
  locks: Record<string, Record<string, string>>;
}

interface Violation {
  code: string;
  path: string;
  detail: string;
}

function asRepoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function isSafeLockPath(path: string): boolean {
  return path.length > 0
    && !isAbsolute(path)
    && !path.split(/[\\/]/).includes('..')
    && !path.includes('\0');
}

function loadPolicy(root: string, violations: Violation[]): LockPolicy | null {
  const policyPath = resolve(root, POLICY_PATH);
  if (!existsSync(policyPath)) {
    violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: 'missing policy' });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch {
    violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: 'invalid JSON' });
    return null;
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || !isRecord(parsed.runtime)
    || parsed.runtime.implementation !== EXPECTED_RUNTIME.implementation
    || parsed.runtime.version !== EXPECTED_RUNTIME.version
    || parsed.indexUrl !== EXPECTED_INDEX
    || !isRecord(parsed.locks)) {
    violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: 'unexpected schema or runtime' });
    return null;
  }

  const locks: Record<string, Record<string, string>> = {};
  for (const [profile, targets] of Object.entries(parsed.locks)) {
    if (!isRecord(targets) || Object.keys(targets).length === 0) {
      violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: `profile ${profile} has no targets` });
      continue;
    }
    locks[profile] = {};
    for (const [target, lockPath] of Object.entries(targets)) {
      if (!/^(linux|darwin)-(x64|arm64)$/.test(target) || typeof lockPath !== 'string' || !isSafeLockPath(lockPath)) {
        violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: `invalid lock target ${profile}/${target}` });
        continue;
      }
      locks[profile]![target] = lockPath;
    }
  }
  if (Object.keys(locks).length === 0) return null;
  return {
    schemaVersion: 1,
    runtime: EXPECTED_RUNTIME,
    indexUrl: EXPECTED_INDEX,
    locks,
  };
}

function declaredLockPaths(policy: LockPolicy): Set<string> {
  return new Set(Object.values(policy.locks).flatMap((targets) => Object.values(targets)));
}

function logicalLines(text: string): string[] {
  return text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
}

function validateLock(root: string, lockPath: string, violations: Violation[]): void {
  const absolute = resolve(root, lockPath);
  if (!absolute.startsWith(`${resolve(root)}${sep}`) || !existsSync(absolute)) {
    violations.push({ code: 'python-lock-malformed', path: lockPath, detail: 'declared lock is missing' });
    return;
  }

  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    violations.push({ code: 'python-lock-malformed', path: lockPath, detail: 'lock is unreadable' });
    return;
  }
  let packageCount = 0;
  for (const [index, raw] of logicalLines(text).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^(--(?:index-url|extra-index-url|find-links|trusted-host|no-index)|-e\b|--editable\b)/.test(line)
      || /(?:git\+|https?:\/\/|file:|\.\.\/|^\/)/.test(line)) {
      violations.push({ code: 'python-lock-malformed', path: lockPath, detail: `unsafe source at line ${index + 1}` });
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*==[A-Za-z0-9][A-Za-z0-9_.+!~-]*(?:\s|;|$)/.test(line)
      || !/(?:^|\s)--hash=sha256:[a-f0-9]{64}(?:\s|$)/.test(line)) {
      violations.push({ code: 'python-lock-malformed', path: lockPath, detail: `exact pin and SHA-256 hash required at line ${index + 1}` });
      continue;
    }
    packageCount += 1;
  }
  if (packageCount === 0) {
    violations.push({ code: 'python-lock-malformed', path: lockPath, detail: 'lock has no packages' });
  }
}

function walk(root: string, directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const repoPath = asRepoPath(root, absolute);
    if (repoPath === 'scripts/python-dependency-lock-guard.ts'
      || EXCLUDED_PREFIXES.some((prefix) => repoPath.startsWith(prefix))) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_TOP_LEVEL.has(entry.name)) walk(root, absolute, paths);
      continue;
    }
    if (entry.isFile()) paths.push(absolute);
  }
}

function commandAfterInstall(source: string, offset: number): string {
  const command = source.slice(offset);
  const end = command.search(/[\n;|&]/);
  return end === -1 ? command : command.slice(0, end);
}

function findInstallCommands(text: string): string[] {
  const commands: string[] = [];
  for (const line of logicalLines(text)) {
    if (line.trimStart().startsWith('#')) continue;
    const modulePattern = /(?:^|[\s:;|&])-m\s+pip\s+install\b/gi;
    const directPattern = /(?:^|[;|&]\s*|\brun:\s*|\bsudo\s+|\benv(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+)(?:["']?[A-Za-z0-9_${}./-]*\/)?pip(?:3(?:\.\d+)?)?["']?\s+install\b/gi;
    for (const pattern of [modulePattern, directPattern]) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        commands.push(commandAfterInstall(line, match.index));
      }
    }
  }
  return commands;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function validateInstallCommand(
  sourcePath: string,
  command: string,
  policy: LockPolicy,
  allowedLocks: Set<string>,
  violations: Violation[],
): void {
  const hasHashes = /(?:^|\s)--require-hashes(?:\s|$)/.test(command);
  const binaryOnly = /--only-binary(?:=|\s+):all:(?:\s|$)/.test(command);
  const index = command.match(/--index-url(?:=|\s+)([^\s;|&]+)/)?.[1];
  const requirement = command.match(/(?:-r|--requirement)(?:=|\s+)([^\s;|&]+)/)?.[1];
  const unsafeIndex = /--(?:extra-index-url|find-links|trusted-host|no-index)(?:=|\s|$)/.test(command);
  const dynamicLibraryRequirement = sourcePath === 'deploy/lib/python-lock-policy.sh'
    && /(?:-r|--requirement)(?:=|\s+)["']?\$lock_path["']?(?:\s|$)/.test(command);
  const requirementPath = requirement ? stripQuotes(requirement) : '';

  if (!hasHashes || !binaryOnly || index !== policy.indexUrl || unsafeIndex
    || (!dynamicLibraryRequirement && (!allowedLocks.has(requirementPath) || !isSafeLockPath(requirementPath)))) {
    violations.push({
      code: 'python-install-unlocked',
      path: sourcePath,
      detail: 'pip install must use the declared hash-locked binary-only requirement with the controlled index',
    });
  }
}

export function scanPythonDependencyLocks(rootInput = process.cwd()): Violation[] {
  const root = resolve(rootInput);
  const violations: Violation[] = [];
  const policy = loadPolicy(root, violations);
  if (!policy) return violations;
  const locks = declaredLockPaths(policy);
  for (const lockPath of locks) validateLock(root, lockPath, violations);

  const files: string[] = [];
  walk(root, root, files);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const sourcePath = asRepoPath(root, file);
    for (const command of findInstallCommands(text)) {
      validateInstallCommand(sourcePath, command, policy, locks, violations);
    }
  }
  return violations;
}

function parseRoot(args: readonly string[]): string | null {
  if (args.length === 0) return process.cwd();
  if (args.length === 2 && args[0] === '--root' && args[1]) return args[1]!;
  return null;
}

export function runPythonDependencyLockGuard(args: readonly string[]): number {
  const root = parseRoot(args);
  if (root === null) {
    process.stderr.write('Usage: python-dependency-lock-guard.ts [--root <path>]\n');
    return 2;
  }
  const violations = scanPythonDependencyLocks(root);
  for (const violation of violations) {
    process.stderr.write(`${violation.code}: ${violation.path}: ${violation.detail}\n`);
  }
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPythonDependencyLockGuard(process.argv.slice(2));
}
