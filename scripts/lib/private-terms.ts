/**
 * Private term file loader.
 *
 * An operator keeps the names that must never reach this public repository
 * (machines, bot instances, people, private domains, account ids, private
 * addresses) in a JSON file OUTSIDE the repository. Repository guards load it
 * so they can recognise those names without the names being written into
 * public source.
 *
 * Path: WHATSOUP_PRIVATE_TERMS_FILE when set, else
 * ~/.config/whatsoup/private-terms.json. An absent file yields no term rules;
 * the caller then reports that only the generic rules ran. With
 * WHATSOUP_REQUIRE_PRIVATE_TERMS=1 an absent file is a failure. An unreadable
 * or invalid file is always a failure: a term file that exists but cannot be
 * applied must not silently weaken the check.
 *
 * Output rule for every caller: report a file or a source, a line number and a
 * rule code. Never the matched text, a term id or a term value. Every message
 * this module produces names a term only by its index in the `terms` array.
 *
 * Node built-ins only, so every guard and hook can import it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const PRIVATE_TERMS_FILE_ENV = 'WHATSOUP_PRIVATE_TERMS_FILE';
export const REQUIRE_PRIVATE_TERMS_ENV = 'WHATSOUP_REQUIRE_PRIVATE_TERMS';
export const PRIVATE_TERMS_SCHEMA = 'whatsoup-private-terms';
export const PRIVATE_TERMS_VERSION = 1;

const TERM_CLASSES = [
  'machine',
  'instance',
  'person',
  'person-user',
  'person-surname',
  'private-domain',
  'account-id',
  'address',
] as const;
export type PrivateTermClass = (typeof TERM_CLASSES)[number];

const MATCH_MODES = ['word', 'context', 'literal', 'address'] as const;
export type PrivateTermMatch = (typeof MATCH_MODES)[number];

/** Term class -> rule code. The first three codes are the existing fallback codes. */
export const PRIVATE_TERM_CLASS_CODES: Readonly<Record<PrivateTermClass, string>> = Object.freeze({
  machine: 'private-host-label',
  instance: 'private-instance-label',
  address: 'private-tailnet-ip',
  person: 'private-person',
  'person-user': 'private-person',
  'person-surname': 'private-person',
  'private-domain': 'private-domain',
  'account-id': 'private-account-id',
});

/** Static message per term rule code; the existing codes keep their existing wording. */
export const PRIVATE_TERM_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'private-host-label': 'Public repo text must not include private host labels.',
  'private-instance-label': 'Public repo text must not include private instance labels.',
  'private-tailnet-ip': 'Public repo text must not include private tailnet IPs.',
  'private-person': 'Public repo text must not include private person names.',
  'private-domain': 'Public repo text must not include private domain names.',
  'private-account-id': 'Public repo text must not include private account identifiers.',
});

/** Every code a term rule can produce, sorted. */
export const PRIVATE_TERM_CODES: readonly string[] = Object.freeze(
  [...new Set(Object.values(PRIVATE_TERM_CLASS_CODES))].sort(),
);

export interface PrivateTermRule {
  readonly code: string;
  readonly message: string;
  /** Detection form, built exactly as the reference matcher describes; never global. */
  readonly regex: RegExp;
  /**
   * Replacement form for the anonymizer: global, and for `context` terms the
   * context text sits in lookarounds so only the term itself is replaced.
   */
  readonly replaceRegex: RegExp;
  /** The bare term core, anchored, used to read `{1}`-style groups from a replaced span. */
  readonly coreRegex: RegExp;
  /**
   * Masking form for output: the bare core with no boundary and no context, global. It matches
   * wherever the term's text appears (inside a longer word, outside its contexts), so a printed
   * path or ref never shows a term even where the detection form does not match it.
   */
  readonly maskRegex: RegExp;
  /** Replacement template; `{N}` is group N of the term's own regex. */
  readonly replace: string;
}

export type PrivateTermsStatus = 'absent' | 'loaded' | 'unreadable' | 'invalid';

export interface PrivateTermsLoad {
  readonly status: PrivateTermsStatus;
  /** True when WHATSOUP_REQUIRE_PRIVATE_TERMS=1. */
  readonly required: boolean;
  /** Hex sha256 of the exact file bytes, or null when no bytes were read. */
  readonly sha256: string | null;
  readonly rules: readonly PrivateTermRule[];
  /** Fixed description of an unreadable or invalid file; never holds a term id or value. */
  readonly problem: string | null;
}

/** Raised when the term file state forbids a scan (exit code 2 for every caller). */
export class PrivateTermsError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'PrivateTermsError';
  }
}

export const PRIVATE_TERMS_ABSENT_NOTICE =
  'private term file absent (WHATSOUP_PRIVATE_TERMS_FILE or ~/.config/whatsoup/private-terms.json); only the generic rules ran';

export function privateTermsRequired(env: NodeJS.ProcessEnv): boolean {
  return env[REQUIRE_PRIVATE_TERMS_ENV] === '1';
}

export function privateTermsPath(env: NodeJS.ProcessEnv): string {
  const configured = env[PRIVATE_TERMS_FILE_ENV];
  if (configured !== undefined && configured !== '') return configured;
  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
  return path.join(home, '.config', 'whatsoup', 'private-terms.json');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const WORD_BEFORE = '(?<![A-Za-z0-9_])';
const WORD_AFTER = '(?![A-Za-z0-9_])';

interface ValidTerm {
  readonly index: number;
  readonly termClass: PrivateTermClass;
  readonly match: PrivateTermMatch;
  readonly insensitive: boolean;
  readonly value: string | null;
  readonly regex: string | null;
  readonly variants: boolean;
  readonly replace: string;
  /** The term's own context forms; null means the top-level list applies. */
  readonly contexts: readonly ContextForm[] | null;
}

class InvalidTermsFile extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function validateTerm(raw: unknown, index: number): ValidTerm {
  const where = `terms[${index}]`;
  if (!isRecord(raw)) throw new InvalidTermsFile(`${where} is not an object`);
  if (!nonEmptyString(raw.id)) throw new InvalidTermsFile(`${where}: id must be a non-empty string`);
  if (typeof raw.class !== 'string' || !(TERM_CLASSES as readonly string[]).includes(raw.class)) {
    throw new InvalidTermsFile(`${where}: class must be one of ${TERM_CLASSES.join(', ')}`);
  }
  if (typeof raw.match !== 'string' || !(MATCH_MODES as readonly string[]).includes(raw.match)) {
    throw new InvalidTermsFile(`${where}: match must be one of ${MATCH_MODES.join(', ')}`);
  }
  if (raw.case !== 'sensitive' && raw.case !== 'insensitive') {
    throw new InvalidTermsFile(`${where}: case must be sensitive or insensitive`);
  }
  if (raw.value !== undefined && !nonEmptyString(raw.value)) {
    throw new InvalidTermsFile(`${where}: value must be a non-empty string`);
  }
  if (raw.regex !== undefined && !nonEmptyString(raw.regex)) {
    throw new InvalidTermsFile(`${where}: regex must be a non-empty string`);
  }
  if (raw.variants !== undefined && typeof raw.variants !== 'boolean') {
    throw new InvalidTermsFile(`${where}: variants must be a boolean`);
  }
  if (raw.replace !== undefined && typeof raw.replace !== 'string') {
    throw new InvalidTermsFile(`${where}: replace must be a string`);
  }
  const match = raw.match as PrivateTermMatch;
  const value = typeof raw.value === 'string' ? raw.value : null;
  const regex = typeof raw.regex === 'string' ? raw.regex : null;
  // `regex` only shapes the core of word and context terms; literal and address
  // terms always match their escaped value.
  if ((match === 'literal' || match === 'address') && value === null) {
    throw new InvalidTermsFile(`${where}: ${match} terms need a value`);
  }
  if (value === null && regex === null) {
    throw new InvalidTermsFile(`${where}: value or regex is required`);
  }
  return {
    index,
    termClass: raw.class as PrivateTermClass,
    match,
    insensitive: raw.case === 'insensitive',
    value,
    regex,
    variants: raw.variants === true,
    replace: typeof raw.replace === 'string' ? raw.replace : 'redacted',
    // A term's own list replaces the top-level list for that term only, so one value can be
    // private in some forms (an instance name) without matching every top-level form.
    contexts: raw.contexts === undefined ? null : validateContexts(raw.contexts, `${where}.contexts`),
  };
}

function termCore(term: ValidTerm): string {
  if (term.regex !== null && (term.match === 'word' || term.match === 'context')) return term.regex;
  const value = term.value ?? '';
  if (term.match === 'word' && term.variants && value.endsWith('-bot')) {
    return `${escapeRegex(value.slice(0, -'-bot'.length))}[-_]?bot`;
  }
  return escapeRegex(value);
}

interface ContextForm {
  readonly before: string;
  readonly after: string;
}

function validateContexts(raw: unknown, where = 'contexts'): ContextForm[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new InvalidTermsFile(`${where} must be an array of strings`);
  return raw.map((form, index) => {
    if (typeof form !== 'string') throw new InvalidTermsFile(`${where}[${index}] must be a string`);
    const parts = form.split('{t}');
    if (parts.length !== 2) throw new InvalidTermsFile(`${where}[${index}] must contain {t} exactly once`);
    return { before: parts[0]!, after: parts[1]! };
  });
}

function compileTerm(term: ValidTerm, topLevelContexts: readonly ContextForm[]): PrivateTermRule {
  const where = `terms[${term.index}]`;
  const contexts = term.contexts ?? topLevelContexts;
  // The core is grouped (non-capturing) so a core with a top-level alternation
  // keeps its meaning inside the boundaries; its own groups keep their numbers.
  const core = `(?:${termCore(term)})`;
  const flags = term.insensitive ? 'i' : '';
  let detection: string;
  let replacement: string;
  if (term.match === 'word') {
    detection = `${WORD_BEFORE}${core}${WORD_AFTER}`;
    replacement = detection;
  } else if (term.match === 'context') {
    if (contexts.length === 0) throw new InvalidTermsFile(`${where}: context terms need at least one contexts form`);
    detection = `(?:${contexts
      .map(({ before, after }) => `${escapeRegex(before)}${core}${after === '' ? WORD_AFTER : escapeRegex(after)}`)
      .join('|')})`;
    replacement = `(?:${contexts
      .map(({ before, after }) => `(?<=${escapeRegex(before)})${core}${after === '' ? WORD_AFTER : `(?=${escapeRegex(after)})`}`)
      .join('|')})`;
  } else if (term.match === 'literal') {
    detection = core;
    replacement = detection;
  } else {
    detection = `(?<![0-9.])${core}(?![0-9]|\\.[0-9])`;
    replacement = detection;
  }
  try {
    const code = PRIVATE_TERM_CLASS_CODES[term.termClass];
    return Object.freeze({
      code,
      message: PRIVATE_TERM_CODE_MESSAGES[code]!,
      regex: new RegExp(detection, flags),
      replaceRegex: new RegExp(replacement, `${flags}g`),
      coreRegex: new RegExp(`^${core}$`, flags),
      maskRegex: new RegExp(core, `${flags}g`),
      replace: term.replace,
    });
  } catch {
    // A RegExp SyntaxError quotes the pattern; report the index only.
    throw new InvalidTermsFile(`${where}: regex does not compile`);
  }
}

/** Compile parsed term-file JSON into rules. Throws a fixed-message error for invalid input. */
export function compilePrivateTerms(document: unknown): PrivateTermRule[] {
  if (!isRecord(document)) throw new InvalidTermsFile('top level is not an object');
  if (document.schema !== PRIVATE_TERMS_SCHEMA) throw new InvalidTermsFile(`schema must be ${PRIVATE_TERMS_SCHEMA}`);
  if (document.version !== PRIVATE_TERMS_VERSION) throw new InvalidTermsFile(`version must be ${PRIVATE_TERMS_VERSION}`);
  const contexts = validateContexts(document.contexts);
  if (!Array.isArray(document.terms)) throw new InvalidTermsFile('terms must be an array');
  return document.terms.map((raw, index) => compileTerm(validateTerm(raw, index), contexts));
}

function readTermBytes(filePath: string): { status: 'absent' } | { status: 'unreadable' } | { status: 'read'; bytes: Buffer } {
  try {
    return { status: 'read', bytes: readFileSync(filePath) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'absent' } : { status: 'unreadable' };
  }
}

/**
 * How output names the term file: the variable when it names the file, else the default path.
 * Never the resolved path: a home folder or a chosen folder name can be a private name, and a
 * file that cannot be loaded gives no rules to mask it with.
 */
export function privateTermsPathLabel(env: NodeJS.ProcessEnv): string {
  const configured = env[PRIVATE_TERMS_FILE_ENV];
  return configured !== undefined && configured !== ''
    ? `the file named by ${PRIVATE_TERMS_FILE_ENV}`
    : '~/.config/whatsoup/private-terms.json';
}

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * Offset of the first JSON syntax error, found by a minimal scanner, or null when the scanner
 * finds none. JSON.parse error text quotes the input around the error (a term value, say), so
 * only this offset is ever reported.
 */
function jsonErrorOffset(text: string): number | null {
  let at = 0;
  const fail = (): never => {
    throw new RangeError(String(at));
  };
  const skipSpace = (): void => {
    while (at < text.length && ' \t\n\r'.includes(text[at]!)) at += 1;
  };
  const scanString = (): void => {
    at += 1;
    while (at < text.length && text[at] !== '"') {
      if (text.charCodeAt(at) < 0x20) fail();
      if (text[at] !== '\\') {
        at += 1;
        continue;
      }
      at += 1;
      if (text[at] === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 1, at + 5))) fail();
        at += 5;
      } else if (text[at] !== undefined && '"\\/bfnrt'.includes(text[at]!)) {
        at += 1;
      } else {
        fail();
      }
    }
    if (at >= text.length) fail();
    at += 1;
  };
  const scanValue = (depth: number): void => {
    if (depth > 64) fail();
    skipSpace();
    const open = text[at];
    if (open === '{' || open === '[') {
      const close = open === '{' ? '}' : ']';
      at += 1;
      skipSpace();
      if (text[at] === close) {
        at += 1;
        return;
      }
      for (;;) {
        skipSpace();
        if (open === '{') {
          if (text[at] !== '"') fail();
          scanString();
          skipSpace();
          if (text[at] !== ':') fail();
          at += 1;
        }
        scanValue(depth + 1);
        skipSpace();
        if (text[at] === ',') {
          at += 1;
          continue;
        }
        if (text[at] !== close) fail();
        at += 1;
        return;
      }
    }
    if (open === '"') return scanString();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return;
      }
    }
    JSON_NUMBER.lastIndex = at;
    const number = JSON_NUMBER.exec(text);
    if (number === null) fail();
    at += number![0].length;
  };
  try {
    scanValue(0);
    skipSpace();
    if (at < text.length) fail();
    return null;
  } catch (error) {
    if (error instanceof RangeError && /^[0-9]+$/.test(error.message)) return Number(error.message);
    return null;
  }
}

function jsonErrorPosition(text: string): string {
  const offset = jsonErrorOffset(text);
  if (offset === null) return 'position unknown';
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return `position ${offset}, line ${line}, column ${column}`;
}

const compiledBySha = new Map<string, PrivateTermRule[]>();

/**
 * Load the term file named by `env`. Never throws: the result says whether rules
 * were loaded and, if not, why. Compiled rules are cached by the sha256 of the
 * exact file bytes, so a changed file is always re-read and re-compiled.
 */
export function loadPrivateTerms(env: NodeJS.ProcessEnv): PrivateTermsLoad {
  const required = privateTermsRequired(env);
  const label = privateTermsPathLabel(env);
  const read = readTermBytes(privateTermsPath(env));
  if (read.status === 'absent') {
    return { status: 'absent', required, sha256: null, rules: [], problem: null };
  }
  if (read.status === 'unreadable') {
    return { status: 'unreadable', required, sha256: null, rules: [], problem: `private term file is unreadable (${label})` };
  }
  // One snapshot: these bytes are hashed, parsed and compiled; nothing re-reads the file.
  const sha256 = createHash('sha256').update(read.bytes).digest('hex');
  const cached = compiledBySha.get(sha256);
  if (cached !== undefined) return { status: 'loaded', required, sha256, rules: cached, problem: null };
  const text = read.bytes.toString('utf8');
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // JSON.parse error text quotes the input around the error; report a position only.
    return {
      status: 'invalid',
      required,
      sha256,
      rules: [],
      problem: `private term file is not valid JSON (${label}, ${jsonErrorPosition(text)})`,
    };
  }
  try {
    const rules = compilePrivateTerms(document);
    compiledBySha.set(sha256, rules);
    return { status: 'loaded', required, sha256, rules, problem: null };
  } catch (error) {
    const detail = error instanceof InvalidTermsFile ? error.message : 'unexpected compile failure';
    return { status: 'invalid', required, sha256, rules: [], problem: `private term file is invalid (${label}): ${detail}` };
  }
}

/**
 * Rules for a scan, or a PrivateTermsError when the file state forbids the scan:
 * an unreadable or invalid file, or an absent file under
 * WHATSOUP_REQUIRE_PRIVATE_TERMS=1.
 */
export function requirePrivateTermsUsable(load: PrivateTermsLoad): readonly PrivateTermRule[] {
  if (load.status === 'loaded') return load.rules;
  if (load.status === 'absent') {
    if (load.required) {
      throw new PrivateTermsError(
        'private term file absent and WHATSOUP_REQUIRE_PRIVATE_TERMS=1; set WHATSOUP_PRIVATE_TERMS_FILE or create ~/.config/whatsoup/private-terms.json',
      );
    }
    return [];
  }
  throw new PrivateTermsError(load.problem ?? 'private term file cannot be used');
}

/** Expand a replacement template: `{N}` is group N of the term's own regex (empty when absent). */
export function expandPrivateTermReplacement(rule: PrivateTermRule, matched: string): string {
  const groups = rule.coreRegex.exec(matched);
  return rule.replace.replace(/\{([1-9])\}/g, (_whole, digit: string) => groups?.[Number(digit)] ?? '');
}
