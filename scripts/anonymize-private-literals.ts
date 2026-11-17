#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeRegExp } from '../src/lib/regex-utils.ts';
import { cleanGitEnv, normalizeRepoPath } from './lib/guard-core.ts';
import { maskPrivateText } from './lib/repo-hygiene-boundary.ts';
import {
  PRIVATE_TERMS_ABSENT_NOTICE,
  PrivateTermsError,
  loadPrivateTerms,
  requirePrivateTermsUsable,
  type PrivateTermRule,
} from './lib/private-terms.ts';

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
  /** The term id, for a replacement taken from the private term file; absent for the built-in rewrites. */
  term?: string;
  count: number;
  fingerprint: string;
  replacement: string;
}

export interface AnonymizedRefusal {
  code: string;
  count: number;
  reason: 'would-create-mention' | 'would-re-emit-term';
}

export interface AnonymizedText {
  text: string;
  replacements: AnonymizedReplacement[];
  /** Replacements left undone: they would have created a new `@login` mention or put a term back. */
  refused: AnonymizedRefusal[];
}

interface ReplacementState {
  records: Map<string, AnonymizedReplacement>;
  counters: Map<string, number>;
  values: Map<string, string>;
  /** Lower-cased logins the original text already mentions. */
  mentions: ReadonlySet<string>;
  refused: Map<string, AnonymizedRefusal>;
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

// Fallback lists: they run with or without a private term file.
// TODO(PB2): remove these lists once the term-aware hosted check is required.
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

function gitList(args: string[], cwd: string): string[] {
  const output = execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv(), timeout: 30_000 }).trim();
  return output ? output.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean) : [];
}

function isTextCandidate(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const baseName = path.basename(normalized);
  if (baseName === 'Dockerfile' || baseName.startsWith('.env')) return true;
  return textExtensions.has(path.extname(normalized));
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function nextSynthetic(state: ReplacementState, code: string, prefix: string, suffix = ''): string {
  const next = (state.counters.get(code) ?? 0) + 1;
  state.counters.set(code, next);
  return `${prefix}${String(next).padStart(4, '0')}${suffix}`;
}

interface Candidate {
  /** The span the match claims: a context term claims its context text as well. */
  readonly start: number;
  readonly end: number;
  /** The span the replacement rewrites, inside the claim. */
  readonly from: number;
  readonly to: number;
  /** Rule order: term rules come first, so a term wins a tie with a built-in rewrite. */
  readonly order: number;
  readonly code: string;
  readonly term: PrivateTermRule | null;
  readonly match: RegExpMatchArray;
  readonly create: ((match: RegExpMatchArray) => string) | null;
}

interface BuiltInRewrite {
  readonly code: string;
  readonly regex: RegExp;
  readonly create: (match: RegExpMatchArray) => string;
}

// The cache and the records are keyed by rule code (built-in rewrites) or by term id and match
// mode (term-file replacements), plus the original text: two terms sharing a value keep their
// own replacements.
function recordReplacement(state: ReplacementState, candidate: Candidate, key: string, original: string, replacement: string): void {
  state.values.set(key, replacement);
  const record = state.records.get(key);
  if (record !== undefined) {
    record.count += 1;
    return;
  }
  state.records.set(key, {
    code: candidate.code,
    ...(candidate.term === null ? {} : { term: candidate.term.termId }),
    count: 1,
    fingerprint: fingerprint(original),
    replacement,
  });
}

function globalCopy(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
}

function collectCandidates(text: string, termRules: readonly PrivateTermRule[], rewrites: readonly BuiltInRewrite[]): Candidate[] {
  const candidates: Candidate[] = [];
  const add = (match: RegExpMatchArray, order: number, code: string, term: PrivateTermRule | null, create: Candidate['create']): void => {
    if (match[0] === '') return;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const from = term === null ? start : start + term.contextBefore;
    const to = term === null ? end : end - term.contextAfter;
    candidates.push({ start, end, from, to, order, code, term, match, create });
  };
  termRules.forEach((rule, order) => {
    for (const match of text.matchAll(globalCopy(rule.regex))) add(match, order, rule.code, rule, null);
  });
  rewrites.forEach((rewrite, index) => {
    for (const match of text.matchAll(globalCopy(rewrite.regex))) add(match, termRules.length + index, rewrite.code, null, rewrite.create);
  });
  return candidates;
}

// Across every term and built-in rewrite the longest claim wins, then the earlier start, then
// the earlier rule (terms first). Claims never overlap.
function selectCandidates(candidates: readonly Candidate[]): Candidate[] {
  const ranked = [...candidates].sort((left, right) =>
    (right.end - right.start) - (left.end - left.start) || left.start - right.start || left.order - right.order);
  const taken: Candidate[] = [];
  for (const candidate of ranked) {
    if (taken.every((other) => candidate.end <= other.start || other.end <= candidate.start)) taken.push(candidate);
  }
  return taken.sort((left, right) => left.start - right.start);
}

// `{N}` is group N of the term's own match in every match mode (each compiled form keeps the
// core's group numbers); a group the match lacks expands to nothing.
function expandTerm(rule: PrivateTermRule, match: RegExpMatchArray): string {
  return rule.replace.replace(/\{([1-9])\}/g, (_whole, digit: string) => match[Number(digit)] ?? '');
}

const alphanumeric = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

// A replacement that holds the matched value (ignoring case and punctuation) publishes it again.
// Values under three letters and digits would match inside ordinary replacement words; the rescan
// in anonymizeText covers them.
function reEmitsValue(original: string, replacement: string): boolean {
  const value = alphanumeric(original);
  return value.length >= 3 && alphanumeric(replacement).includes(value);
}

/** Term hits in `output` that touch a replaced span: a replacement, alone or with its neighbours, put a term back. */
function reintroducedTermHits(
  output: string,
  termRules: readonly PrivateTermRule[],
  placed: ReadonlyArray<readonly [number, number]>,
): number {
  let count = 0;
  for (const rule of termRules) {
    for (const match of output.matchAll(globalCopy(rule.regex))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (placed.some(([from, to]) => start <= to && end >= from)) count += 1;
    }
  }
  return count;
}

// GitHub notifies the owner of every `@login` it finds, so a replacement must never create a
// mention the original text did not have. A mention is `@` plus a login-shaped word with no word
// character before the `@` (`name@host` is not one); logins compare case-insensitively.
const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*)/g;
// A login is at most 39 characters, so this much text on each side covers any mention that
// touches a replacement.
const MENTION_WINDOW = 41;

function mentionsIn(text: string): Set<string> {
  return new Set([...text.matchAll(MENTION)].map((mention) => mention[1]!.toLowerCase()));
}

function createsMention(
  input: string,
  offset: number,
  original: string,
  replacement: string,
  known: ReadonlySet<string>,
): boolean {
  const left = input.slice(Math.max(0, offset - MENTION_WINDOW), offset);
  const right = input.slice(offset + original.length, offset + original.length + MENTION_WINDOW);
  const window = `${left}${replacement}${right}`;
  const from = left.length;
  const to = left.length + replacement.length;
  for (const mention of window.matchAll(MENTION)) {
    const at = mention.index ?? 0;
    if (at <= to && at + mention[0].length >= from && !known.has(mention[1]!.toLowerCase())) return true;
  }
  return false;
}

// With a loaded term file, its terms join the built-in rewrites in one pass over the original
// text: the longest match wins, then the earlier start (a term's context counts toward its
// length, and a context term replaces only the term inside its context). Each term is replaced
// by its own `replace` value. Without a term file, behaviour is unchanged.
export function anonymizeText(text: string, termRules: readonly PrivateTermRule[] = []): AnonymizedText {
  const state: ReplacementState = {
    records: new Map(),
    counters: new Map(),
    values: new Map(),
    mentions: mentionsIn(text),
    refused: new Map(),
  };
  const synthetic = (code: string, prefix: string, suffix = '') => (): string => nextSynthetic(state, code, prefix, suffix);
  const rewrites: BuiltInRewrite[] = [
    {
      code: 'local-home-path',
      regex: /\/(?:Users|home)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+(?=\/|$)/g,
      create: () => '/home/whatsoup',
    },
    { code: 'whatsapp-group-jid', regex: /\b120363\d{6,}@g\.us\b/g, create: synthetic('whatsapp-group-jid', '111111100000000', '@g.us') },
    {
      code: 'whatsapp-user-jid',
      regex: /\b(?!(?:1555\d{4,}|1111111\d+|9990\d+)@(s\.whatsapp\.net|lid)\b)\d{8,}@(s\.whatsapp\.net|lid)\b/g,
      create: (match) => match[0].endsWith('@lid')
        ? nextSynthetic(state, 'whatsapp-lid-jid', '9990000', '@lid')
        : nextSynthetic(state, 'whatsapp-user-jid', '1555555', '@s.whatsapp.net'),
    },
    { code: 'phone-like-id', regex: /\b1(?!555)\d{10}\b/g, create: synthetic('phone-like-id', '1555555') },
    {
      code: 'private-instance-label',
      regex: new RegExp(`\\b(?:${privateInstanceLabels.map(escapeRegExp).join('|')})\\b`, 'gi'),
      create: () => 'test-agent',
    },
    {
      code: 'private-host-label',
      regex: new RegExp(`\\b(?:${privateHostLabels.map(escapeRegExp).join('|')})\\b`, 'gi'),
      create: () => 'test-host',
    },
    {
      code: 'pinecone-project-id',
      regex: new RegExp(`\\b(?:${privatePineconeProjectIds.map(escapeRegExp).join('|')})\\b`, 'gi'),
      create: () => 'project-placeholder',
    },
    { code: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, create: () => '<github-token>' },
    { code: 'openai-key', regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/g, create: () => '<openai-key>' },
    { code: 'pinecone-key', regex: /\bpcsk_[A-Za-z0-9_-]{12,}\b/g, create: () => '<pinecone-key>' },
    { code: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, create: () => '<slack-token>' },
    { code: 'anthropic-key', regex: /\bsk-ant-[a-zA-Z0-9_-]{32,}\b/g, create: () => '<anthropic-key>' },
    { code: 'stripe-key', regex: /\b(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{20,}\b/g, create: () => '<stripe-key>' },
    { code: 'twilio-account-sid', regex: /\bAC[a-f0-9]{32}\b/g, create: () => '<twilio-account-sid>' },
    { code: 'huggingface-token', regex: /\bhf_[a-zA-Z0-9]{20,}\b/g, create: () => '<huggingface-token>' },
    { code: 'jwt-token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, create: () => '<jwt-token>' },
    { code: 'bearer-token', regex: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]{40,}\b/gi, create: () => 'Authorization: Bearer <bearer-token>' },
    { code: 'aws-secret', regex: /((?:SECRET|AWS)[_A-Z]*[=:]\s*)([A-Za-z0-9/+=]{40})\b/g, create: (match) => `${match[1]}<aws-secret>` },
    { code: 'private-key', regex: /\b(BEGIN|END) (?:RSA |OPENSSH |EC )?PRIVATE KEY\b/g, create: (match) => `${match[1]} REDACTED PRIVATE KEY` },
  ];

  const refuse = (code: string, reason: AnonymizedRefusal['reason']): void => {
    const key = `${code}\0${reason}`;
    state.refused.set(key, { code, reason, count: (state.refused.get(key)?.count ?? 0) + 1 });
  };
  let output = '';
  let cursor = 0;
  const placed: Array<readonly [number, number]> = [];
  for (const candidate of selectCandidates(collectCandidates(text, termRules, rewrites))) {
    const original = text.slice(candidate.from, candidate.to);
    const key = candidate.term === null
      ? `rule\0${candidate.code}\0${original}`
      : `term\0${candidate.term.termId}\0${candidate.term.match}\0${original}`;
    const replacement = state.values.get(key)
      ?? (candidate.term !== null ? expandTerm(candidate.term, candidate.match) : candidate.create?.(candidate.match) ?? original);
    if (candidate.term !== null && reEmitsValue(original, replacement)) {
      refuse(candidate.code, 'would-re-emit-term');
      continue;
    }
    if (createsMention(text, candidate.from, original, replacement, state.mentions)) {
      refuse(candidate.code, 'would-create-mention');
      continue;
    }
    recordReplacement(state, candidate, key, original, replacement);
    output += text.slice(cursor, candidate.from);
    placed.push([output.length, output.length + replacement.length]);
    output += replacement;
    cursor = candidate.to;
  }
  output += text.slice(cursor);

  const refused: AnonymizedRefusal[] = [...state.refused.values()]
    .sort((a, b) => a.code.localeCompare(b.code) || a.reason.localeCompare(b.reason));
  // Each replacement is checked on its own; two replacements, or one and its neighbours, could
  // still form a mention or a term together. Then nothing in this text is replaced.
  const created = [...mentionsIn(output)].filter((login) => !state.mentions.has(login)).length;
  if (created > 0) {
    return { text, replacements: [], refused: [...refused, { code: 'mention-guard', count: created, reason: 'would-create-mention' }] };
  }
  const reintroduced = reintroducedTermHits(output, termRules, placed);
  if (reintroduced > 0) {
    return { text, replacements: [], refused: [...refused, { code: 'term-guard', count: reintroduced, reason: 'would-re-emit-term' }] };
  }
  return {
    text: output,
    replacements: [...state.records.values()]
      .sort((a, b) => a.code.localeCompare(b.code) || (a.term ?? '').localeCompare(b.term ?? '')),
    refused,
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

  argv.forEach((arg, index) => {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--include-tests') args.includeTests = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--staged') args.staged = true;
    else if (arg === '--write') args.write = true;
    // An argument can hold a private name: name it by position only.
    else if (arg.startsWith('--')) throw new AnonymizerUsageError(`unknown argument at position ${index + 1}; see --help`);
    else args.paths.push(normalizeRepoPath(arg));
  });

  return args;
}

class AnonymizerUsageError extends Error {}

// The report counts per term id (term-file replacements) or per rule code with the short
// fingerprint (built-in rewrites). It never prints replacement text: that is the operator's own
// and could itself be private.
function reportChange(change: { filePath: string; replacements: AnonymizedReplacement[]; refused: AnonymizedRefusal[] }) {
  const terms = new Map<string, number>();
  const rewrites: Array<{ code: string; count: number; fingerprint: string }> = [];
  for (const replacement of change.replacements) {
    if (replacement.term !== undefined) terms.set(replacement.term, (terms.get(replacement.term) ?? 0) + replacement.count);
    else rewrites.push({ code: replacement.code, count: replacement.count, fingerprint: replacement.fingerprint });
  }
  return {
    filePath: change.filePath,
    replacements: [...[...terms].map(([term, count]) => ({ term, count })), ...rewrites],
    refused: change.refused,
  };
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

export function run(argv = process.argv.slice(2), cwd = process.cwd()): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof AnonymizerUsageError)) throw err;
    console.error(`anonymize-private-literals: ${err.message}`);
    return 2;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  const terms = loadPrivateTerms(process.env);
  let termRules: readonly PrivateTermRule[];
  try {
    termRules = requirePrivateTermsUsable(terms);
  } catch (err) {
    if (!(err instanceof PrivateTermsError)) throw err;
    console.error(err.message);
    return 2;
  }
  if (terms.status === 'absent') console.error(PRIVATE_TERMS_ABSENT_NOTICE);

  const changes = [];
  for (const filePath of listCandidateFiles(cwd, args)) {
    const fullPath = path.join(cwd, filePath);
    const original = readFileSync(fullPath, 'utf8');
    const anonymized = anonymizeText(original, termRules);
    if (anonymized.replacements.length === 0 && anonymized.refused.length === 0) continue;

    // The printed path masks every term or fallback match: a file name can be a private name.
    changes.push({ filePath: maskPrivateText(filePath, termRules), replacements: anonymized.replacements, refused: anonymized.refused });
    // A file with a refused replacement keeps its original text: writing the rest would leave a
    // private literal in a file the run reports as anonymized.
    if (args.write && anonymized.replacements.length > 0 && anonymized.refused.length === 0) {
      writeFileSync(fullPath, anonymized.text);
    }
  }
  const refusedAny = changes.some((change) => change.refused.length > 0);

  if (args.json) {
    console.log(JSON.stringify({ ok: changes.length === 0, write: args.write, files: changes.length, changes: changes.map(reportChange) }, null, 2));
  } else if (changes.length === 0) {
    console.log('No private literals found by anonymizer.');
  } else {
    console.log(`${args.write ? 'Anonymized' : 'Would anonymize'} ${changes.length} file(s):`);
    for (const change of changes) {
      const summary = change.replacements.map((replacement) => `${replacement.code}=${replacement.count}`).join(', ');
      const refusedSummary = change.refused.map((refusal) => `${refusal.code}=${refusal.count}`).join(', ');
      const parts = [summary, refusedSummary === '' ? '' : `refused (would create a new GitHub mention): ${refusedSummary}`];
      console.log(`  ${change.filePath}: ${parts.filter((part) => part !== '').join('; ')}`);
    }
    if (refusedAny) console.log('A file with a refused replacement is left unchanged; edit those lines by hand, then run again.');
    if (!args.write) console.log('Run again with --write to update files.');
  }

  // A refused replacement leaves a private literal in place, so the run cannot report success.
  return (args.write || changes.length === 0) && !refusedAny ? 0 : 1;
}

/**
 * The command-line entry. An unexpected error prints its class and a fixed sentence only: its
 * message (a file system or git error) can quote a private path or name.
 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    return run(argv, cwd);
  } catch (error) {
    const errorClass = error instanceof Error ? error.constructor.name : typeof error;
    console.error(`anonymize-private-literals: unexpected ${errorClass}; its text is withheld because it can quote a private path or name`);
    return 1;
  }
}

function printHelp(): void {
  console.log(`Usage: npm run leaks:anonymize -- [--write] [--staged] [--include-tests] [--json] [paths...]

Default mode is report-only and exits non-zero when replacements are available.
Reports count replacements per term id or rule code; they never print an original private
value or replacement text (fingerprints are short hashes for correlation). With --write, a
file with a refused replacement is left unchanged. Usage errors exit 2.`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  process.exitCode = main();
}
