import { closeSync, constants, existsSync, fstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../src/lib/type-guards.ts';

const POLICY_PATH = 'requirements/python/lock-policy.json';
const EXPECTED_RUNTIME = { implementation: 'cpython', version: '3.13.16' } as const;
const EXPECTED_INDEX = 'https://pypi.org/simple';
const LOCK_PROFILES = ['quality', 'transcription'] as const;
const LOCK_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const;
const EXCLUDED_TOP_LEVEL = new Set(['.git', 'coverage', 'dist', 'docs', 'node_modules', 'tests']);
const EXCLUDED_PREFIXES = [
  'console/node_modules/',
  'tools/agent-runtime-probes/',
];
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 64;

interface ScanBudget {
  bytes: number;
  entries: number;
}

class ScanError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, detail: string) {
    super(detail);
    this.code = code;
    this.path = path;
  }
}

function readBoundedText(root: string, path: string, budget: ScanBudget): string {
  const repoPath = asRepoPath(root, path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile()) throw new ScanError('python-lock-scan-input', repoPath, 'not a regular file');
    if (info.size > MAX_FILE_BYTES) {
      throw new ScanError('python-lock-scan-limit', repoPath, 'file bytes exceed 4 MiB');
    }
    if (budget.bytes + info.size > MAX_TOTAL_BYTES) {
      throw new ScanError('python-lock-scan-limit', repoPath, 'total bytes exceed 64 MiB');
    }
    const data = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < data.length) {
      const count = readSync(fd, data, used, data.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used !== info.size) {
      throw new ScanError('python-lock-scan-input', repoPath, 'file size changed during read');
    }
    budget.bytes += used;
    return data.subarray(0, used).toString('utf8');
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('python-lock-scan-input', repoPath, 'file is unreadable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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

function loadPolicy(root: string, violations: Violation[], budget: ScanBudget): LockPolicy | null {
  const policyPath = resolve(root, POLICY_PATH);
  if (!existsSync(policyPath)) {
    violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: 'missing policy' });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedText(root, policyPath, budget));
  } catch (error) {
    if (error instanceof ScanError) throw error;
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

  if (Object.keys(parsed.locks).length !== LOCK_PROFILES.length) {
    violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: 'incomplete or unsupported installer profiles' });
    return null;
  }
  const locks: Record<string, Record<string, string>> = {};
  for (const profile of LOCK_PROFILES) {
    const targets = parsed.locks[profile];
    if (!isRecord(targets) || Object.keys(targets).length !== LOCK_TARGETS.length) {
      violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: `incomplete or unsupported targets for ${profile}` });
      return null;
    }
    locks[profile] = {};
    for (const target of LOCK_TARGETS) {
      const lockPath = `requirements/python/${profile}-cpython313-${target}.txt`;
      if (targets[target] !== lockPath) {
        violations.push({ code: 'python-lock-policy-invalid', path: POLICY_PATH, detail: `invalid lock target ${profile}/${target}` });
        return null;
      }
      locks[profile]![target] = lockPath;
    }
  }
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
  return text.replace(/\\\r?\n/g, '').split(/\r?\n/);
}

function validateLock(root: string, lockPath: string, violations: Violation[], budget: ScanBudget): void {
  const absolute = resolve(root, lockPath);
  if (!absolute.startsWith(`${resolve(root)}${sep}`) || !existsSync(absolute)) {
    violations.push({ code: 'python-lock-malformed', path: lockPath, detail: 'declared lock is missing' });
    return;
  }

  const text = readBoundedText(root, absolute, budget);
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

function* walk(root: string, directory: string, budget: ScanBudget, depth = 0): Generator<string> {
  if (depth > MAX_DEPTH) {
    throw new ScanError('python-lock-scan-limit', asRepoPath(root, directory), 'directory depth exceeds 64');
  }
  const handle = opendirSync(directory);
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      budget.entries += 1;
      if (budget.entries > MAX_ENTRIES) {
        throw new ScanError('python-lock-scan-limit', asRepoPath(root, directory), 'directory entries exceed 10000');
      }
      const absolute = resolve(directory, entry.name);
      const repoPath = asRepoPath(root, absolute);
      if (repoPath === 'scripts/python-dependency-lock-guard.ts'
        || EXCLUDED_PREFIXES.some((prefix) => repoPath.startsWith(prefix))) continue;
      if (entry.isSymbolicLink()) {
        if (EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
        throw new ScanError('python-lock-scan-input', repoPath, 'symbolic link in scanned source');
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_TOP_LEVEL.has(entry.name)) yield* walk(root, absolute, budget, depth + 1);
      } else if (entry.isFile()) {
        yield absolute;
      }
    }
  } finally {
    handle.closeSync();
  }
}

function commandAfterInstall(source: string, offset: number): string {
  const command = source.slice(offset);
  const end = command.search(/[\n;|&]/);
  return end === -1 ? command : command.slice(0, end);
}

const PIP_GLOBAL_VALUE_OPTIONS = new Set([
  '--python', '--log', '--keyring-provider', '--proxy', '--retries', '--timeout',
  '--exists-action', '--trusted-host', '--cert', '--client-cert', '--cache-dir',
  '--use-feature', '--use-deprecated', '--resume-retries',
]);

function staticShellWord(word: string): string | null {
  let quote = '';
  let value = '';
  for (const char of word) {
    if (char === quote) {
      quote = '';
    } else if (quote === "'") {
      value += char;
    } else if (char === '$' || char === '`' || char === '\\') {
      return null;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
    } else {
      value += char;
    }
  }
  return quote ? null : value;
}

function pipSubcommand(argumentsText: string): string | null | undefined {
  const words = (argumentsText.match(/(?:[^\s"']+|"[^"\n]*"|'[^'\n]*')+/g) ?? []).map(staticShellWord);
  let index = 0;
  while (words[index]?.startsWith('-')) {
    const option = words[index]!;
    index += PIP_GLOBAL_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  return words[index];
}

function shellWordEnd(line: string, start: number): number {
  const closing: string[] = [];
  for (let index = start; index < line.length; index += 1) {
    const char = line[index]!;
    const current = closing.at(-1);
    if (char === '\\' && current !== "'") {
      index += 1;
    } else if (current === "'") {
      if (char === "'") closing.pop();
    } else if (char === '$' && (line[index + 1] === '(' || line[index + 1] === '{')) {
      closing.push(line[index + 1] === '(' ? ')' : '}');
      index += 1;
    } else if ((char === '<' || char === '>') && line[index + 1] === '(' && current !== '"') {
      closing.push(')');
      index += 1;
    } else if (char === current) {
      closing.pop();
    } else if ((char === '"' || char === "'" || char === '`') && current !== '"' && current !== '`') {
      closing.push(char);
    } else if (char === '`' && current === '"') {
      closing.push(char);
    } else if (char === '(' && current === ')') {
      closing.push(')');
    } else if (/\s/.test(char) && closing.length === 0) {
      return index;
    }
  }
  return line.length;
}

function skipInvocationPrefixes(line: string, start: number): number {
  let offset = start;
  const nextWord = (): string => {
    while (offset < line.length && /\s/.test(line[offset]!)) offset += 1;
    return line.slice(offset, shellWordEnd(line, offset));
  };
  const consumeWord = (): void => { offset = shellWordEnd(line, offset); };
  while (offset < line.length) {
    const word = nextWord();
    if (['if', 'elif', 'then', 'else', 'while', 'until', 'do', '!'].includes(word)) {
      consumeWord();
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      consumeWord();
      continue;
    }
    if (!['command', 'exec', 'nohup', 'time', 'env'].includes(word)) break;
    consumeWord();
    while (nextWord().startsWith('-')) {
      const option = nextWord();
      consumeWord();
      if (option === '--') break;
      if (word === 'env') {
        if (['-', '-i', '--ignore-environment'].includes(option)) continue;
        if (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(option)) {
          if (!nextWord()) return -1;
          consumeWord();
          continue;
        }
        if (/^(?:-[uCa].+|--(?:unset|chdir|argv0)=.+)$/.test(option)) continue;
        // Split-string and unknown options cannot be safely resolved by this scanner.
        return -1;
      }
      if ((word === 'command' || word === 'time') && /^-p+$/.test(option)) continue;
      if (word === 'exec' && /^-[cl]+$/.test(option)) continue;
      if (word === 'exec') {
        const namedProcess = option.match(/^-[cl]*a(.*)$/);
        if (namedProcess) {
          if (namedProcess[1]) continue;
          if (!nextWord()) return line.length;
          consumeWord();
          continue;
        }
      }
      // Do not treat lookup arguments or unrecognized option values as commands.
      return line.length;
    }
  }
  nextWord();
  return offset;
}

function findInstallCommands(text: string, depth = 0): string[] {
  const commands: string[] = [];
  for (const line of logicalLines(text)) {
    if (line.trimStart().startsWith('#')) continue;
    const modulePattern = /(?:^|[\s:;|&])-m\s+pip(?=\s)/gi;
    for (const match of line.matchAll(modulePattern)) {
      const argumentsText = commandAfterInstall(line, match.index + match[0].length);
      const subcommand = pipSubcommand(argumentsText);
      if (subcommand === 'install') commands.push(commandAfterInstall(line, match.index));
      else if (depth > 0 && subcommand === null) commands.push('pip install');
    }
    const starts = /(?:[;|&]\s*|\brun:\s*|\bsudo\s+|\benv\s+)/gi;
    for (const start of [0, ...Array.from(line.matchAll(starts), (prefix) => prefix.index + prefix[0].length)]) {
      const offset = skipInvocationPrefixes(line, start);
      if (offset === -1) {
        if (/pip/i.test(line)) commands.push('pip install');
        continue;
      }
      const executableEnd = shellWordEnd(line, offset);
      const executable = staticShellWord(line.slice(offset, executableEnd));
      if (executable && /^(?:[A-Za-z0-9_./-]*\/)?(?:sh|bash|dash|zsh|ksh)$/.test(executable)) {
        let cursor = executableEnd;
        const word = (): string => {
          while (/\s/.test(line[cursor] ?? '') && cursor < line.length) cursor += 1;
          const end = shellWordEnd(line, cursor);
          const value = line.slice(cursor, end);
          cursor = end;
          return value;
        };
        for (let option = word(); option.startsWith('-'); option = word()) {
          if (['-o', '-O', '--rcfile', '--init-file'].includes(option)) {
            word();
            continue;
          }
          if (/^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
            const body = staticShellWord(word());
            if (body !== null && depth < 16) {
              commands.push(...findInstallCommands(body, depth + 1));
            } else if (/pip/i.test(line)) {
              commands.push('pip install');
            }
            break;
          }
          if (!/^-[abefhiklmnprstuvxBCEHPT]+$/.test(option)
              && !['--norc', '--noprofile', '--posix', '--restricted', '--verbose', '--login'].includes(option)) {
            if (/pip/i.test(line)) commands.push('pip install');
            break;
          }
        }
        continue;
      }
      const pip = line.slice(offset).match(/^["']?(?:[A-Za-z0-9_${}./-]*\/)?pip(?:3(?:\.\d+)?)?["']?(?=\s)/i);
      const literalPip = executable && /^(?:[A-Za-z0-9_./-]*\/)?pip(?:3(?:\.\d+)?)?$/i.test(executable);
      if (!literalPip && !pip) continue;
      const argumentsText = commandAfterInstall(line, literalPip ? executableEnd : offset + pip![0].length);
      const subcommand = pipSubcommand(argumentsText);
      if (subcommand === 'install') commands.push(commandAfterInstall(line, offset));
      else if (depth > 0 && subcommand === null) commands.push('pip install');
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
  const budget: ScanBudget = { bytes: 0, entries: 0 };
  try {
    const policy = loadPolicy(root, violations, budget);
    if (!policy) return violations;
    const locks = declaredLockPaths(policy);
    for (const lockPath of locks) validateLock(root, lockPath, violations, budget);

    for (const file of walk(root, root, budget)) {
      const text = readBoundedText(root, file, budget);
      const sourcePath = asRepoPath(root, file);
      for (const command of findInstallCommands(text)) {
        validateInstallCommand(sourcePath, command, policy, locks, violations);
      }
    }
  } catch (error) {
    violations.push(error instanceof ScanError
      ? { code: error.code, path: error.path, detail: error.message }
      : { code: 'python-lock-scan-input', path: '.', detail: 'directory traversal failed' });
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
