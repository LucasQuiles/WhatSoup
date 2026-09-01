#!/usr/bin/env node
// scripts/resolved-override-inventory-guard.ts
//
// CI inventory guard for #3435 (rev-3438 follow-up 2). `ExecutingSessionContext.resolved`
// (src/mcp/types.ts) is an explicit override: `resolved: true` flips an all-undefined
// executing context from the UNRESOLVED (fail-closed) state to 'resolved', which makes the
// scheduled-agent-job forbidden-tool set reachable again. It exists for exactly one reason —
// the direct-registry TEST adapter snapshots a caller-built session instead of reading a live
// executing-turn register — and it has ZERO production callers. Before this guard the only
// thing standing between a future production caller and reopening the fail-open was a
// docstring. Family exemplar: scripts/grant-resolver-inventory-guard.ts.
//
// The guard fails the build when the `resolved` key is SET on an executing-context object
// literal (or assigned as a property) anywhere under src/ or tests/ outside an explicit,
// count-pinned allowlist of the permitted test-only sites.
//
// WHAT IS MATCHED (on comment-stripped, string-blanked source):
//   (a) `executing-literal`: an object literal that sets `resolved` (any value other than a
//       bare `false`; quoted and shorthand keys included, plus the SPELLED `['resolved']`
//       computed form — a key assembled at runtime is not) AND is recognisably an executing
//       context — it also carries one of the required keys `actorJid` / `purpose` /
//       `conversationKey`, or a spread (`...executing`). A fresh ExecutingSessionContext
//       literal must carry all three keys or spread them, so this marker set is complete for
//       the direct-literal shape wherever it appears. A conditional expression's TRUE branch
//       (`flag ? { ...executing, resolved: true } : executing`) is a literal for this rule.
//   (b) `machinery-file-literal`: the same `resolved` key on a marker-less literal (e.g.
//       `Object.assign(ctx, { resolved: true })`, `{ resolved: true } as ExecutingSessionContext`)
//       in a file that names the executing-context machinery (ExecutingSessionContext /
//       resolveSessionContext / noExecutingSession / resolveExecutingSession).
//   (c) `property-assignment`: `<expr>.resolved = <value>` / `<expr>['resolved'] = <value>`
//       (plain or `??=` / `||=`) with a value other than the literal `false`, in any scanned
//       file.
//
// WHAT IS NOT MATCHED. This list is the guard's honesty contract, and the summary at the end
// claims no more than the list allows. Every entry was reproduced against the guard binary.
//   - destructuring patterns (`const { resolved, ...rest } = ctx`, type-annotated parameter
//     patterns) read the field, they do not set it — excluded;
//   - `resolved: false` never asserts resolution (resolveSessionContext honours `=== true`
//     only) — ignored. Only a BARE `false` closed by a terminator is exempt: `false || force`
//     and `false ? a : true` are FLAGGED, through the literal and the assignment rule alike.
//     So is `false as const`, a deliberate over-flag in the fail-closed direction;
//   - a marker-less `{ resolved: true }` literal in a file that names none of the machinery
//     tokens and reaches the type only through an intermediary is not caught;
//   - a key assembled at runtime (`['resol' + 'ved']`) and a reflective write
//     (`Object.defineProperty(ctx, 'resolved', { value: true })`) are NOT caught. The scanner
//     matches spelled keys and direct property writes only;
//   - `.tsx` / `.jsx` are not candidates — a limit with a reason, not an oversight. `</div>`
//     puts `/` immediately after `<`, which the regex-literal heuristic reads as a regex
//     opening, so the lexer would blank forward and UNDER-report, the dangerous direction for
//     a fail-closed rail. `src/` carries no JSX today; every `.tsx` under a scan root is
//     console/browser test code. Files outside the two SCAN_ROOTS are likewise not candidates;
//   - the scanner is lexical, not a type-checker: it recognises string, template, comment
//     and (heuristically) regex literals, so a pathological regex literal can still
//     desynchronise it for the rest of one file.
//
// WHAT THIS RAIL DOES NOT COVER AT ALL. `resolveSessionContext` classifies a context
// `'resolved'` on `resolved === true` OR on any defined `actorJid` / `purpose` /
// `conversationKey`. This rail inventories the FIRST spelling only. The second is the
// socket-identity `conversationKey` injection that src/mcp/types.ts documents as standing,
// intentional production behaviour. A green run here is NOT complete coverage of the
// empty-context fail-open.
//
// It is a tripwire for the shapes enumerated above, plus a built-in positive control. It is
// not a proof, and the list of what it misses is part of the claim.
//
// COVERAGE ASSERTIONS (a guard that examined nothing must not pass):
//   - exit 2 INCONCLUSIVE when either scan root (src/, tests/) yielded zero readable files, or
//     when any candidate file could not be read (a read failure is not "no findings");
//   - exit 2 INCONCLUSIVE when an allowlisted site produced ZERO matches — the allowlist
//     doubles as the detector's positive control: if the pattern silently stopped matching,
//     the known sites would vanish first, and the guard refuses to certify instead of passing
//     vacuously;
//   - exit 1 BLOCK on any finding outside the allowlist, or when an allowlisted file's match
//     count differs from its pinned count (a new site in an audited file is still a new site).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type ResolvedOverrideRule =
  | 'executing-literal'
  | 'machinery-file-literal'
  | 'property-assignment';

export interface ResolvedOverrideFinding {
  file: string;
  line: number;
  rule: ResolvedOverrideRule;
  detail: string;
}

export interface ResolvedOverrideAllowlistEntry {
  file: string;
  /** Exact number of override sites the row excuses; more OR fewer is a failure. */
  expectedMatches: number;
  reason: string;
}

export interface ResolvedOverrideAllowlistTally {
  entry: ResolvedOverrideAllowlistEntry;
  matches: number;
}

/**
 * A scan result that carries HOW MUCH was examined, not just what was found. Zero findings
 * over zero files is "I never looked", which must not read as clean (#2102 discipline).
 */
export interface ResolvedOverrideScan {
  /** Findings OUTSIDE the allowlist — each one is a block. */
  findings: ResolvedOverrideFinding[];
  /** Per-row match counts for the allowlisted files (the positive control). */
  allowlisted: ResolvedOverrideAllowlistTally[];
  /** Readable `.ts` files examined per scan root. */
  filesExamined: Record<ScanRoot, number>;
  /** Candidate files that could not be read — any entry makes the scan inconclusive. */
  unreadable: string[];
}

export const EXIT_PASS = 0;
export const EXIT_BLOCK = 1;
export const EXIT_INCONCLUSIVE = 2;

export const SCAN_ROOTS = ['src', 'tests'] as const;
export type ScanRoot = (typeof SCAN_ROOTS)[number];

/**
 * The complete inventory of permitted `resolved` override sites. Every row is TEST-ONLY by
 * construction (the production tree must stay at zero). A reviewer adding a row must explain
 * why the site cannot reach the gate through a real executing-turn resolution instead; a
 * reviewer changing `expectedMatches` is auditing a new site, not tidying a count.
 */
export const RESOLVED_OVERRIDE_ALLOWLIST: ReadonlyArray<ResolvedOverrideAllowlistEntry> = [
  {
    file: 'tests/helpers/resolved-tool-registry.ts',
    expectedMatches: 1,
    reason:
      'Direct-registry test adapter: it snapshots a caller-built SessionContext instead of reading a live executing-turn register, so it asserts resolution unconditionally to model a real (resolved-normal) turn. Tests of the UNRESOLVED path must not use this adapter.',
  },
  {
    file: 'tests/mcp/registry-scheduled-agent-job-three-state.test.ts',
    expectedMatches: 1,
    reason:
      'Three-state gate spec, case (b): proves an explicitly asserted all-undefined resolved-normal turn keeps the forbidden set reachable (no over-restriction). The assertion under test IS the override.',
  },
];

const MACHINERY_TOKEN_RE =
  /\b(?:ExecutingSessionContext|resolveSessionContext|noExecutingSession|resolveExecutingSession)\b/;
const MARKER_KEY_RE = /\b(?:actorJid|purpose|conversationKey)\b/;
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

/** `resolved:` / `'resolved':` / `"resolved":` / `['resolved']:` as an object-literal key. */
const KEY_RE = /(?<![A-Za-z0-9_$.])(?:resolved|'resolved'|"resolved"|\[\s*'resolved'\s*\]|\[\s*"resolved"\s*\])\s*:(?!:)/g;
/** Shorthand `{ ..., resolved }` / `{ resolved, ... }` (value is a same-named variable). */
const SHORTHAND_RE = /(?<![A-Za-z0-9_$.])resolved(?=\s*[,}])/g;
/** `x.resolved = v` / `x['resolved'] = v`, plain or `??=` / `||=` (never `==` / `=>`). */
const ASSIGN_RE = /(?:\.\s*resolved|\[\s*'resolved'\s*\]|\[\s*"resolved"\s*\])\s*(?:\?\?|\|\|)?=(?![=>])/g;

/**
 * Module extensions the walker treats as candidates: `.ts` / `.mts` / `.cts` / `.js` / `.mjs` /
 * `.cjs`. `.tsx` and `.jsx` are DELIBERATELY excluded, and the exclusion is a limit, not an
 * oversight: a JSX closing tag puts `/` immediately after `<`, which `precededByRegexContext`
 * reads as the start of a regex literal, so the lexer would blank forward from `</div>` and
 * UNDER-report — the dangerous direction for a fail-closed rail. `src/` carries no JSX today;
 * every `.tsx` under a scan root is console/browser test code.
 */
const SCANNED_EXT_RE = /\.[cm]?[tj]s$/;

/**
 * Chars after which a `/` starts a regex literal rather than a division. Conservative:
 * anything else (identifier char, `)`, `]`, digit) is treated as division.
 */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'yield', 'await', 'throw', 'delete', 'void', 'instanceof', 'new']);

export interface BlankedSource {
  /** Comments blanked (same length); string / template / regex contents INTACT. */
  code: string;
  /** Comments AND string / template / regex CONTENTS blanked (same length); delimiters kept. */
  structure: string;
}

function precededByRegexContext(source: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (source[i] === ' ' || source[i] === '\t' || source[i] === '\r')) i -= 1;
  if (i < 0) return true;
  const ch = source[i];
  if (REGEX_PRECEDERS.has(ch)) return true;
  if (!IDENT_CHAR_RE.test(ch)) return false;
  let start = i;
  while (start > 0 && IDENT_CHAR_RE.test(source[start - 1])) start -= 1;
  return REGEX_PRECEDING_KEYWORDS.has(source.slice(start, i + 1));
}

/**
 * Single-pass lexer that blanks comments (in both views) and string / template / regex
 * literal CONTENTS (structure view only), preserving length and newlines so offsets and
 * line numbers stay aligned. String-aware, so a `//` inside a URL string is not a comment
 * and a quote inside a comment does not open a string — the desynchronisation modes a
 * regex-only stripper suffers. Template `${...}` expressions are blanked with the template.
 */
export function blankCommentsAndStrings(content: string): BlankedSource {
  const code = content.split('');
  const structure = content.split('');
  const n = content.length;
  const blankBoth = (i: number): void => {
    if (content[i] !== '\n') {
      code[i] = ' ';
      structure[i] = ' ';
    }
  };
  const blankStructure = (i: number): void => {
    if (content[i] !== '\n') structure[i] = ' ';
  };
  let i = 0;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && content[i] !== '\n') {
        blankBoth(i);
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      blankBoth(i);
      blankBoth(i + 1);
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {
        blankBoth(i);
        i += 1;
      }
      if (i < n) {
        blankBoth(i);
        blankBoth(i + 1);
        i += 2;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      i += 1;
      while (i < n && content[i] !== ch && content[i] !== '\n') {
        if (content[i] === '\\') {
          blankStructure(i);
          i += 1;
        }
        if (i < n) blankStructure(i);
        i += 1;
      }
      i += 1; // closing delimiter (or the newline that terminated an unterminated literal)
      continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < n && content[i] !== '`') {
        if (content[i] === '\\') {
          blankStructure(i);
          i += 1;
        }
        if (i < n) blankStructure(i);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && precededByRegexContext(content, i)) {
      i += 1;
      let inClass = false;
      while (i < n && content[i] !== '\n' && (inClass || content[i] !== '/')) {
        if (content[i] === '\\') {
          blankStructure(i);
          i += 1;
        } else if (content[i] === '[') {
          inClass = true;
        } else if (content[i] === ']') {
          inClass = false;
        }
        if (i < n) blankStructure(i);
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return { code: code.join(''), structure: structure.join('') };
}

const OPENERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Index of the `{` that DIRECTLY encloses `index` (an unmatched `(` or `[` met first means the
 * key is not a direct member of a brace literal), or -1.
 */
function enclosingBrace(structure: string, index: number): number {
  const stack: string[] = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = structure[i];
    if (ch === ')' || ch === ']' || ch === '}') {
      stack.push(OPENERS[ch]);
    } else if (ch === '(' || ch === '[' || ch === '{') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      } else if (ch === '{') {
        return i;
      } else {
        return -1;
      }
    }
  }
  return -1;
}

/** Index of the bracket matching the opener at `open`, or -1 when unbalanced. */
function matchingClose(structure: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < structure.length; i += 1) {
    const ch = structure[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(CLOSERS[ch]);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return -1;
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** The region's text with everything inside nested brackets blanked (depth-0 view). */
function depthZeroText(structure: string, open: number, close: number): string {
  let depth = 0;
  let out = '';
  for (let i = open + 1; i < close; i += 1) {
    const ch = structure[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      out += ' ';
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      out += ' ';
    } else {
      out += depth === 0 ? ch : ' ';
    }
  }
  return out;
}

function previousToken(structure: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && /\s/.test(structure[i])) i -= 1;
  if (i < 0) return '';
  if (IDENT_CHAR_RE.test(structure[i])) {
    let start = i;
    while (start > 0 && IDENT_CHAR_RE.test(structure[start - 1])) start -= 1;
    return structure.slice(start, i + 1);
  }
  // Two-char operators that matter here (`=>`, `==`, `||`, `&&`, `??`).
  const two = structure.slice(Math.max(0, i - 1), i + 1);
  if (two === '=>' || two === '||' || two === '&&' || two === '??') return two;
  return structure[i];
}

function nextNonSpace(structure: string, index: number): string {
  let i = index;
  while (i < structure.length && /\s/.test(structure[i])) i += 1;
  return i < structure.length ? structure.slice(i, i + 2) : '';
}

const LITERAL_PRECEDERS = new Set(['(', ',', '=', ':', '?', '[', '||', '&&', '??', 'return', 'yield', 'await', 'throw', 'default']);
const DESTRUCTURING_PRECEDERS = new Set(['const', 'let', 'var']);

/**
 * Is the `{` at `open` an OBJECT-LITERAL EXPRESSION (as opposed to a block, class / interface
 * / enum body, type literal, or destructuring pattern)?
 */
function isObjectLiteralExpression(structure: string, open: number, close: number): boolean {
  const before = previousToken(structure, open);
  if (DESTRUCTURING_PRECEDERS.has(before)) return false;
  if (!LITERAL_PRECEDERS.has(before)) return false;
  // Statement separators at depth 0 mean a block or a type / interface body, never a literal.
  if (depthZeroText(structure, open, close).includes(';')) return false;
  // `{ ... }: Type` and `{ ... } = value` are destructuring patterns (parameter / assignment) —
  // EXCEPT when the literal is a conditional expression's TRUE branch, where the trailing `:` is
  // the ternary's own separator, not a type annotation. Rejecting those unconditionally let a
  // feature-flagged `flag ? { ...executing, resolved: true } : executing` skip ALL THREE literal
  // rules, which is the likeliest real re-introduction shape (#3435 F1). A `?` preceder plus a
  // trailing `:` is a ternary: a destructuring parameter is never preceded by `?` (an optional
  // parameter writes `{ a }?: T`, whose preceder is `(` or `,`).
  const after = nextNonSpace(structure, close + 1);
  const isTernaryTrueBranch = before === '?';
  if (after.startsWith(':') && !isTernaryTrueBranch) return false;
  if (after.startsWith('=') && !after.startsWith('==') && !after.startsWith('=>')) return false;
  return true;
}

/** Characters that can legitimately END a value expression, so a bare `false` stops there. */
const VALUE_TERMINATORS = new Set([',', '}', ')', ']', ';']);

/**
 * The literal `false` AND NOTHING ELSE as the value starting at `index`.
 *
 * The terminator requirement is load-bearing. Matching a leading `false` and merely checking the
 * next character is not an identifier char let every truthy-capable expression that BEGINS with
 * `false` inherit the `resolved: false` exemption — `false || force`, `false ? a : true`, and the
 * same shapes through the shared assignment rule (#3435 F2). Each of those asserts resolution at
 * runtime. Anything that is not exactly `false` followed by a terminator is treated as a live
 * value, so `resolved: false as const` is flagged too: over-flagging a safe value is the
 * fail-closed direction, and a reviewer can answer it with an allowlist row.
 */
function valueIsLiteralFalse(structure: string, index: number): boolean {
  let i = index;
  while (i < structure.length && /\s/.test(structure[i])) i += 1;
  if (structure.slice(i, i + 5) !== 'false') return false;
  let end = i + 5;
  while (end < structure.length && /\s/.test(structure[end])) end += 1;
  return end >= structure.length || VALUE_TERMINATORS.has(structure[end]);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function insideBlankedLiteral(blanked: BlankedSource, index: number): boolean {
  return blanked.structure[index] !== blanked.code[index];
}

function normalizeRel(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

/**
 * Scan ONE file's content. Pure: no filesystem access, so fixtures can be fed directly.
 * Returns EVERY override site (allowlisting is applied by the repo scan, not here).
 */
export function scanFileForResolvedOverrides(relPath: string, content: string): ResolvedOverrideFinding[] {
  const file = normalizeRel(relPath);
  const blanked = blankCommentsAndStrings(content);
  const { code, structure } = blanked;
  const machineryFile = MACHINERY_TOKEN_RE.test(structure);
  const findings: ResolvedOverrideFinding[] = [];
  const seenKeys = new Set<number>();

  const considerKey = (keyIndex: number, valueIndex: number | null, shorthand: boolean): void => {
    if (seenKeys.has(keyIndex)) return;
    if (insideBlankedLiteral(blanked, keyIndex)) return;
    const open = enclosingBrace(structure, keyIndex);
    if (open < 0) return;
    const close = matchingClose(structure, open);
    if (close < 0) return;
    if (!isObjectLiteralExpression(structure, open, close)) return;
    if (valueIndex !== null && valueIsLiteralFalse(structure, valueIndex)) return;
    const depthZero = depthZeroText(structure, open, close);
    const executingShaped = MARKER_KEY_RE.test(depthZero) || depthZero.includes('...');
    if (!executingShaped && !machineryFile) return;
    seenKeys.add(keyIndex);
    const how = shorthand ? 'shorthand `resolved` (dynamic value)' : 'sets `resolved`';
    if (executingShaped) {
      findings.push({
        file,
        line: lineOf(content, keyIndex),
        rule: 'executing-literal',
        detail: `executing-context object literal ${how} — the fail-closed UNRESOLVED branch is bypassed here; resolve through a real executing-turn register entry, or add a count-pinned test-only allowlist row (#3435)`,
      });
    } else {
      findings.push({
        file,
        line: lineOf(content, keyIndex),
        rule: 'machinery-file-literal',
        detail: `object literal ${how} in a file that names the executing-context machinery — the fail-closed UNRESOLVED branch may be bypassed here; resolve through a real executing-turn register entry, or add a count-pinned test-only allowlist row (#3435)`,
      });
    }
  };

  KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_RE.exec(code)) !== null) {
    considerKey(match.index, match.index + match[0].length, false);
  }
  SHORTHAND_RE.lastIndex = 0;
  while ((match = SHORTHAND_RE.exec(code)) !== null) {
    considerKey(match.index, null, true);
  }
  ASSIGN_RE.lastIndex = 0;
  while ((match = ASSIGN_RE.exec(code)) !== null) {
    if (insideBlankedLiteral(blanked, match.index)) continue;
    if (valueIsLiteralFalse(structure, match.index + match[0].length)) continue;
    findings.push({
      file,
      line: lineOf(content, match.index),
      rule: 'property-assignment',
      detail: 'assigns `.resolved` on an existing context — the fail-closed UNRESOLVED branch is bypassed here; resolve through a real executing-turn register entry, or add a count-pinned test-only allowlist row (#3435)',
    });
  }
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

function walkTsFiles(root: string, dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an absent root yields zero candidates, which the caller refuses to certify
  }
  entries.sort();
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      acc.push(path.relative(root, full)); // surfaces as unreadable below, never skipped
      continue;
    }
    if (st.isDirectory()) {
      walkTsFiles(root, full, acc);
    } else if (SCANNED_EXT_RE.test(entry)) {
      acc.push(path.relative(root, full));
    }
  }
}

/**
 * Scan every `.ts` file under each scan root of `cwd`, reporting findings outside the
 * allowlist, per-row allowlist tallies, per-root examined counts, and unreadable files.
 */
export function scanRepoResolvedOverridesCounted(cwd: string): ResolvedOverrideScan {
  const filesExamined: Record<ScanRoot, number> = { src: 0, tests: 0 };
  const unreadable: string[] = [];
  const tallies = new Map<string, number>(RESOLVED_OVERRIDE_ALLOWLIST.map((entry) => [entry.file, 0]));
  const findings: ResolvedOverrideFinding[] = [];
  for (const root of SCAN_ROOTS) {
    const candidates: string[] = [];
    walkTsFiles(cwd, path.join(cwd, root), candidates);
    for (const rel of candidates) {
      let content: string;
      try {
        content = readFileSync(path.join(cwd, rel), 'utf8');
      } catch {
        unreadable.push(normalizeRel(rel));
        continue;
      }
      filesExamined[root] += 1;
      const fileFindings = scanFileForResolvedOverrides(rel, content);
      if (fileFindings.length === 0) continue;
      const key = normalizeRel(rel);
      if (tallies.has(key)) {
        tallies.set(key, (tallies.get(key) ?? 0) + fileFindings.length);
      } else {
        findings.push(...fileFindings);
      }
    }
  }
  return {
    findings,
    allowlisted: RESOLVED_OVERRIDE_ALLOWLIST.map((entry) => ({ entry, matches: tallies.get(entry.file) ?? 0 })),
    filesExamined,
    unreadable,
  };
}

const TAG = 'resolved-override-inventory-guard';

function main(): number {
  const cwd = process.cwd();
  const scan = scanRepoResolvedOverridesCounted(cwd);
  const examined = SCAN_ROOTS.map((root) => `${root}/=${scan.filesExamined[root]}`).join(', ');

  const emptyRoots = SCAN_ROOTS.filter((root) => scan.filesExamined[root] === 0);
  if (emptyRoots.length > 0) {
    // A location check (does the directory exist) is not a work check (were files read).
    console.error(
      `${TAG}: INCONCLUSIVE — examined 0 source file(s) under ${emptyRoots.map((root) => path.join(cwd, root)).join(' and ')} (${examined}). ` +
        'A scan that read nothing cannot certify the resolved-override inventory, which is not a pass.',
    );
    return EXIT_INCONCLUSIVE;
  }
  if (scan.unreadable.length > 0) {
    console.error(`${TAG}: INCONCLUSIVE — ${scan.unreadable.length} candidate file(s) could not be read (a read failure is not "no findings"):`);
    for (const file of scan.unreadable) console.error(`  ${file}`);
    return EXIT_INCONCLUSIVE;
  }

  let inconclusive = false;
  let block = false;
  for (const { entry, matches } of scan.allowlisted) {
    if (matches === 0) {
      inconclusive = true;
      console.error(
        `${TAG}: INCONCLUSIVE — allowlisted site ${entry.file} produced 0 matches (expected ${entry.expectedMatches}). ` +
          'The allowlist is the detector\'s positive control: either the site moved (update the inventory row) or the detector no longer matches — neither certifies the tree.',
      );
    } else if (matches !== entry.expectedMatches) {
      block = true;
      console.error(
        `${TAG}: ${entry.file} has ${matches} resolved-override site(s) but the inventory pins ${entry.expectedMatches} — ` +
          'audit the new site (or the removal) and update expectedMatches deliberately (invariant.3435-resolved-override-inventory).',
      );
    }
  }
  if (scan.findings.length > 0) {
    block = true;
    console.error(
      `${TAG}: resolved-override site(s) outside the test-only allowlist — a production caller setting \`resolved\` reopens the empty-context fail-open #3438 closed (invariant.3435-resolved-override-inventory):`,
    );
    for (const f of scan.findings) console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.detail}`);
  }
  if (inconclusive) return EXIT_INCONCLUSIVE;
  if (block) return EXIT_BLOCK;

  const pinned = scan.allowlisted.map(({ entry, matches }) => `${entry.file}=${matches}`).join(', ');
  console.log(
    `${TAG}: no resolved-override sites outside the test-only allowlist across ${examined} source file(s); ` +
      `inventory pinned (${pinned}) (invariant.3435-resolved-override-inventory)`,
  );
  return EXIT_PASS;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
