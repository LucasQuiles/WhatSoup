import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { sanitizeProtectedMessageText, sanitizeProtectedToolText } from '../src/core/protected-message.ts';
import { sanitizeLogValue, sanitizingLogHook } from '../src/lib/log-sanitizer.ts';
import { sanitizeProtectedLinkText } from '../src/lib/protected-link-text.ts';
import { redactText } from '../src/lib/redaction-text.ts';

// This tree's side pins the reserved `.test` hosts in place of the production
// pins, which name no test host, as in tests/redaction-parity.test.ts. Main's
// side gets its own frozen copy of the same pins (MAIN_TEST_PINS), which no
// module of this tree can reach, so neither side can change the other's.
vi.mock('../src/lib/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('./helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal as never));

// Main is the oracle (owner ruling R78) for the TypeScript redaction paths: for
// every input, every secret main's code hides on a path stays hidden on the
// same path in this tree. Paths:
//   at_rest            redactText(raw)
//   read               sanitizeProtectedLinkText(redactText(raw)), the protected-link pass
//                      that readers apply to stored text
//   log_arg            sanitizingLogHook with a string argument: the logger's string path
//   log_value          sanitizeLogValue(raw): the logger's merge-object string field
//   protected_message  sanitizeProtectedMessageText(raw)
//   protected_tool     sanitizeProtectedToolText(raw), the escape-aware link pass
// Main's floor on every path runs only main's files: each is read out of this
// repository's object store by git blob id, checked against the id, transpiled
// and run here with a require shim that serves only main's own modules and its
// own pins. For each tracked secret this tree may show it no more often than
// main does, on every exposure measure (exact, case-folded, without whitespace,
// percent-decoded, letters and digits only, and each fragment of at least
// max(6, half its length) characters). A failure whose message starts with
// INCONCLUSIVE: is an oracle infrastructure failure, never a redaction finding.
// The public card is Python only
// (deploy/scripts/tests/test_bot_errors_redaction_main_oracle_card.py); the
// inputs, the vocabulary and the fuzz grammar are shared with the Python suites
// through tests/fixtures/redaction-main-oracle-cases.json, pinned by its sha256.
const MAIN_COMMIT = 'ad3b0f9ae76e328a66246d3e02494c37954ccd3d';
// Every file of main that this suite executes, by path at MAIN_COMMIT.
const MAIN_BLOBS: Readonly<Record<string, string>> = Object.freeze({
  'src/lib/redaction-text.ts': '6839da919cddfe74931aac8bfdb77b50dec59fb7',
  'src/lib/redaction-patterns.ts': '3b48128645616decdef8c1d34d0e67dd43f5d9f6',
  'src/lib/protected-delivery-pins.ts': 'd18d8914c416f5eb78c896cecd656bca4cf35ce1',
  'src/lib/protected-link-text.ts': 'eb8fa569309f353dd1e8507b9dab499c08a595f3',
  'src/core/protected-delivery-pins.ts': 'c66f19961d0be81ce824c4206be5d70ec09ba417',
  'src/core/protected-message.ts': '115854d72d9cd772dc3cdd4ac24eb32d77b7fb09',
  'src/lib/log-sanitizer.ts': '06a2e51dc7998b30fbd66c61d0b9cd8886d3d06d',
});
// The parity corpora, read at these blob ids rather than from the tree.
const PARITY_BLOBS: Readonly<Record<string, string>> = Object.freeze({
  // The same blob on main and on this branch.
  'redaction-parity-corpus.jsonl': '658600445524e3562ff076f85b76254b756f2cae',
  // This branch's blob: main has no authorization corpus.
  'redaction-parity-corpus-authorization.jsonl': 'ee634e44ab01f03bac0c72e841d634da2e4af7dd',
});
// What a fixer must not change. CASES_SHA256 pins the whole cases fixture; the
// constants after it name what it holds, so a mismatch says which part moved.
const CASES_FILE = 'redaction-main-oracle-cases.json';
const CASES_SHA256 = '6de0f22837a0086c1688e55819c99a1e42f782be7a6ba8cba4c9d88098c36446';
// A comment line stands between an id holding a key word and the next id where the secret
// scan's generic-api-key rule would otherwise read the pair as an assigned secret; a line
// break alone leaves the two ids four characters apart at this indent, within the rule's five.
const SHAPE_IDS = [
  'B1-overlapping-keyed-values',
  'B2-chained-key-space-before-value',
  'F1-bearer-plus-link',
  'F2-key-in-value',
  // (break for the secret scan; see above)
  'F3-quote-closes-at-later-key',
];
const NAMED_IDS = [
  'B1-overlap-bearer', 'B1-overlap-password',
  // (break for the secret scan; see above)
  'B2-chained-key-plain',
  // (break for the secret scan; see above)
  'B2-chained-key-tab',
  'F1-bearer-comma-slash-link', 'F1-bearer-dot-link', 'F1-bearer-eq-link', 'F1-bearer-plus-www',
  'F1-bearer-slash-bare', 'F1-bearer-slash-link', 'F1-bearer-space-link', 'F1-bearer-tilde-link',
  'F1-bearer-underscore-link', 'F1-token-plus-link', 'F2-dash-pat', 'F2-dash-secret-space',
  'F2-dot-session-eq', 'F2-dot-token', 'F2-json-dash-api-key', 'F2-link-comma-api-key',
  'F2-link-quoted-pat', 'F2-proxy-authorization', 'F2-single-dot-password', 'F2-underscore-session',
  'F2-underscore-token-eq', 'F2b-card-after-link', 'F3-no-final-quote', 'F3-single-quotes',
  'F3-unquoted-later-value', 'N-auth-after-fragment-crlf-bearer', 'N-auth-whole-line-two-links',
  'N-basic-after-fragment', 'N-bearer-after-fragment-tab', 'N-bearer-amp-http-link',
  'N-block-after-fragment', 'N-block-end-glued-key', 'N-block-then-auth', 'N-chain-colon-colon',
  'N-chain-eq-eq', 'N-chain-hyphen-key-value', 'N-chain-link2-key', 'N-chain-quoted',
  'N-chain-triple-quoted', 'N-chain-two-secrets', 'N-cookie-holds-link', 'N-crlf-fold-auth',
  'N-glued-key-in-fragment-middle', 'N-json-url-then-token', 'N-key-after-fragment-crlf',
  'N-key-then-block-after-fragment', 'N-phone-after-fragment', 'N-quoted-value-holds-link',
  'N-value-ends-in-link2-quote',
];
const RESIDUAL_ID = 'accepted-residual-unknown-first-word';
const RESIDUAL_TEMPLATE = "'token': &Bearer {B64}";
// The only exclusion (owner ruling, lane LEDGER.md:2223): at rest, the value
// after an unknown first word that follows a secret key is accepted. The paths
// derived from the stored text skip that one case (json is a Python path);
// every other path compares it with main.
const RESIDUAL_EXCLUDED_PATHS = ['at_rest', 'read', 'json'];
// The seeded fuzz set: a Lehmer generator (multiplier 48271, modulus 2**31 - 1),
// one draw for the family and one per slot, as in the Python suites.
const FUZZ_SEED = 20261116;
const FUZZ_SIZE = 4000;
const GIT_TIMEOUT_MS = 60_000;
// An aggregate loop stops itself at AGGREGATE_SECONDS; the test timeout is the backstop.
const AGGREGATE_SECONDS = 240;
const AGGREGATE_TIMEOUT_MS = (AGGREGATE_SECONDS + 60) * 1000;
const FRAGMENT_MIN = 6;
const MIN_TOKEN = 4;
const INCONCLUSIVE = 'INCONCLUSIVE:';

type Slot = string | string[];
interface Cases {
  linkHosts: string[];
  canaries: Record<string, string[]>;
  armour: Record<string, string[]>;
  parityCorpora: string[];
  keyWords: string[];
  keyWordSamples: string[];
  valueSamples: string[];
  declaredSecrets: Record<string, string[]>;
  liveness: { id: string; template: string };
  shapes: Array<{ id: string; template: string }>;
  named: Array<{ id: string; template: string }>;
  acceptedResidual: { id: string; template: string; excludedPaths: string[] };
  fuzz: { slots: Record<string, string[]>; families: Array<{ name: string; weight: number; slots: Slot[] }> };
}
interface OracleRow {
  id: string;
  family: string;
  text: string;
  // A template row's canaries, or a parity row's declared secrets.
  declared: string[];
  // A parity row also tracks the input tokens that main's output lacks.
  inferred: boolean;
}
type ModuleExports = Record<string, unknown>;

/** The error for an oracle infrastructure failure; its message says it is not a redaction finding. */
function inconclusive(reason: string): Error {
  return new Error(`${INCONCLUSIVE} ${reason}. This is an oracle infrastructure failure, not a redaction finding.`);
}
const isInconclusive = (error: unknown): boolean => error instanceof Error && error.message.startsWith(INCONCLUSIVE);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures');

function readCases(): { bytes: Buffer; cases: Cases } {
  try {
    const bytes = readFileSync(join(FIXTURES_DIR, CASES_FILE));
    return { bytes, cases: JSON.parse(bytes.toString('utf8')) as Cases };
  } catch (error) {
    throw inconclusive(`${CASES_FILE} is not readable JSON (${String(error)})`);
  }
}
const { bytes: CASES_BYTES, cases: CASES } = readCases();

/** Each way the oracle's inputs differ from the pinned ones; empty when they are the pinned inputs. */
function pinnedInputProblems(): string[] {
  const problems: string[] = [];
  const digest = createHash('sha256').update(CASES_BYTES).digest('hex');
  if (digest !== CASES_SHA256) problems.push(`${CASES_FILE} has sha256 ${digest}, not the pinned ${CASES_SHA256}`);
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  try {
    if (!same(CASES.shapes.map((entry) => entry.id), SHAPE_IDS)) problems.push('the reproduced shapes differ from the pinned ids');
    if (!same(CASES.named.map((entry) => entry.id).sort(), NAMED_IDS)) problems.push('the named case ids differ from the pinned list');
    const residual = CASES.acceptedResidual;
    if (residual.id !== RESIDUAL_ID || residual.template !== RESIDUAL_TEMPLATE) {
      problems.push("the accepted residual's id or template differs from the pinned one");
    }
    if (!same(residual.excludedPaths, RESIDUAL_EXCLUDED_PATHS)) problems.push("the accepted residual's excluded paths differ from the pinned ones");
    if (!same(CASES.parityCorpora, Object.keys(PARITY_BLOBS))) problems.push('the parity corpora differ from the pinned ones');
  } catch (error) {
    problems.push(`the cases fixture lacks a pinned field (${String(error)})`);
  }
  return problems;
}
if (pinnedInputProblems().length > 0) {
  throw inconclusive(`the oracle's inputs are not the pinned ones: ${pinnedInputProblems().join('; ')}`);
}

function git(args: string[]): Buffer {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], { maxBuffer: 1 << 26, timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    throw inconclusive(
      `git ${args.join(' ')} failed or did not finish within ${GIT_TIMEOUT_MS / 1000} s; `
        + `the oracle needs main's history in this clone: ${String(error)}`,
    );
  }
}

/** One file read from this repository's object store and checked against its blob id. */
function gitBlob(blobId: string): Buffer {
  const data = git(['cat-file', 'blob', blobId]);
  const actual = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (actual !== blobId) throw inconclusive(`git returned blob ${actual} for ${blobId}`);
  return data;
}

/** The blob id that `path` has in main's tree at MAIN_COMMIT. */
const mainTreeBlob = (path: string): string => git(['rev-parse', `${MAIN_COMMIT}:${path}`]).toString('utf8').trim();

// ── main's code, executed from its blobs ────────────────────────────────────

const loadedMainBlobs = new Map<string, string>();

/** Transpile one of main's files to CommonJS and run it, serving its imports only from `imports`. */
function mainModule(path: string, imports: Readonly<Record<string, ModuleExports>>): ModuleExports {
  const blobId = MAIN_BLOBS[path];
  if (blobId === undefined) throw inconclusive(`main's ${path} has no pinned blob`);
  const source = gitBlob(blobId).toString('utf8');
  try {
    const { outputText } = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const module: { exports: ModuleExports } = { exports: {} };
    const body = runInThisContext(`(function (exports, require, module) {\n${outputText}\n})`, {
      filename: `main-oracle-git-blob-${blobId}-${path}`,
    }) as (exports: ModuleExports, require: (specifier: string) => ModuleExports, module: { exports: ModuleExports }) => void;
    body(module.exports, (specifier) => {
      const dependency = Object.prototype.hasOwnProperty.call(imports, specifier) ? imports[specifier] : undefined;
      if (dependency === undefined) throw inconclusive(`main's ${path} imports ${specifier}, which the oracle does not serve`);
      return dependency;
    }, module);
    loadedMainBlobs.set(path, blobId);
    return Object.freeze({ ...module.exports });
  } catch (error) {
    if (isInconclusive(error)) throw error;
    throw inconclusive(`main's ${path} (blob ${blobId}) did not load (${String(error)})`);
  }
}

function mainExport<T>(exports: ModuleExports, name: string): T {
  const value = exports[name];
  if (typeof value !== 'function') throw inconclusive(`main's module exports no function ${name}`);
  return value as T;
}

/** A set that only answers: main's pins are never handed to this tree's code, and cannot be edited. */
function readonlySet(values: readonly string[]): ReadonlySet<string> {
  const inner = new Set(values);
  return Object.freeze({
    has: (value: string): boolean => inner.has(value),
    get size(): number {
      return inner.size;
    },
    [Symbol.iterator]: () => inner.values(),
  }) as unknown as ReadonlySet<string>;
}

const pinDigest = (host: string): string => createHash('sha256').update(host, 'utf8').digest('hex');
const [LINK_HOST, DELIVERY_HOST] = CASES.linkHosts as [string, string];
// The same reserved hosts as this tree's helper pins, in main's own frozen copy.
const MAIN_TEST_PINS = Object.freeze({
  deliveryHostSha256: readonlySet([pinDigest(DELIVERY_HOST)]),
  linkHostSha256: readonlySet(CASES.linkHosts.map(pinDigest)),
  canonicalLinkHostSha256: readonlySet([pinDigest(LINK_HOST)]),
});
const MAIN_CRYPTO: ModuleExports = Object.freeze({ createHash });

const mainPatterns = mainModule('src/lib/redaction-patterns.ts', {});
const mainRedaction = mainModule('src/lib/redaction-text.ts', { './redaction-patterns.ts': mainPatterns });
// Main's pins module with its production pins swapped for MAIN_TEST_PINS, as
// mockProtectedDeliveryPins does on this tree's side.
const mainPins: ModuleExports = Object.freeze({
  ...mainModule('src/lib/protected-delivery-pins.ts', { 'node:crypto': MAIN_CRYPTO }),
  PROTECTED_DELIVERY_PINS: MAIN_TEST_PINS,
});
const mainLinks = mainModule('src/lib/protected-link-text.ts', { './protected-delivery-pins.ts': mainPins });
const mainCorePins = mainModule('src/core/protected-delivery-pins.ts', { '../lib/protected-delivery-pins.ts': mainPins });
const mainMessages = mainModule('src/core/protected-message.ts', {
  './protected-delivery-pins.ts': mainCorePins,
  '../lib/protected-link-text.ts': mainLinks,
});
const mainLogs = mainModule('src/lib/log-sanitizer.ts', {
  './protected-link-text.ts': mainLinks,
  './redaction-patterns.ts': mainPatterns,
});

type TextFunction = (value: string) => string;
type PinnedTextFunction = (value: string, pins: unknown) => string;
type LogHook = (this: unknown, args: unknown[], method: (...args: unknown[]) => void, level: number) => void;
interface Side {
  redactText: TextFunction;
  sanitizeLinks: TextFunction;
  logHook: LogHook;
  logValue: (value: unknown) => unknown;
  messageText: TextFunction;
  toolText: TextFunction;
}

const mainRedactText = mainExport<TextFunction>(mainRedaction, 'redactText');
const mainSanitizeLinks = mainExport<PinnedTextFunction>(mainLinks, 'sanitizeProtectedLinkText');
const mainMessageText = mainExport<PinnedTextFunction>(mainMessages, 'sanitizeProtectedMessageText');
const mainToolText = mainExport<PinnedTextFunction>(mainMessages, 'sanitizeProtectedToolText');
const MAIN: Side = {
  redactText: mainRedactText,
  sanitizeLinks: (value) => mainSanitizeLinks(value, MAIN_TEST_PINS),
  logHook: mainExport<LogHook>(mainLogs, 'sanitizingLogHook'),
  logValue: mainExport<(value: unknown) => unknown>(mainLogs, 'sanitizeLogValue'),
  messageText: (value) => mainMessageText(value, MAIN_TEST_PINS),
  toolText: (value) => mainToolText(value, MAIN_TEST_PINS),
};
const HEAD: Side = {
  redactText: (value) => redactText(value),
  sanitizeLinks: (value) => sanitizeProtectedLinkText(value),
  logHook: sanitizingLogHook,
  logValue: (value) => sanitizeLogValue(value),
  messageText: (value) => sanitizeProtectedMessageText(value),
  toolText: (value) => sanitizeProtectedToolText(value),
};

const PATHS = ['at_rest', 'read', 'log_arg', 'log_value', 'protected_message', 'protected_tool'] as const;
type OraclePath = (typeof PATHS)[number];
const RESIDUAL_PATHS = PATHS.filter((path) => !RESIDUAL_EXCLUDED_PATHS.includes(path));
// Paths whose main floor redacts more than links.
const FULL_PATHS: readonly OraclePath[] = ['at_rest', 'read', 'log_value'];

/** What the logger writes for one string argument. */
function logged(hook: LogHook, text: string): string {
  let written: unknown[] = [];
  hook.call(undefined, [text], (...args: unknown[]) => {
    written = args;
  }, 30);
  return written.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}

function render(side: Side, path: OraclePath, text: string): string {
  switch (path) {
    case 'at_rest':
      return side.redactText(text);
    case 'read':
      return side.sanitizeLinks(side.redactText(text));
    case 'log_arg':
      return logged(side.logHook, text);
    case 'log_value':
      return String(side.logValue(text));
    case 'protected_message':
      return side.messageText(text);
    case 'protected_tool':
      return side.toolText(text);
  }
}

/** main's output on a path; an error inside main's code leaves the oracle unable to judge. */
function floorText(path: OraclePath, text: string): string {
  try {
    return render(MAIN, path, text);
  } catch (error) {
    if (isInconclusive(error)) throw error;
    throw inconclusive(`main's code raised on the ${path} path (${String(error)})`);
  }
}

// ── inputs ──────────────────────────────────────────────────────────────────

const canaries = Object.entries(CASES.canaries).map(([name, parts]): [string, string] => [name, parts.join('')]);
const values = new Map<string, string>([
  ...canaries,
  ...Object.entries(CASES.armour).map(([name, parts]): [string, string] => [name, parts.join('')]),
]);
const PLACEHOLDER = new RegExp(`\\{(${[...values.keys()].join('|')})\\}`, 'g');

/** A template expanded with the canaries; its secrets are the canaries it holds. */
function templateRow(id: string, family: string, template: string): OracleRow {
  const text = template.replace(PLACEHOLDER, (_match, name: string) => values.get(name)!);
  const declared = canaries.filter(([name]) => template.includes(`{${name}}`)).map(([, value]) => value);
  return { id, family, text, declared, inferred: false };
}

function fuzzRows(): OracleRow[] {
  const { slots, families } = CASES.fuzz;
  let state = FUZZ_SEED;
  const draw = (count: number): number => {
    state = (state * 48271) % 2147483647;
    return state % count;
  };
  const weighted = families.flatMap((family) => Array.from({ length: family.weight }, () => family));
  const seen = new Set<string>();
  const rows: OracleRow[] = [];
  for (let index = 0; index < FUZZ_SIZE; index += 1) {
    const family = weighted[draw(weighted.length)]!;
    const template = family.slots
      .map((slot) => {
        const options = typeof slot === 'string' ? slots[slot]! : slot;
        return options[draw(options.length)]!;
      })
      .join('');
    if (seen.has(template)) continue;
    seen.add(template);
    rows.push(templateRow(`fuzz-${index}`, `fuzz:${family.name}`, template));
  }
  return rows;
}

function parityRows(): OracleRow[] {
  const rows: OracleRow[] = [];
  const seen = new Set<string>();
  for (const [name, blobId] of Object.entries(PARITY_BLOBS)) {
    for (const line of gitBlob(blobId).toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const source = JSON.parse(line) as { id: string; input: string };
      // A row that supersedes another holds the same input; it is judged once.
      if (seen.has(source.input)) continue;
      seen.add(source.input);
      const id = `parity:${name}:${source.id}`;
      rows.push({ id, family: 'parity', text: source.input, declared: [...(CASES.declaredSecrets[id] ?? [])], inferred: true });
    }
  }
  return rows;
}

const SHAPES = CASES.shapes.map((entry) => templateRow(entry.id, 'shape', entry.template));
const NAMED = CASES.named.map((entry) => templateRow(entry.id, 'named', entry.template));
const RESIDUAL = templateRow(CASES.acceptedResidual.id, 'residual', CASES.acceptedResidual.template);
const LIVENESS = templateRow(CASES.liveness.id, 'liveness', CASES.liveness.template);
const FUZZ = fuzzRows();
const PARITY = parityRows();

// ── tracked secrets ─────────────────────────────────────────────────────────

const TOKEN = /[A-Za-z0-9._~+/%-]+/g;
const TOKEN_LEADING_EDGE = /^[._~+/%-]+/;
const TOKEN_EDGES = /^[._~+/%-]+|[._~+/%-]+$/g;
const KEY_PART_SPLIT = /[-_.]+|(?<=[a-z])(?=[A-Z])/;
const KEY_WORDS = new Set(CASES.keyWords.map((word) => word.toLowerCase()));

interface Token {
  start: number;
  end: number;
  token: string;
}

/** Each token of 4 or more characters, edge punctuation trimmed. */
function inputTokens(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    const token = raw.replace(TOKEN_EDGES, '');
    if (token.length < MIN_TOKEN) continue;
    const start = (match.index ?? 0) + raw.length - raw.replace(TOKEN_LEADING_EDGE, '').length;
    tokens.push({ start, end: start + token.length, token });
  }
  return tokens;
}

/** A key or scheme word in any case and separator spelling (api_key, Proxy-Authorization, sessionToken). */
function isKeyWord(token: string): boolean {
  const parts = token.split(KEY_PART_SPLIT).filter((part) => part.length > 0).map((part) => part.toLowerCase());
  return parts.length > 0 && parts.every((part) => KEY_WORDS.has(part));
}

/**
 * The row's secrets on one path: a template row's canaries; for a parity row
 * also every input token that is not a key word and that main's output on the
 * path (`floor`) no longer contains. Declared secrets only add.
 */
function tracked(row: OracleRow, floor: string): string[] {
  const secrets = [...row.declared];
  if (row.inferred) {
    for (const { token } of inputTokens(row.text)) {
      if (!secrets.includes(token) && !floor.includes(token) && !isKeyWord(token)) secrets.push(token);
    }
  }
  return secrets;
}

// ── exposure measures ───────────────────────────────────────────────────────

const WHITESPACE = /[\s​‌‍⁠﻿]+/g;
const PERCENT = /%([0-9A-Fa-f]{2})/g;
const NOT_ALNUM = /[^a-z0-9]+/g;

/** %XX sequences decoded, up to three times for text encoded more than once. */
function percentDecoded(text: string): string {
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    const decoded = current.replace(PERCENT, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === current) break;
    current = decoded;
  }
  return current;
}

const VIEWS = {
  exact: (text: string): string => text,
  folded: (text: string): string => text.toLowerCase(),
  unspaced: (text: string): string => text.replace(WHITESPACE, ''),
  decoded: percentDecoded,
  alnum: (text: string): string => percentDecoded(text).normalize('NFKC').toLowerCase().replace(NOT_ALNUM, ''),
};
type ViewName = keyof typeof VIEWS;
const MEASURES: ViewName[] = ['exact', 'folded', 'unspaced', 'decoded', 'alnum'];

interface Probe {
  measure: ViewName | 'fragment';
  view: ViewName;
  key: string;
}
const probeLabel = (probe: Probe): string => (probe.measure === 'fragment' ? `fragment ${probe.key}` : probe.measure);

/** Each distinct substring of max(6, half its length) characters; none for a secret that short. */
function fragmentWindows(secret: string): string[] {
  const width = Math.max(FRAGMENT_MIN, Math.ceil(secret.length / 2));
  const pieces: string[] = [];
  if (secret.length <= width) return pieces;
  for (let start = 0; start + width <= secret.length; start += 1) {
    const piece = secret.slice(start, start + width);
    if (!pieces.includes(piece)) pieces.push(piece);
  }
  return pieces;
}

/**
 * The measures that can see `secret`. `context` is the input without the
 * secret itself; a measure whose key already matches there cannot tell the
 * secret from that text, so it is left out rather than counted against either side.
 */
function probesFor(secret: string, context: string): Probe[] {
  const found: Probe[] = [];
  for (const measure of MEASURES) {
    const key = VIEWS[measure](secret);
    if (key.length === 0 || (measure === 'alnum' && key.length < FRAGMENT_MIN)) continue;
    if (!VIEWS[measure](context).includes(key)) found.push({ measure, view: measure, key });
  }
  for (const piece of fragmentWindows(secret)) {
    if (!context.includes(piece)) found.push({ measure: 'fragment', view: 'exact', key: piece });
  }
  return found;
}

/** The row's input with the secret's own occurrences blanked: whole tokens for an inferred secret. */
function secretContext(row: OracleRow, secret: string): string {
  if (row.inferred && !row.declared.includes(secret)) {
    let context = '';
    let cursor = 0;
    for (const { start, end, token } of inputTokens(row.text)) {
      if (token !== secret) continue;
      context += `${row.text.slice(cursor, start)}\0`;
      cursor = end;
    }
    return context + row.text.slice(cursor);
  }
  return row.text.split(secret).join('\0');
}

const PROBES = new Map<string, Probe[]>();
function rowProbes(row: OracleRow, secret: string): Probe[] {
  const key = `${row.id}\0${secret}`;
  let cached = PROBES.get(key);
  if (cached === undefined) {
    cached = probesFor(secret, secretContext(row, secret));
    PROBES.set(key, cached);
  }
  return cached;
}

/** The measure views of one rendered text, each computed once. */
class Views {
  private readonly text: string;
  private readonly views = new Map<ViewName, string>();

  constructor(text: string) {
    this.text = text;
  }

  count(probe: Probe): number {
    let view = this.views.get(probe.view);
    if (view === undefined) {
      view = VIEWS[probe.view](this.text);
      this.views.set(probe.view, view);
    }
    return view.split(probe.key).length - 1;
  }
}

/** What this tree's rendering shows of the row's secrets beyond main's: on no measure may its count exceed main's. */
function shownBeyondMain(row: OracleRow, floor: string, rendered: string): string[] {
  const floorViews = new Views(floor);
  const mine = new Views(rendered);
  const shown: string[] = [];
  for (const secret of tracked(row, floor)) {
    for (const probe of rowProbes(row, secret)) {
      const here = mine.count(probe);
      const there = floorViews.count(probe);
      if (here > there) shown.push(`${secret} [${probeLabel(probe)}] this tree ${here}, main ${there}`);
    }
  }
  return shown;
}

/** Every measure on which the rendering shows one of the row's declared secrets. */
function shownAtAll(row: OracleRow, rendered: string): string[] {
  const views = new Views(rendered);
  const shown: string[] = [];
  for (const secret of row.declared) {
    for (const probe of rowProbes(row, secret)) {
      const count = views.count(probe);
      if (count > 0) shown.push(`${secret} [${probeLabel(probe)}] ${count}`);
    }
  }
  return shown;
}

function shownOn(row: OracleRow, path: OraclePath): { shown: string[]; rendered: string } {
  const floor = floorText(path, row.text);
  const rendered = render(HEAD, path, row.text);
  return { shown: shownBeyondMain(row, floor, rendered), rendered };
}

function corpusFailures(rows: OracleRow[], path: OraclePath): string[] {
  const deadline = Date.now() + AGGREGATE_SECONDS * 1000;
  const failures: string[] = [];
  for (let done = 0; done < rows.length; done += 1) {
    if (Date.now() > deadline) {
      throw inconclusive(`the ${path} aggregate ran out of its ${AGGREGATE_SECONDS} s budget after ${done} of ${rows.length} rows`);
    }
    const row = rows[done]!;
    const { shown, rendered } = shownOn(row, path);
    if (shown.length > 0) failures.push(`${row.id} (${row.family}) shows ${JSON.stringify(shown)}: ${JSON.stringify(rendered)}`);
  }
  return failures;
}

let savedSafeShape: string | undefined;
beforeAll(() => {
  savedSafeShape = process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
  delete process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
});
afterAll(() => {
  if (savedSafeShape === undefined) delete process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
  else process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'] = savedSafeShape;
});

describe(`redaction main oracle, TypeScript (main ${MAIN_COMMIT.slice(0, 12)})`, () => {
  it('loads main as the oracle from pinned blobs and holds the pinned inputs', () => {
    expect(mainRedactText).not.toBe(redactText);
    expect(mainSanitizeLinks).not.toBe(sanitizeProtectedLinkText);
    expect(MAIN.logHook).not.toBe(sanitizingLogHook);
    expect(mainMessageText).not.toBe(sanitizeProtectedMessageText);
    expect([...loadedMainBlobs.entries()].sort()).toEqual(Object.entries(MAIN_BLOBS).sort());
    const wrong = Object.entries(MAIN_BLOBS).filter(([path, blobId]) => mainTreeBlob(path) !== blobId).map(([path]) => path);
    if (wrong.length > 0) throw inconclusive(`these pinned blob ids are not main's files at ${MAIN_COMMIT}: ${wrong.join(', ')}`);
    expect(pinnedInputProblems()).toEqual([]);
    expect([FUZZ_SEED, FUZZ_SIZE]).toEqual([20261116, 4000]);
    expect(SHAPES.map((row) => row.id)).toEqual(SHAPE_IDS);
    expect(NAMED.map((row) => row.id).sort()).toEqual(NAMED_IDS);
    expect([RESIDUAL.id, CASES.acceptedResidual.template]).toEqual([RESIDUAL_ID, RESIDUAL_TEMPLATE]);
    expect(FUZZ.length).toBeGreaterThan(3000);
    expect(PARITY.length).toBeGreaterThan(100);
    expect([...SHAPES, ...NAMED, RESIDUAL].filter((row) => row.declared.length === 0).map((row) => row.id)).toEqual([]);
    // The residual is in no other input list, so only the paths that name it skip it.
    expect([...SHAPES, ...NAMED, ...FUZZ, ...PARITY].some((row) => row.id === RESIDUAL.id)).toBe(false);
  });

  it.each(SHAPES)('main hides the credential of $id at rest', (row) => {
    const stored = floorText('at_rest', row.text);
    if (row.declared.some((secret) => stored.includes(secret))) {
      throw inconclusive(`main's redactText no longer hides ${row.id} at rest: ${JSON.stringify(stored)}`);
    }
  });

  it.each(PATHS.filter((path) => path !== 'at_rest'))('main replaces a pinned protected link on %s', (path) => {
    const rendered = floorText(path, LIVENESS.text);
    if (shownAtAll(LIVENESS, rendered).length > 0) {
      throw inconclusive(`main's ${path} floor no longer replaces a pinned protected link: ${JSON.stringify(rendered)}`);
    }
  });

  it('treats key and scheme words as key words and values as values', () => {
    expect(CASES.keyWordSamples.filter((word) => !isKeyWord(word))).toEqual([]);
    expect([...CASES.valueSamples, ...canaries.map(([, value]) => value)].filter((word) => isKeyWord(word))).toEqual([]);
    expect(inputTokens('token: password: x').map(({ token }) => token)).toEqual(['token', 'password']);
    const row: OracleRow = { id: 'vocabulary', family: 'check', text: 'token: password: refused', declared: [], inferred: true };
    expect(tracked(row, 'token: [x]')).toEqual(['refused']);
  });

  it('never tracks a value main keeps', () => {
    const row = PARITY.find((candidate) => candidate.id.endsWith(':make-version-not-phone'));
    if (row === undefined) throw inconclusive('the build-number parity row is missing');
    if (!floorText('at_rest', row.text).includes(row.text)) {
      throw inconclusive("main's redactText no longer keeps the build-number row unchanged");
    }
    for (const path of PATHS) {
      const floor = floorText(path, row.text);
      // A path whose main floor rewrites the row has nothing to say about kept values.
      if (floor.includes(row.text)) expect(tracked(row, floor), path).toEqual([]);
    }
  });

  it.each(PATHS)('the parity corpora hold secrets main hides on %s', (path) => {
    const rows = PARITY.filter((row) => tracked(row, floorText(path, row.text)).length > 0);
    if (rows.length <= (FULL_PATHS.includes(path) ? 20 : 3)) {
      throw inconclusive(`only ${rows.length} parity rows hold a secret that main hides on ${path}`);
    }
  });

  it('declared secrets belong to their rows', () => {
    for (const [id, secrets] of Object.entries(CASES.declaredSecrets)) {
      const row = PARITY.find((candidate) => candidate.id === id);
      expect(row, id).toBeDefined();
      expect(secrets.filter((secret) => row === undefined || !row.text.includes(secret)), id).toEqual([]);
    }
  });

  for (const path of PATHS) {
    it.each(SHAPES)(`reproduced shape $id hides on ${path} what main hides`, (row) => {
      const { shown, rendered } = shownOn(row, path);
      expect(shown, rendered).toEqual([]);
    });

    it.each(NAMED)(`named case $id hides on ${path} what main hides`, (row) => {
      const { shown, rendered } = shownOn(row, path);
      expect(shown, rendered).toEqual([]);
    });

    it(`the fuzz set hides on ${path} what main hides`, () => {
      const failures = corpusFailures(FUZZ, path);
      expect(failures.length, `${failures.length} rows:\n${failures.slice(0, 60).join('\n')}`).toBe(0);
    }, AGGREGATE_TIMEOUT_MS);

    it(`the parity corpora hide on ${path} what main hides`, () => {
      const failures = corpusFailures(PARITY, path);
      expect(failures.length, `${failures.length} rows:\n${failures.slice(0, 60).join('\n')}`).toBe(0);
    }, AGGREGATE_TIMEOUT_MS);
  }

  for (const path of RESIDUAL_PATHS) {
    it(`the accepted residual hides on ${path} what main hides`, () => {
      const { shown, rendered } = shownOn(RESIDUAL, path);
      expect(shown, rendered).toEqual([]);
    });
  }
});
