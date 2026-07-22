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
  kind: 'fail-open-probe' | 'duplicate-zero-count';
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

/**
 * Scan a single bash script's text. Returns findings where a variable is
 * captured with a sentinel-on-failure AND later gated on success only, with no
 * fail-closed signal anywhere referencing that variable's inconclusive path.
 */
export function scanGateScript(relPath: string, content: string): GateFinding[] {
  const lines = content.split(/\r?\n/);
  const findings: GateFinding[] = [];

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
      `fail-closed-gate-guard: no fail-open gate or duplicate-zero counter shapes found in ${scannedFiles} shell file(s) under ${presentRoots.join(', ')} (invariant.fail-closed-gate)`,
    );
    return;
  }
  console.error('fail-closed-gate-guard: fail-open gate or duplicate-zero counter shape(s) detected (invariant.fail-closed-gate):');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} ${f.detail}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
