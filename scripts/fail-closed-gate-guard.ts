/**
 * fail-closed-gate-guard — wires the registry rule `invariant.fail-closed-gate`
 * (declared with rings ['guard','hook'] but previously unenforced) into the
 * guard ring.
 *
 * It scans committed bash gate scripts for two shell fail-closed hazards:
 *
 * 1. The fail-OPEN probe shape the
 * `writing-fail-closed-gates` skill warns about: a probe that substitutes a
 * sentinel value on failure (`|| echo "000"`, `|| echo ""`, `|| true`) and then
 * gates only on the SUCCESS code (`== "200"` / `= "200"`) without an explicit
 * branch that fails the gate on the inconclusive/unexpected value. Such a gate
 * silently passes on 000/5xx/timeouts — unknown state treated as success.
 *
 * 2. The duplicate-zero counter shape `grep -c ... || echo 0`. `grep -c` already
 * prints `0` when there are no matches and then exits 1, so `|| echo 0` emits a
 * two-line `0\n0` value. In arithmetic gates that becomes an unexpected syntax
 * error; in string comparisons it can silently skip the intended branch.
 *
 * 3. `execution.pipeline.status-incomplete`: a pipeline whose exit status is
 * CONSUMED while `pipefail` is not in effect. A pipeline reports only its LAST
 * command's status, so `git push origin main | tail -5` exits 0 for a push the
 * remote rejected — that happened here and reported a branch as landed when it
 * had not been. `set -e` does not catch it; the shell considers the pipeline
 * successful. Only fail-OPEN pipelines are flagged: `producer | grep -q` already
 * fails closed, because a dead head produces no output and the predicate then
 * returns false. See PREDICATE_TAIL_RE.
 *
 * This is the complement to test-integrity's `bash-curl-without-fail`: that rule
 * fires when a curl has no `--fail`/status assertion at all; THIS rule fires
 * when the script DOES capture a status into a sentinel but then forgets the
 * fail-closed branch. The test-integrity regex actually clears a line once it
 * sees `2[0-9][0-9]`, so this fail-open shape passes it — the exact gap.
 *
 * Deterministic and line-pair scoped to keep false positives low:
 *   - A finding requires BOTH a sentinel-substitution capture AND a later
 *     success-only gate on the same captured variable, within the same file,
 *     with NO fail-closed branch (`!= "<expected>"`, `-z`, `fail_infra`,
 *     `inconclusive`, `exit` on the non-success path) that REFERENCES THAT SAME
 *     captured variable. The suppression is per-variable (the fail-closed signal
 *     must co-occur with `$var` on a line) so an unrelated `!= "prod"` branch
 *     elsewhere in the file cannot silence a genuine probe finding.
 *   - Only scans files that look like gates (`*gate*`, `*verify*`, `*check*`,
 *     `*probe*`, `*ready*`, or under deploy/ + scripts/) with a `.sh`/`.bash`
 *     extension. Matches the skill's "when to use" surface.
 *
 * Severity: the registry declares `block`. The guard exits 1 on findings.
 *
 * Source: feedback:writing_fail_closed_gates, feedback:shell_exit_via_pipe,
 *         audit:detector-misconceptions#bash-http-probe-fail-open.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface GateFinding {
  kind: 'fail-open-probe' | 'duplicate-zero-count' | 'masked-pipeline-status';
  file: string;
  line: number;
  variable: string;
  detail: string;
}

const GATE_NAME_RE = /(gate|verify|check|probe|ready|preflight|pre-flight|health|rotat)/i;
const GATE_EXT_RE = /\.(sh|bash)$/;

// `code=$(... || echo "000")`  /  `resp=$(... || true)` etc. Captures the var.
const SENTINEL_CAPTURE_RE =
  /(?:^|\b)(?<var>[A-Za-z_][A-Za-z0-9_]*)=.*\|\|\s*(?:echo\s*["']?(?<sentinel>000|)["']?|true|:)\b/;

// `grep -c` prints "0" on no matches before exiting 1; `|| echo 0` adds a second zero.
const DUPLICATE_ZERO_COUNT_RE =
  /\bgrep\b(?=[^#\n]*\s(?:-[A-Za-z]*c[A-Za-z]*|--count)\b)[^#\n]*\|\|\s*echo\s+["']?0["']?\b/;

// A success-only gate: `[ "$code" = "200" ]` / `[ "$code" == "200" ]` / `if [ "$resp" = "PONG" ]`.
function successGateFor(line: string): { variable: string; expected: string } | null {
  const m = line.match(
    /\[\s*["']?\$\{?(?<var>[A-Za-z_][A-Za-z0-9_]*)\}?["']?\s*==?\s*["']?(?<expected>[A-Za-z0-9]+)["']?\s*\]/,
  );
  if (!m?.groups) return null;
  return { variable: m.groups.var, expected: m.groups.expected };
}

// Signals that the author HAS handled the inconclusive / non-success path.
// Note: `-z`/`-n` are anchored with a non-word/non-dash lookbehind because a
// plain `\b-z` never matches (space→`-` is not a word boundary).
const FAIL_CLOSED_SIGNAL_RE =
  /!=\s*["']?[A-Za-z0-9]+["']?|(?<![\w-])-[zn]\b|\binconclusive\b|\bfail_infra\b|\bfail_actionable\b|\bUNKNOWN\b|\bexit\s+[1-9]/i;

// ── execution.pipeline.status-incomplete ────────────────────────────────────

/**
 * Blank out single- and double-quoted spans so a `|` inside a string literal is not read
 * as a pipeline. `grep -Eq "alpha|beta"` is an alternation; flagging it would be noise,
 * and noise is how a guard gets turned off. Length is preserved so column math survives.
 */
function blankQuotedSpans(line: string): string {
  return line.replace(/'[^']*'|"[^"]*"/g, (span) => span[0] + ' '.repeat(span.length - 2) + span[0]);
}

/** Strip a trailing `#` comment, after quotes are blanked so `"#"` is not mistaken for one. */
function stripComment(blanked: string): string {
  const hash = blanked.search(/(?:^|\s)#/);
  return hash === -1 ? blanked : blanked.slice(0, hash);
}

/** A real pipeline: a single `|` that is not part of `||` and not the `|&` redirect form. */
const PIPELINE_RE = /(?<!\|)\|(?!\||&)/;

interface PipefailToggle {
  enabled: boolean;
  index: number;
}

/**
 * Find positional `pipefail` state changes, including the `+o` disable form.
 * Bash accepts both `set -o pipefail` and combined flags such as
 * `set -euo pipefail`; the same shapes with `+` disable the option.
 */
function pipefailToggles(code: string): PipefailToggle[] {
  const toggles: PipefailToggle[] = [];
  const patterns = [
    /\bset\s+(?:[-+][A-Za-z]+\s+)*(?<flag>[-+]o)\s+pipefail\b/g,
    /\bset\s+(?<flag>[-+][A-Za-z]*o[A-Za-z]*)\s+pipefail\b/g,
  ];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const flag = match.groups?.flag;
      if (!flag || match.index === undefined) continue;
      const key = `${match.index}:${match[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toggles.push({ enabled: flag.startsWith('-'), index: match.index });
    }
  }
  return toggles.sort((a, b) => a.index - b.index);
}

/** Status-consuming positions: `if`/`while`/`until`/`elif` conditions. */
const CONDITION_RE = /^\s*(?:if|elif|while|until)\s+/;

/** Inline status test on the same line: `pipeline || fail` / `pipeline && next`. */
const INLINE_STATUS_TEST_RE = /\|\||&&/;

/**
 * `|| true` and `|| :` DISCARD the status rather than consume it — the author has said, in
 * the shell's own idiom, that this pipeline is allowed to fail. Treating that as a
 * consumption would flag `count=$(... | grep -c x || true)`, which is correct code.
 */
const STATUS_DISCARD_RE = /\|\|\s*(?:true|:)\s*(?:$|[)&;|])/;

/** A read of the previous command's status. */
const STATUS_READ_RE = /\$\?/;

/**
 * Split a line into pipeline segments on single `|` (not `||`, not `|&`).
 * Quotes must already be blanked, or an alternation inside a string would split the line.
 */
function pipelineSegments(code: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '|') continue;
    if (code[i + 1] === '|' || code[i + 1] === '&') {
      i += 1; // skip `||` / `|&` wholesale
      continue;
    }
    if (i > 0 && code[i - 1] === '|') continue;
    segments.push(code.slice(start, i));
    start = i + 1;
  }
  segments.push(code.slice(start));
  return segments;
}

/** Split a shell command into enough words to distinguish stdin grep from grep-with-files. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (!word) return;
    words.push(word);
    word = '';
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === ';' || char === '&') {
      push();
      break;
    }
    word += char;
  }
  push();
  return words;
}

/**
 * Return true only for the narrow predicate exemption that actually consumes stdin:
 * `producer | grep -q pattern` / `producer | grep -c pattern` (and rg/egrep forms).
 * `test`, `[`, and `grep -q pattern file` ignore the pipe and can mask producer failure.
 */
function isStdinPredicateTail(tail: string): boolean {
  const words = shellWords(tail);
  if (words[0] === '!') words.shift();
  const command = words.shift();
  if (!command || !['grep', 'egrep', 'rg'].includes(path.basename(command))) return false;

  const hasPredicateFlag = words.some(
    (word) => /^-[A-Za-z]*[qc][A-Za-z]*$/.test(word) || word === '--quiet' || word === '--count',
  );
  if (!hasPredicateFlag) return false;

  const positional = words.filter((word) => word !== '--' && !word.startsWith('-'));
  return positional.length === 1;
}

function lastPipelineIndex(code: string): number {
  let index = -1;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '|') continue;
    if (code[i + 1] === '|' || code[i + 1] === '&') {
      i += 1;
      continue;
    }
    if (i > 0 && code[i - 1] === '|') continue;
    index = i;
  }
  return index;
}

/**
 * Flag pipelines whose exit status is CONSUMED while `pipefail` is not yet in effect.
 *
 * A pipeline reports the status of its LAST command only. `git push origin main | tail -5`
 * therefore exits 0 for a push the remote rejected — observed in this repo, where it
 * reported a branch as landed that had not been. `set -e` does not help: as far as the
 * shell is concerned the pipeline succeeded.
 *
 * Scoped to consumed status deliberately. A pipeline whose output is the point and whose
 * status nobody reads is not a defect. Consumption means: the pipeline is a condition, its
 * status is tested inline with `||`/`&&`, or the next effective line reads `$?`.
 *
 * `pipefail` is tracked positionally, not file-wide: enabling it on line 40 does nothing
 * for the pipeline on line 3, and a guard that merely asked "is pipefail mentioned" would
 * call that file clean.
 */
function scanMaskedPipelines(relPath: string, lines: string[]): GateFinding[] {
  const findings: GateFinding[] = [];
  const pipefailScopes = [false];

  // Index of the next line that actually runs, so `$?` on the following line is attributed
  // to this pipeline rather than to a blank or a comment in between.
  const nextEffective = (from: number): string | null => {
    for (let j = from; j < lines.length; j++) {
      const s = lines[j].trim();
      if (!s || s.startsWith('#')) continue;
      return stripComment(blankQuotedSpans(lines[j]));
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const code = stripComment(blankQuotedSpans(raw));
    if (/^\s*\(\s*$/.test(code)) {
      pipefailScopes.push(pipefailScopes[pipefailScopes.length - 1] ?? false);
      continue;
    }
    if (/^\s*\)\s*;?\s*$/.test(code)) {
      if (pipefailScopes.length > 1) pipefailScopes.pop();
      continue;
    }

    const scopeIndex = pipefailScopes.length - 1;
    let pipefailActive = pipefailScopes[scopeIndex] ?? false;
    const toggles = pipefailToggles(code);
    const pipelineIndex = lastPipelineIndex(code);
    for (const toggle of toggles) {
      if (pipelineIndex !== -1 && toggle.index > pipelineIndex) break;
      pipefailActive = toggle.enabled;
    }

    if (pipelineIndex === -1) {
      if (toggles.length > 0) pipefailScopes[scopeIndex] = toggles[toggles.length - 1].enabled;
      continue;
    }
    if (pipefailActive) {
      pipefailScopes[scopeIndex] = toggles.at(-1)?.enabled ?? pipefailActive;
      continue;
    }

    const tail = raw.slice(pipelineIndex + 1);
    if (isStdinPredicateTail(tail)) continue;

    const consumedInline =
      CONDITION_RE.test(code) || (INLINE_STATUS_TEST_RE.test(code) && !STATUS_DISCARD_RE.test(code));
    const consumedNext = !consumedInline && STATUS_READ_RE.test(nextEffective(i + 1) ?? '');
    if (!consumedInline && !consumedNext) continue;

    findings.push({
      kind: 'masked-pipeline-status',
      file: relPath,
      line: i + 1,
      variable: 'pipeline',
      detail:
        'this pipeline\'s exit status is consumed, but `pipefail` is not in effect here, so the ' +
        'status reported is the LAST command\'s and an earlier failure passes silently ' +
        '(`git push ... | tail` exits 0 for a rejected push). Add `set -o pipefail` before it, ' +
        'or read `${PIPESTATUS[0]}` instead of `$?`.',
    });

    pipefailScopes[scopeIndex] = toggles.at(-1)?.enabled ?? pipefailActive;
  }
  return findings;
}

/**
 * Scan a single bash script's text. Returns findings where a variable is
 * captured with a sentinel-on-failure AND later gated on success only, with no
 * fail-closed signal anywhere referencing that variable's inconclusive path.
 */
export function scanGateScript(relPath: string, content: string): GateFinding[] {
  const lines = content.split(/\r?\n/);
  const findings: GateFinding[] = scanMaskedPipelines(relPath, lines);

  // Pass 0: malformed count fallback. This does not need cross-line context.
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith('#')) continue;
    if (!DUPLICATE_ZERO_COUNT_RE.test(stripped)) continue;
    findings.push({
      kind: 'duplicate-zero-count',
      file: relPath,
      line: i + 1,
      variable: 'grep-count',
      detail:
        '`grep -c ... || echo 0` emits `0\\n0` when there are no matches. Use `grep -c ... || true` plus an explicit default if needed.',
    });
  }

  // Pass 1: collect sentinel-captured variables and their capture line.
  const captured = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const m = stripped.match(SENTINEL_CAPTURE_RE);
    if (m?.groups?.var) captured.set(m.groups.var, i + 1);
  }
  if (captured.size === 0) return findings;

  // Pass 2: a captured var's inconclusive path is "handled" only when a
  // fail-closed signal appears on a line that ALSO references that same
  // variable ($var). Scoping the suppression to co-referencing lines closes the
  // file-level hole where an unrelated `!= "prod"` branch (or any stray `!=`)
  // would otherwise silence every probe finding in the file.
  const handledVars = new Set<string>();
  for (const line of lines) {
    if (line.trim().startsWith('#')) continue;
    if (!FAIL_CLOSED_SIGNAL_RE.test(line)) continue;
    for (const v of captured.keys()) {
      const ref = new RegExp(`\\$\\{?${v}\\b`);
      if (ref.test(line)) handledVars.add(v);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const gate = successGateFor(stripped);
    if (!gate) continue;
    if (!captured.has(gate.variable)) continue;
    if (handledVars.has(gate.variable)) continue; // inconclusive path handled for THIS var
    findings.push({
      kind: 'fail-open-probe',
      file: relPath,
      line: i + 1,
      variable: gate.variable,
      detail: `gate on \`$${gate.variable} == "${gate.expected}"\` (captured with a failure sentinel at line ${captured.get(gate.variable)}) has no fail-closed branch — 000/5xx/timeout pass silently. Add an explicit \`elif [ "$${gate.variable}" != "<expected>" ]; then fail "inconclusive"\` branch.`,
    });
  }
  return findings;
}

function isGateFile(relPath: string): boolean {
  if (!GATE_EXT_RE.test(relPath)) return false;
  const base = path.basename(relPath);
  if (GATE_NAME_RE.test(base)) return true;
  // deploy/ + scripts/ shell files are gate-surface too.
  return relPath.startsWith('deploy/') || relPath.startsWith('scripts/') || relPath.startsWith('console/scripts/');
}

function walkShellFiles(root: string, dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // missing dir is not a finding; absence is reported by the caller's scope
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkShellFiles(root, full, acc);
    } else if (GATE_EXT_RE.test(entry)) {
      acc.push(path.relative(root, full));
    }
  }
}

const SCAN_ROOTS = ['scripts', 'deploy', '.husky', 'console/scripts'] as const;

export interface RepoScanResult {
  findings: GateFinding[];
  /** Shell files actually read and parsed. Zero means the pass carries no evidence. */
  scannedFiles: number;
  /** Which of SCAN_ROOTS were present. A missing `.husky` is normal; all missing is not. */
  presentRoots: string[];
}

/**
 * Scan the repo, reporting WHAT WAS EXAMINED alongside the findings.
 *
 * A guard that scans nothing and prints "clean" is a false green — the exact bug class this
 * guard exists to catch, so it must not commit it itself. Running it against an empty
 * directory used to give exit 0 and "no shapes found" after examining zero files:
 * `walkShellFiles` swallows a missing directory (reasonably, since `.husky/` may legitimately
 * be absent), but nothing noticed when EVERY root was missing, so a renamed `scripts/` would
 * have quietly reduced this to a no-op that still reported success.
 *
 * Two distinct refusals, because they have different causes and different fixes:
 *   - no scan root present at all → the caller is not at a repo root (wrong cwd, moved tree)
 *   - roots present but no shell file examined → the scope is wrong, or the tree is stripped
 *
 * Both throw, so `main` exits 2 INCONCLUSIVE. "I scanned the tree and it is clean" and
 * "I scanned nothing" must never share an exit code. Mirrors the contract
 * `check-insecure-tempfile` already holds for an unreadable root.
 */
export function scanRepoGatesDetailed(cwd: string): RepoScanResult {
  const candidates: string[] = [];
  const presentRoots: string[] = [];
  for (const sub of SCAN_ROOTS) {
    const full = path.join(cwd, sub);
    let present = false;
    try {
      present = statSync(full).isDirectory();
    } catch {
      present = false;
    }
    if (!present) continue;
    presentRoots.push(sub);
    walkShellFiles(cwd, full, candidates);
  }

  if (presentRoots.length === 0) {
    throw new Error(
      `no scan root present under ${cwd} (looked for ${SCAN_ROOTS.join(', ')}) — ` +
        'refusing to report "clean" for a tree that was never examined (inconclusive)',
    );
  }

  const findings: GateFinding[] = [];
  let scannedFiles = 0;
  for (const rel of candidates) {
    if (!isGateFile(rel)) continue;
    let content: string;
    try {
      content = readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanGateScript(rel, content));
  }

  if (scannedFiles === 0) {
    throw new Error(
      `examined 0 shell files under ${presentRoots.join(', ')} — no shell gate was read, so ` +
        'a "clean" result would carry no evidence (inconclusive)',
    );
  }

  return { findings, scannedFiles, presentRoots };
}

/** Findings-only view, for callers that already know the scan was non-vacuous. */
export function scanRepoGates(cwd: string): GateFinding[] {
  return scanRepoGatesDetailed(cwd).findings;
}

function main(): void {
  const cwd = process.cwd();
  let scan: RepoScanResult;
  try {
    scan = scanRepoGatesDetailed(cwd);
  } catch (err) {
    // Exit 2, not 1: "I could not examine the tree" is not the same answer as "I examined
    // it and found a violation", and neither is the same as clean.
    console.error(`fail-closed-gate-guard: INCONCLUSIVE — ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const { findings, scannedFiles, presentRoots } = scan;
  if (findings.length === 0) {
    // The counts make the pass self-evidencing: a reader can tell it examined real files
    // rather than silently scanning nothing.
    console.log(
      `fail-closed-gate-guard: no fail-open gate, duplicate-zero counter, or masked-pipeline-status shapes found in ${scannedFiles} shell file(s) under ${presentRoots.join(', ')} (invariant.fail-closed-gate, execution.pipeline.status-incomplete)`,
    );
    return;
  }
  console.error(
    'fail-closed-gate-guard: fail-open gate, duplicate-zero counter, or masked-pipeline-status shape(s) detected (invariant.fail-closed-gate, execution.pipeline.status-incomplete):',
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} ${f.detail}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
