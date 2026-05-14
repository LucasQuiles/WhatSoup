#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ParsedArgs {
  help: boolean;
  includeTests: boolean;
  json: boolean;
  staged: boolean;
  write: boolean;
  paths: string[];
}

export interface AnonymizedReplacement {
  code: string;
  count: number;
  fingerprint: string;
  replacement: string;
}

export interface AnonymizedText {
  text: string;
  replacements: AnonymizedReplacement[];
}

interface ReplacementState {
  records: Map<string, AnonymizedReplacement>;
  counters: Map<string, number>;
  values: Map<string, string>;
}

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const skippedPathPatterns = [
  /^scripts\/repo-hygiene-guard\.ts$/,
  /^scripts\/publication-guard\.ts$/,
  /^scripts\/anonymize-private-literals\.ts$/,
  /^tests\/scripts\/(?:repo-hygiene-guard|publication-guard|anonymize-private-literals)\.test\.ts$/,
];

const privateInstanceLabels = [
  ['mw', '-bot'],
  ['sh', 'android'],
  ['bes', 'bot'],
].map((parts) => parts.join(''));

const privateHostLabels = [
  ['mw', 'lab'],
  ['nuc', 'les'],
  ['ana', 'bot'],
  ['mac', 'lab'],
].map((parts) => parts.join(''));

const privatePineconeProjectIds = [
  ['o6', 'fs', 'xb8'],
  ['nf', '9h', 'zvy'],
].map((parts) => parts.join(''));

function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function gitList(args: string[], cwd: string): string[] {
  const output = execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  return output ? output.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean) : [];
}

function isTextCandidate(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const baseName = path.basename(normalized);
  if (baseName === 'Dockerfile' || baseName.startsWith('.env')) return true;
  return textExtensions.has(path.extname(normalized));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function nextSynthetic(state: ReplacementState, code: string, prefix: string, suffix = ''): string {
  const next = (state.counters.get(code) ?? 0) + 1;
  state.counters.set(code, next);
  return `${prefix}${String(next).padStart(4, '0')}${suffix}`;
}

function replacementFor(
  state: ReplacementState,
  code: string,
  original: string,
  createReplacement: () => string,
): string {
  const key = `${code}\0${original}`;
  const existing = state.values.get(key);
  if (existing) {
    const record = state.records.get(`${code}\0${fingerprint(original)}\0${existing}`);
    if (record) record.count += 1;
    return existing;
  }

  const replacement = createReplacement();
  state.values.set(key, replacement);
  state.records.set(`${code}\0${fingerprint(original)}\0${replacement}`, {
    code,
    count: 1,
    fingerprint: fingerprint(original),
    replacement,
  });
  return replacement;
}

function replacePattern(
  text: string,
  state: ReplacementState,
  code: string,
  regex: RegExp,
  createReplacement: (match: RegExpMatchArray) => string,
): string {
  return text.replace(regex, (...args: unknown[]) => {
    const original = String(args[0]);
    const groups = args.slice(1, -2) as string[];
    const match = [original, ...groups] as RegExpMatchArray;
    return replacementFor(state, code, original, () => createReplacement(match));
  });
}

export function anonymizeText(text: string): AnonymizedText {
  const state: ReplacementState = {
    records: new Map(),
    counters: new Map(),
    values: new Map(),
  };

  let next = text;

  next = replacePattern(
    next,
    state,
    'local-home-path',
    /\/(?:Users|home)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+(?=\/|$)/g,
    () => '/home/whatsoup',
  );

  next = replacePattern(
    next,
    state,
    'whatsapp-group-jid',
    /\b120363\d{6,}@g\.us\b/g,
    () => nextSynthetic(state, 'whatsapp-group-jid', '111111100000000', '@g.us'),
  );

  next = replacePattern(
    next,
    state,
    'whatsapp-user-jid',
    /\b(?!(?:1555\d{4,}|1111111\d+|9990\d+)@(s\.whatsapp\.net|lid)\b)\d{8,}@(s\.whatsapp\.net|lid)\b/g,
    (match) => match[0].endsWith('@lid')
      ? nextSynthetic(state, 'whatsapp-lid-jid', '9990000', '@lid')
      : nextSynthetic(state, 'whatsapp-user-jid', '1555555', '@s.whatsapp.net'),
  );

  next = replacePattern(
    next,
    state,
    'phone-like-id',
    /\b1(?!555)\d{10}\b/g,
    () => nextSynthetic(state, 'phone-like-id', '1555555'),
  );

  next = replacePattern(
    next,
    state,
    'private-instance-label',
    new RegExp(`\\b(?:${privateInstanceLabels.map(escapeRegExp).join('|')})\\b`, 'gi'),
    () => 'test-agent',
  );

  next = replacePattern(
    next,
    state,
    'private-host-label',
    new RegExp(`\\b(?:${privateHostLabels.map(escapeRegExp).join('|')})\\b`, 'gi'),
    () => 'test-host',
  );

  next = replacePattern(
    next,
    state,
    'pinecone-project-id',
    new RegExp(`\\b(?:${privatePineconeProjectIds.map(escapeRegExp).join('|')})\\b`, 'gi'),
    () => 'project-placeholder',
  );

  next = replacePattern(next, state, 'github-token', /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, () => '<github-token>');
  next = replacePattern(next, state, 'openai-key', /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/g, () => '<openai-key>');
  next = replacePattern(next, state, 'pinecone-key', /\bpcsk_[A-Za-z0-9_-]{12,}\b/g, () => '<pinecone-key>');
  next = replacePattern(next, state, 'slack-token', /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, () => '<slack-token>');
  next = replacePattern(next, state, 'anthropic-key', /\bsk-ant-[a-zA-Z0-9_-]{32,}\b/g, () => '<anthropic-key>');
  next = replacePattern(next, state, 'stripe-key', /\b(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{20,}\b/g, () => '<stripe-key>');
  next = replacePattern(next, state, 'twilio-account-sid', /\bAC[a-f0-9]{32}\b/g, () => '<twilio-account-sid>');
  next = replacePattern(next, state, 'huggingface-token', /\bhf_[a-zA-Z0-9]{20,}\b/g, () => '<huggingface-token>');
  next = replacePattern(next, state, 'jwt-token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, () => '<jwt-token>');
  next = replacePattern(next, state, 'bearer-token', /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]{40,}\b/gi, () => 'Authorization: Bearer <bearer-token>');
  next = replacePattern(next, state, 'aws-secret', /((?:SECRET|AWS)[_A-Z]*[=:]\s*)([A-Za-z0-9/+=]{40})\b/g, (match) => `${match[1]}<aws-secret>`);
  next = replacePattern(next, state, 'private-key', /\b(BEGIN|END) (?:RSA |OPENSSH |EC )?PRIVATE KEY\b/g, (match) => `${match[1]} REDACTED PRIVATE KEY`);

  return {
    text: next,
    replacements: [...state.records.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    help: false,
    includeTests: false,
    json: false,
    staged: false,
    write: false,
    paths: [],
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--include-tests') args.includeTests = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--staged') args.staged = true;
    else if (arg === '--write') args.write = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else args.paths.push(normalizeRepoPath(arg));
  }

  return args;
}

function listPathCandidates(cwd: string, args: ParsedArgs): string[] {
  if (args.paths.length === 0) {
    return args.staged
      ? gitList(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], cwd)
      : gitList(['ls-files'], cwd);
  }

  const tracked = new Set(gitList(['ls-files', '--', ...args.paths], cwd));
  for (const filePath of args.paths) {
    const fullPath = path.join(cwd, filePath);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).isFile()) tracked.add(normalizeRepoPath(filePath));
  }
  return [...tracked];
}

function listCandidateFiles(cwd: string, args: ParsedArgs): string[] {
  return [...new Set(listPathCandidates(cwd, args))]
    .map(normalizeRepoPath)
    .filter((filePath) => isTextCandidate(filePath))
    .filter((filePath) => args.includeTests || !filePath.startsWith('tests/'))
    .filter((filePath) => !skippedPathPatterns.some((pattern) => pattern.test(filePath)))
    .filter((filePath) => existsSync(path.join(cwd, filePath)))
    .sort();
}

function run(argv = process.argv.slice(2), cwd = process.cwd()): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  const changes = [];
  for (const filePath of listCandidateFiles(cwd, args)) {
    const fullPath = path.join(cwd, filePath);
    const original = readFileSync(fullPath, 'utf8');
    const anonymized = anonymizeText(original);
    if (anonymized.replacements.length === 0) continue;

    changes.push({ filePath, replacements: anonymized.replacements });
    if (args.write) writeFileSync(fullPath, anonymized.text);
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: changes.length === 0, write: args.write, files: changes.length, changes }, null, 2));
  } else if (changes.length === 0) {
    console.log('No private literals found by anonymizer.');
  } else {
    console.log(`${args.write ? 'Anonymized' : 'Would anonymize'} ${changes.length} file(s):`);
    for (const change of changes) {
      const summary = change.replacements.map((replacement) => `${replacement.code}=${replacement.count}`).join(', ');
      console.log(`  ${change.filePath}: ${summary}`);
    }
    if (!args.write) console.log('Run again with --write to update files.');
  }

  return args.write || changes.length === 0 ? 0 : 1;
}

function printHelp(): void {
  console.log(`Usage: npm run leaks:anonymize -- [--write] [--staged] [--include-tests] [--json] [paths...]

Default mode is report-only and exits non-zero when replacements are available.
Reports never print original private values; fingerprints are short hashes for correlation.`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  process.exitCode = run();
}
