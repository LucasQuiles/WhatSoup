/**
 * check-service-units.ts — deterministic validity guard for WhatSoup deploy
 * artifacts (launchd plists + systemd units).
 *
 * This session hand-wrote ~15 service units and shipped several unit-level
 * defects that no test caught. This guard makes those defect classes
 * deterministically detectable at lint time:
 *
 *   1. LABEL SPLIT — a launchd plist named com.whatsoup.X.plist whose <Label>
 *      is not com.whatsoup.X (the com.whatsoup.fleet vs
 *      com.whatsoup.whatsoup-fleet split, and the watchdog FLEET_LABEL pointing
 *      at a non-existent label).
 *   2. BARE INTERPRETER / UNEXPANDED VARS — a plist that execs a bare
 *      /opt/homebrew/bin/node (which on this host is v26, violating the
 *      `<26` engines pin), or `/usr/bin/env node` where a pinned path is
 *      required, or that embeds a literal ${VAR} in a <string> value (launchd
 *      does NOT expand shell variables — the reply-guarantee defect).
 *   3. NODE PIN — any concrete node path in a unit must resolve to the
 *      .nvmrc-pinned major (DRY with the engines range in package.json).
 *   4. PATH PLAUSIBILITY — StandardOut/StandardError, WorkingDirectory, and
 *      ProgramArguments[0] must be absolute + structurally well-formed.
 *   5. STRUCTURAL VALIDITY — every plist must be a structurally valid plist
 *      (plutil -lint on macOS, with a portable XML/structural fallback for
 *      Linux CI).
 *
 * The check is importable (for vitest) and runnable as a CLI guard. A baseline
 * file (scripts/service-units-baseline.json) may grandfather known exceptions
 * by `file::code` key.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UnitKind = 'launchd' | 'systemd';

export type ViolationCode =
  | 'label-mismatch'
  | 'bare-homebrew-node'
  | 'env-node-where-pinned-required'
  | 'unexpanded-var-in-plist'
  | 'secret-environment-file'
  | 'node-pin-mismatch'
  | 'non-absolute-path'
  | 'malformed-program-arguments'
  | 'invalid-plist-structure';

export interface Violation {
  /** Repo-relative path of the offending unit file. */
  file: string;
  kind: UnitKind;
  code: ViolationCode;
  message: string;
  /** Baseline key: `${file}::${code}`. */
  key: string;
}

export interface CheckOptions {
  cwd?: string;
  /** Override the unit files to scan (repo-relative). Defaults to deploy/ discovery. */
  files?: string[];
  /** Skip `plutil -lint` even on macOS (used by tests for portability). */
  skipPlutil?: boolean;
  /** Baseline keys to suppress (grandfathered exceptions). */
  baseline?: Set<string>;
}

export interface CheckResult {
  canonicalMajor: number;
  scanned: string[];
  violations: Violation[];
  /** Violations suppressed by the baseline. */
  suppressed: Violation[];
}

// ---------------------------------------------------------------------------
// Canonical node major (DRY with the node-pin gate / .nvmrc)
// ---------------------------------------------------------------------------

/** Read the .nvmrc-pinned major version (e.g. 24). Throws if unreadable. */
export function readCanonicalNodeMajor(cwd: string): number {
  const nvmrc = readFileSync(path.join(cwd, '.nvmrc'), 'utf8').trim();
  const m = nvmrc.match(/^(\d+)/);
  if (!m) {
    throw new Error(`.nvmrc does not start with a numeric version: "${nvmrc}"`);
  }
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// Unit discovery
// ---------------------------------------------------------------------------

/** Default set of committed deploy units to validate. */
export function discoverUnitFiles(cwd: string): string[] {
  const deployDir = path.join(cwd, 'deploy');
  if (!existsSync(deployDir)) return [];
  const entries = readdirSync(deployDir);
  const files: string[] = [];
  for (const name of entries) {
    if (
      name.endsWith('.plist') ||
      name.endsWith('.service') ||
      name.endsWith('.timer')
    ) {
      files.push(path.posix.join('deploy', name));
    }
  }
  return files.sort();
}

export function unitKind(file: string): UnitKind {
  return file.endsWith('.plist') ? 'launchd' : 'systemd';
}

// ---------------------------------------------------------------------------
// Minimal plist parsing (portable, no external deps)
// ---------------------------------------------------------------------------

interface PlistShape {
  label: string | null;
  /** ProgramArguments <string> entries, in order. */
  programArguments: string[];
  /** Raw text of every <string> value in the document. */
  allStrings: string[];
  /** Values keyed by simple top-level <key>. Only captures scalar string keys. */
  scalarKeys: Record<string, string>;
}

const STRING_TAG = /<string>([\s\S]*?)<\/string>/g;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Structural plist parse sufficient for our checks. Returns null if the
 * document is not structurally a plist (missing <plist>/<dict>, unbalanced
 * tags). This is the portable fallback for `plutil -lint`.
 */
export function parsePlist(rawText: string): PlistShape | null {
  // Strip XML comments — their contents (including example $HOME / ${VAR}
  // documentation) are not part of the loaded plist and must not be scanned.
  // Loop to a fixpoint: one pass over overlapping sequences can leave a
  // reassembled `<!--` behind (js/incomplete-multi-character-sanitization).
  let text = rawText;
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '');
  }
  if (!/<plist[\s>]/.test(text) || !/<\/plist>/.test(text)) return null;
  if (!/<dict>/.test(text) || !/<\/dict>/.test(text)) return null;

  // Balance check for the core container tags.
  const openDict = (text.match(/<dict>/g) ?? []).length;
  const closeDict = (text.match(/<\/dict>/g) ?? []).length;
  if (openDict !== closeDict) return null;
  const openArr = (text.match(/<array>/g) ?? []).length;
  const closeArr = (text.match(/<\/array>/g) ?? []).length;
  if (openArr !== closeArr) return null;

  const allStrings: string[] = [];
  let m: RegExpExecArray | null;
  STRING_TAG.lastIndex = 0;
  while ((m = STRING_TAG.exec(text)) !== null) {
    allStrings.push(decodeXmlEntities(m[1]));
  }

  // Extract <key>Label</key><string>...</string>.
  const labelMatch = text.match(
    /<key>\s*Label\s*<\/key>\s*<string>([\s\S]*?)<\/string>/,
  );
  const label = labelMatch ? decodeXmlEntities(labelMatch[1]).trim() : null;

  // Extract ProgramArguments array entries.
  const programArguments: string[] = [];
  const paMatch = text.match(
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (paMatch) {
    let pm: RegExpExecArray | null;
    const inner = paMatch[1];
    const innerRe = /<string>([\s\S]*?)<\/string>/g;
    while ((pm = innerRe.exec(inner)) !== null) {
      programArguments.push(decodeXmlEntities(pm[1]));
    }
  }

  // Capture a few scalar keys we path-check (WorkingDirectory, Std*Path).
  const scalarKeys: Record<string, string> = {};
  for (const key of [
    'WorkingDirectory',
    'StandardOutPath',
    'StandardErrorPath',
  ]) {
    const km = text.match(
      new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`),
    );
    if (km) scalarKeys[key] = decodeXmlEntities(km[1]);
  }

  return { label, programArguments, allStrings, scalarKeys };
}

// ---------------------------------------------------------------------------
// Interpreter classification
// ---------------------------------------------------------------------------

const BARE_HOMEBREW_NODE = /^\/opt\/homebrew\/bin\/node$/;
const BARE_USRLOCAL_NODE = /^\/usr\/local\/bin\/node$/;
// Acceptable pinned node forms — must carry a version that we then range-check.
const NVM_NODE = /\/\.nvm\/versions\/node\/v(\d+)\.\d+\.\d+\/bin\/node$/;
const HOMEBREW_VERSIONED_NODE = /\/opt\/homebrew\/opt\/node@(\d+)\/bin\/node$/;
// Any token that resolves to a node binary: an absolute path ending in
// `/node` (or `/bin/node`), or the bare word `node`. Used to enforce a
// CLOSED-WORLD allowlist — an unrecognized node binary must be flagged, not
// silently passed (e.g. /opt/homebrew/Cellar/node/26.x/bin/node, /usr/bin/node).
const NODE_BINARY = /(?:^|\/)node$/;
// Shell interpreters whose `-c` payload smuggles the real exec vector past
// per-token classification.
const SHELL_INTERPRETER = /(?:^|\/)(?:ba|da|z|a|k)?sh$/;
// `${VAR}` or `$VAR` literal embedded in a plist string (launchd never expands).
// The bare form uses `*` (not `+`) so single-char vars like `$i`/`$_` also match.
const UNEXPANDED_VAR = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;
// Documented install-time substitution token. Unlike a shell `${VAR}` (which
// launchd silently fails to expand), `__HOME__` is a sentinel that setup.sh
// replaces with the operator's absolute home via `sed` BEFORE the plist is
// loaded. It is therefore install-correct, not a launchd-expansion defect.
const INSTALL_TOKEN = /^__[A-Z][A-Z0-9_]*__(?:\/|$)/;
// A path is the wrapper if it ends in a whatsoup* launcher under .local/bin or deploy.
const WHATSOUP_WRAPPER =
  /(?:\.local\/bin\/|deploy\/)whatsoup(?:-[a-z-]+)?$/;

/**
 * Inspect a single interpreter/exec token. Returns a violation code (and the
 * node major it parsed, when relevant) or null if acceptable.
 */
function classifyInterpreter(
  token: string,
  canonicalMajor: number,
): { code: ViolationCode; detail: string } | null {
  if (token === '/usr/bin/env') {
    // `/usr/bin/env node` — env-based interpreter resolution is non-deterministic
    // and resolves to whatever node is first on PATH (here, v26).
    return {
      code: 'env-node-where-pinned-required',
      detail: `${token} resolves node non-deterministically from PATH; use a pinned-node path or the whatsoup wrapper`,
    };
  }
  if (BARE_HOMEBREW_NODE.test(token) || BARE_USRLOCAL_NODE.test(token)) {
    return {
      code: 'bare-homebrew-node',
      detail: `${token} is a mutable bare-node symlink (currently violates the <${canonicalMajor + 1} engines pin); use a versioned node path or the whatsoup wrapper`,
    };
  }
  const nvm = token.match(NVM_NODE);
  if (nvm) {
    const major = Number(nvm[1]);
    if (major !== canonicalMajor) {
      return {
        code: 'node-pin-mismatch',
        detail: `${token} pins node ${major}, but .nvmrc canonical major is ${canonicalMajor}`,
      };
    }
    return null;
  }
  const brew = token.match(HOMEBREW_VERSIONED_NODE);
  if (brew) {
    const major = Number(brew[1]);
    if (major !== canonicalMajor) {
      return {
        code: 'node-pin-mismatch',
        detail: `${token} pins node@${major}, but .nvmrc canonical major is ${canonicalMajor}`,
      };
    }
    return null;
  }
  // The whatsoup* wrapper (which resolves the pinned node + repo root itself)
  // is the canonical interpreter and is explicitly allowed.
  if (WHATSOUP_WRAPPER.test(token)) return null;
  // CLOSED WORLD: any other token that resolves to a node binary is an
  // unrecognized, un-version-checked node — flag it. A bare `node` (no path
  // separator) in argv0 is already reported as non-absolute-path, but a bare
  // `node` elsewhere (e.g. after /usr/bin/env or in a shell payload) must be
  // caught here.
  if (NODE_BINARY.test(token)) {
    return {
      code: 'bare-homebrew-node',
      detail: `${token} is an unrecognized node binary (not a whitelisted nvm v${canonicalMajor}.x.x, node@${canonicalMajor}, or whatsoup wrapper path); use a pinned-node path or the whatsoup wrapper`,
    };
  }
  return null;
}

/**
 * If `tokens` is a shell-wrapper exec vector (e.g. `/bin/bash -c "node app"`),
 * return the words of the `-c` payload so the caller can classify the smuggled
 * interpreter. Returns null when the vector is not a recognized shell wrapper.
 */
function shellPayloadTokens(tokens: string[]): string[] | null {
  if (tokens.length === 0) return null;
  let exe = tokens[0];
  let rest = tokens.slice(1);
  // `/usr/bin/env bash -c ...` — unwrap the env prefix to reach the shell.
  if (exe === '/usr/bin/env' && rest.length > 0) {
    exe = rest[0];
    rest = rest.slice(1);
  }
  if (!SHELL_INTERPRETER.test(exe)) return null;
  const dashC = rest.indexOf('-c');
  if (dashC === -1 || dashC + 1 >= rest.length) return null;
  // The payload is the remainder joined; split on whitespace and strip quotes.
  const payload = rest.slice(dashC + 1).join(' ');
  return payload
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Path plausibility
// ---------------------------------------------------------------------------

/** systemd specifiers (%h, %i, ...) and EnvironmentFile are valid leading tokens. */
const SYSTEMD_SPECIFIER = /^%[a-zA-Z]/;

function isStructurallyAbsolute(p: string): boolean {
  // An install-time token prefix (e.g. __HOME__/...) is substituted to an
  // absolute path before load, so treat it as structurally absolute.
  if (INSTALL_TOKEN.test(p)) return true;
  return p.startsWith('/');
}

// ---------------------------------------------------------------------------
// Violation accumulation
// ---------------------------------------------------------------------------

/**
 * Build a push() that disambiguates repeated (file, code) pairs. The first
 * occurrence keeps the stable `${file}::${code}` key (so a single baseline
 * entry suppresses exactly one occurrence); subsequent occurrences get a
 * `::#N` suffix so each distinct violation is independently addressable in the
 * baseline and not collectively masked.
 */
function makePusher(
  out: Violation[],
  file: string,
  kind: UnitKind,
): (code: ViolationCode, message: string) => void {
  const seen = new Map<ViolationCode, number>();
  return (code, message) => {
    const n = seen.get(code) ?? 0;
    seen.set(code, n + 1);
    const key = n === 0 ? `${file}::${code}` : `${file}::${code}::#${n}`;
    out.push({ file, kind, code, message, key });
  };
}

// ---------------------------------------------------------------------------
// launchd plist validation
// ---------------------------------------------------------------------------

function validateLaunchd(
  file: string,
  text: string,
  canonicalMajor: number,
  cwd: string,
  skipPlutil: boolean,
): Violation[] {
  const out: Violation[] = [];
  const push = makePusher(out, file, 'launchd');

  // 5. Structural validity.
  let structurallyValid = true;
  if (!skipPlutil && process.platform === 'darwin') {
    const abs = path.join(cwd, file);
    try {
      execFileSync('plutil', ['-lint', abs], { stdio: 'pipe' });
    } catch {
      structurallyValid = false;
      push('invalid-plist-structure', `plutil -lint rejected ${file}`);
    }
  }
  const shape = parsePlist(text);
  if (!shape) {
    if (structurallyValid) {
      push(
        'invalid-plist-structure',
        `${file} is not a structurally valid plist (missing/unbalanced <plist>/<dict>/<array>)`,
      );
    }
    // Without a parse we cannot run the structural checks below.
    return out;
  }

  // 1. Label == filename stem.
  const stem = path.basename(file, '.plist');
  if (shape.label === null) {
    push('label-mismatch', `${file} has no <Label> key (expected ${stem})`);
  } else if (shape.label !== stem) {
    push(
      'label-mismatch',
      `${file} Label is "${shape.label}" but filename stem is "${stem}" (label split)`,
    );
  }

  // 2/3. Interpreter + unexpanded vars across ProgramArguments.
  const args = shape.programArguments;
  if (args.length === 0) {
    push(
      'malformed-program-arguments',
      `${file} has no ProgramArguments entries`,
    );
  } else {
    // 4. ProgramArguments[0] must be absolute (or a systemd specifier — not in plists).
    const argv0 = args[0];
    if (!isStructurallyAbsolute(argv0) && !UNEXPANDED_VAR.test(argv0)) {
      push(
        'non-absolute-path',
        `${file} ProgramArguments[0] "${argv0}" is not an absolute path`,
      );
    }
    // env/node/bare-node anywhere in the exec vector matters; argv0 most.
    // A shell-wrapper (`/bin/bash -c "node ..."`) smuggles the real interpreter
    // into the -c payload, so classify those tokens too.
    const payload = shellPayloadTokens(args);
    const classifyTokens = payload ? [...args, ...payload] : args;
    for (const tok of classifyTokens) {
      const verdict = classifyInterpreter(tok, canonicalMajor);
      if (verdict) push(verdict.code, `${file}: ${verdict.detail}`);
    }
  }

  // 2 (cont). Unexpanded ${VAR} / $VAR in ANY <string> value (launchd literal).
  for (const s of shape.allStrings) {
    if (UNEXPANDED_VAR.test(s)) {
      const varMatch = s.match(UNEXPANDED_VAR);
      push(
        'unexpanded-var-in-plist',
        `${file} contains literal shell variable "${varMatch?.[0]}" in <string> "${s}" — launchd does not expand variables`,
      );
    }
  }

  // 4. Path plausibility for known path keys.
  for (const [key, val] of Object.entries(shape.scalarKeys)) {
    if (UNEXPANDED_VAR.test(val)) continue; // already reported above
    if (!isStructurallyAbsolute(val)) {
      push(
        'non-absolute-path',
        `${file} ${key} "${val}" is not an absolute path`,
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// systemd unit validation
// ---------------------------------------------------------------------------

const EXEC_DIRECTIVE = /^(ExecStart|ExecStartPre|ExecStop|ExecReload)=(.*)$/;

function validateSystemd(
  file: string,
  text: string,
  canonicalMajor: number,
): Violation[] {
  const out: Violation[] = [];
  const push = makePusher(out, file, 'systemd');

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^EnvironmentFile=.*(?:\/secrets\.env|\/instances\/%i\/tokens\.env)$/.test(line)) {
      push(
        'secret-environment-file',
        `${file} projects a managed secret file into the parent process; resolve credentials at the use boundary instead`,
      );
    }
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(EXEC_DIRECTIVE);
    if (!m) continue;
    let value = m[2].trim();
    // Strip a leading `-` / `@` / `+` exec prefix (systemd modifiers).
    value = value.replace(/^[-@+!]+/, '');
    const tokens = value.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const exe = tokens[0];

    // ExecStart[0] must be absolute or a systemd specifier (%h/.local/bin/...).
    const startsWithSpecifier = SYSTEMD_SPECIFIER.test(exe);
    if (!isStructurallyAbsolute(exe) && !startsWithSpecifier) {
      push(
        'non-absolute-path',
        `${file} ${m[1]} "${exe}" is not absolute (systemd requires an absolute path or %-specifier)`,
      );
    }

    // Interpreter checks apply to every exec token (catches bare node / env
    // node). Shell-wrapped vectors (`/bin/bash -c "node ..."`) smuggle the real
    // interpreter into the -c payload, so classify those tokens too.
    const payload = shellPayloadTokens(tokens);
    const classifyTokens = payload ? [...tokens, ...payload] : tokens;
    for (const tok of classifyTokens) {
      if (tok === '/usr/bin/env') {
        // `/usr/bin/env <shell> -c ...` is unwrapped by shellPayloadTokens, so
        // only flag env when it is the actual interpreter-resolution mechanism
        // (env node), not an env-bash wrapper we have already descended into.
        if (!payload) {
          push(
            'env-node-where-pinned-required',
            `${file} ${m[1]} uses /usr/bin/env — bind a versioned interpreter or the whatsoup wrapper`,
          );
        }
        continue;
      }
      const verdict = classifyInterpreter(tok, canonicalMajor);
      if (verdict) push(verdict.code, `${file} ${m[1]}: ${verdict.detail}`);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Top-level check
// ---------------------------------------------------------------------------

export function loadBaseline(cwd: string): Set<string> {
  const p = path.join(cwd, 'scripts', 'service-units-baseline.json');
  if (!existsSync(p)) return new Set();
  // Fail closed: a corrupt baseline is surfaced loudly rather than silently
  // dropped. A swallowed parse error would either hide a genuine guard failure
  // (lost suppression) or mask a tampered baseline — both are real signals.
  let data: { grandfathered?: string[] };
  try {
    data = JSON.parse(readFileSync(p, 'utf8')) as { grandfathered?: string[] };
  } catch (err) {
    throw new Error(
      `service-units baseline ${p} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (data.grandfathered !== undefined && !Array.isArray(data.grandfathered)) {
    throw new Error(
      `service-units baseline ${p}: "grandfathered" must be an array of "file::code" keys`,
    );
  }
  return new Set(data.grandfathered ?? []);
}

export function checkServiceUnits(options: CheckOptions = {}): CheckResult {
  const cwd = options.cwd ?? process.cwd();
  const canonicalMajor = readCanonicalNodeMajor(cwd);
  const files = options.files ?? discoverUnitFiles(cwd);
  const baseline = options.baseline ?? loadBaseline(cwd);
  const skipPlutil = options.skipPlutil ?? false;

  const all: Violation[] = [];
  for (const file of files) {
    const abs = path.join(cwd, file);
    const text = readFileSync(abs, 'utf8');
    if (unitKind(file) === 'launchd') {
      all.push(...validateLaunchd(file, text, canonicalMajor, cwd, skipPlutil));
    } else {
      all.push(...validateSystemd(file, text, canonicalMajor));
    }
  }

  const violations: Violation[] = [];
  const suppressed: Violation[] = [];
  for (const v of all) {
    if (baseline.has(v.key)) suppressed.push(v);
    else violations.push(v);
  }

  return { canonicalMajor, scanned: files, violations, suppressed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function run(
  _argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): CheckResult {
  const result = checkServiceUnits({ cwd });
  console.log(
    `service-units guard: scanned ${result.scanned.length} unit(s); canonical node major ${result.canonicalMajor}`,
  );
  if (result.suppressed.length > 0) {
    console.warn(
      `  ${result.suppressed.length} violation(s) suppressed by baseline`,
    );
  }
  if (result.violations.length > 0) {
    console.error(`service-units guard FAILED: ${result.violations.length} violation(s)`);
    for (const v of result.violations) {
      console.error(`  [${v.code}] ${v.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log('service-units guard passed (all units valid)');
  }
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
