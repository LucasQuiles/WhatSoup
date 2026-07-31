/**
 * shell-node-integer-capture-guard — flags `node -e`/`node -p` output captured via shell
 * command substitution into a variable that later reaches an integer comparison
 * (`-eq`/`-ne`/`-gt`/`-lt`/`-ge`/`-le` or arithmetic `(( ))`) without a safety net.
 *
 * Root cause (#2449, fixed by #2450): `console/scripts/design-regression.sh` Check 15
 * captured a count through `console.log(<number>)`. `console.log` formats a non-string
 * argument via `util.inspect`, which colourises numbers whenever `FORCE_COLOR` is set —
 * even when stdout is a pipe, not a TTY. The captured value became
 * `$'\033[33m0\033[39m'`, and `[ "$C15_COUNT" -eq 0 ]` died with "integer expected",
 * hard-blocking `git push` on any machine with `FORCE_COLOR` exported while reporting a
 * waiver mismatch that did not exist. #2454 is the sweep-and-prevent follow-up: the
 * population is 3 `node -e`/`node -p` captures across 2 files today (all safe), but
 * nothing stops the next `COUNT=$(... | node -e 'console.log(n)')` from reintroducing it.
 *
 * #2454 documents `deploy/setup.sh`'s immunity as resting on TWO INDEPENDENT reasons,
 * either of which alone would have prevented #2449. This guard treats a capture as SAFE
 * when either holds:
 *   (a) emitter-safe — the node script never funnels the captured value through
 *       `console.log(...)`; it writes via `process.stdout.write(...)` (or nothing
 *       formatter-prone) instead. `node -p` cannot take this path: its result is always
 *       printed through the same util.inspect-based auto-print `console.log` uses, with
 *       no way to opt out, so a `node -p` capture only ever qualifies via (b).
 *   (b) validated — a `grep -qE '^[0-9]+$'`-style numeric-format check that references
 *       the SAME captured variable appears before the integer-comparison use.
 * A capture is flagged only when NEITHER applies.
 *
 * Deliberately narrow: only variables assigned directly from a `node -e`/`node -p`
 * command substitution are tracked, and a tracked variable that never reaches an integer
 * comparison (e.g. printed as a display string, as `design-regression.sh`'s
 * `WAIVER_SYNC_SUMMARY` is) is never flagged. Generalising to arbitrary subprocess
 * captures compared as sentinels is `fail-closed-gate-guard`'s territory (a different
 * capture shape entirely: `VAR=$(cmd || echo sentinel)` vs. this guard's
 * `VAR=$(... | node -e '...')`); this guard stays scoped to the class #2454 swept.
 *
 * Known limitations (documented, not silently absorbed):
 *   - The `node -e`/`-p` invocation must open on the SAME line as the variable
 *     assignment (`VAR=$(node -e '` / `VAR="$(... | node -e '`). A capture whose node
 *     invocation is introduced only on a later line of a multi-line subshell is not
 *     recognised. Both real sites in this repo satisfy this shape.
 *   - Emitter safety is heuristic: ANY `console.log(` found in the captured node script
 *     marks the emission unsafe, even a call that only ever prints an already-formatted
 *     string (as `WAIVER_SYNC_SUMMARY`'s six `console.log(` template-literal calls do).
 *     That imprecision never surfaces as a finding unless the SAME variable also reaches
 *     an integer comparison — trading a possible over-broad internal classification for
 *     a simple, auditable rule.
 *   - A `grep -qE '^[0-9]+$'` validation is only recognised when the grep call and the
 *     `$VAR`/`${VAR}` reference are on the SAME line, matching this repo's idiom
 *     (`printf '%s' "$VAR" | grep -qE '^[0-9]+$'`). A validation split across lines is
 *     not recognised.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CaptureFinding {
  file: string;
  line: number;
  variable: string;
  kind: 'unvalidated-node-integer-capture';
  detail: string;
}

type NodeMode = 'e' | 'p';

interface Capture {
  variable: string;
  captureLine: number; // 1-indexed
  mode: NodeMode;
  scriptText: string;
  /** 0-indexed last line consumed by the capture's own invocation span. */
  endLineIndex: number;
}

// `VAR=$(` or `VAR="$(` — the two real-site opening shapes in this repo.
const CAPTURE_OPEN_RE = /^(?<var>[A-Za-z_][A-Za-z0-9_]*)="?\$\(/;
// Anchored on `node -e '`/`node -p '` specifically (not "the first quote on the line")
// so an earlier unrelated single-quoted argument on the same line — e.g.
// `printf '%s' "$X" | node -e '...` — does not get mistaken for the script's own quote.
const NODE_FLAG_RE = /\bnode\s+-(?<mode>[ep])\s+'/;
const GREP_QE_RE = /\bgrep\s+-[A-Za-z]*(?:qE|Eq)[A-Za-z]*\b/;
const NUMERIC_ANCHOR_RE = /\^\[0-9\]\+\$/;
const COMPARE_OPS = 'eq|ne|gt|lt|ge|le';

/** Sane bound on a captured node -e/-p script body; real ones here run under 25 lines. */
const MAX_SCRIPT_LINES = 500;

/**
 * Find every `VAR=$(node -e|-p '...)` capture in a script's lines. Handles both the
 * single-line shape (`design-regression.sh:428`, the whole invocation on one line) and
 * the multi-line shape (`deploy/setup.sh:135-143`, `design-regression.sh:430-451` — the
 * opening quote is the last character on its line and the script body runs for several
 * lines before a line whose trimmed content starts with the closing `'`).
 */
function findCaptures(lines: string[]): Capture[] {
  const captures: Capture[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const openMatch = trimmed.match(CAPTURE_OPEN_RE);
    if (!openMatch?.groups?.var) continue;
    const flagMatch = line.match(NODE_FLAG_RE);
    if (!flagMatch || flagMatch.index === undefined) continue; // no node -e/-p opened here

    const scriptStart = flagMatch.index + flagMatch[0].length;
    const mode = flagMatch.groups?.mode as NodeMode;
    const restOfLine = line.slice(scriptStart);
    const closeIdx = restOfLine.indexOf("'");

    let scriptText: string;
    let endLineIndex: number;
    if (closeIdx !== -1) {
      scriptText = restOfLine.slice(0, closeIdx);
      endLineIndex = i;
    } else {
      const parts = [restOfLine];
      let j = i + 1;
      for (; j < lines.length && j - i < MAX_SCRIPT_LINES; j++) {
        const next = lines[j]!;
        if (next.trim().startsWith("'")) {
          parts.push(next.slice(0, next.indexOf("'")));
          break;
        }
        parts.push(next);
      }
      scriptText = parts.join('\n');
      endLineIndex = Math.min(j, lines.length - 1);
    }

    captures.push({ variable: openMatch.groups.var, captureLine: i + 1, mode, scriptText, endLineIndex });
    i = endLineIndex; // resume scanning after the consumed span
  }
  return captures;
}

/** Arm (a): the node script never routes the captured value through console.log. */
function isEmitterSafe(capture: Capture): boolean {
  if (capture.mode === 'p') {
    // `node -p` auto-prints its result via the same util.inspect-based path
    // `console.log` uses — there is no console.log call to avoid, so it can never
    // qualify here. Only arm (b) (grep -qE validation) can clear a `-p` capture.
    return false;
  }
  return !/\bconsole\.log\s*\(/.test(capture.scriptText);
}

/**
 * Arm (b): earliest line, per captured variable, carrying a `grep -qE '^[0-9]+$'`-style
 * check that also references that variable on the SAME line — matching this repo's
 * `printf '%s' "$VAR" | grep -qE '^[0-9]+$'` idiom.
 */
function findValidatedLines(lines: string[], variables: ReadonlySet<string>): Map<string, number> {
  const validatedAt = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith('#')) continue;
    if (!GREP_QE_RE.test(line) || !NUMERIC_ANCHOR_RE.test(line)) continue;
    for (const v of variables) {
      if (!new RegExp(`\\$\\{?${v}\\b`).test(line)) continue;
      const existing = validatedAt.get(v);
      if (existing === undefined || i + 1 < existing) validatedAt.set(v, i + 1);
    }
  }
  return validatedAt;
}

/** Left-operand, right-operand, and arithmetic-context comparison shapes for one variable. */
function comparisonRes(v: string): RegExp[] {
  return [
    new RegExp(`\\$\\{?${v}\\}?["']?\\s+-(?:${COMPARE_OPS})\\b`),
    new RegExp(`-(?:${COMPARE_OPS})\\s+["']?\\$\\{?${v}\\}?\\b`),
    new RegExp(`\\(\\([^\\n]*\\b${v}\\b[^\\n]*\\)\\)`),
  ];
}

interface ScriptScan {
  findings: CaptureFinding[];
  captureCount: number;
}

function scanScriptDetailed(relPath: string, content: string): ScriptScan {
  const lines = content.split(/\r?\n/);
  const captures = findCaptures(lines);
  if (captures.length === 0) return { findings: [], captureCount: 0 };

  const byVar = new Map(captures.map((c) => [c.variable, c] as const));
  const validatedAt = findValidatedLines(lines, new Set(byVar.keys()));

  const findings: CaptureFinding[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith('#')) continue;
    for (const [variable, capture] of byVar) {
      if (i <= capture.endLineIndex) continue; // not the capture's own invocation span
      const [left, right, arithmetic] = comparisonRes(variable);
      if (!left!.test(line) && !right!.test(line) && !arithmetic!.test(line)) continue;

      const key = `${variable}:${i}`;
      if (seen.has(key)) continue;

      const validatedLine = validatedAt.get(variable);
      const safe = isEmitterSafe(capture) || (validatedLine !== undefined && validatedLine <= i + 1);
      if (safe) continue;

      seen.add(key);
      findings.push({
        file: relPath,
        line: i + 1,
        variable,
        kind: 'unvalidated-node-integer-capture',
        detail:
          `\`${variable}\` captured from \`node -${capture.mode}\` at ${relPath}:${capture.captureLine} ` +
          'reaches an integer comparison here with no intervening `grep -qE \'^[0-9]+$\'`-style numeric ' +
          'validation, and its node script does not guarantee formatter-safe output. Avoid ' +
          '`console.log(<value>)`; use `process.stdout.write(String(<value>))`, or validate before the ' +
          'comparison. See #2449/#2454.',
      });
    }
  }
  return { findings, captureCount: captures.length };
}

/** Pure, findings-only view of a single script's text. Unit tests use this. */
export function scanScript(relPath: string, content: string): CaptureFinding[] {
  return scanScriptDetailed(relPath, content).findings;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.worktrees']);
// Harness isolation worktrees of OTHER branches (see check-insecure-tempfile.ts's
// documented incidents, 2026-07-04 / 2026-07-19) — their content is gated by their own
// pushes and must not gate this checkout's.
const SKIP_RELPATHS = new Set(['.claude/worktrees']);
const SHELL_EXT_RE = /\.(sh|bash)$/;

function walkShellFiles(root: string, dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_RELPATHS.has(path.relative(root, abs))) continue;
      walkShellFiles(root, abs, acc);
    } else if (SHELL_EXT_RE.test(name)) {
      acc.push(path.relative(root, abs));
    }
  }
}

export interface RepoScanResult {
  findings: CaptureFinding[];
  /** Shell (.sh/.bash) files actually read. Zero means the pass carries no evidence. */
  scannedFiles: number;
  /** Total `node -e`/`node -p` captures seen across the scan, flagged or not. */
  totalCaptures: number;
}

/**
 * Repo-wide scan, reporting what was EXAMINED alongside the findings — mirroring the
 * non-vacuity contract `check-insecure-tempfile` and `fail-closed-gate-guard` already
 * hold: a scanner that silently reads nothing must not be able to report "clean".
 *
 * This guard adds a second, class-specific refusal beyond "0 files read": a repo-wide
 * scan that reads real shell files but happens to see 0 `node -e`/`node -p` captures at
 * all would also report "clean" vacuously — for THIS guard, that is as uninformative as
 * reading 0 files, since the guard exists to police exactly that capture shape.
 *
 * Walks the FULL repo tree (not a curated subset of directories) because the population
 * this guard defends against can appear in any shell script — #2454's own sweep covered
 * "all shell scripts in the repo", not a curated subset, and a future regression is just
 * as plausible under `tests/`, `docker/`, or `docs/` (which carry `.sh` files today) as
 * under `scripts/`/`deploy/`.
 */
export function scanRepoDetailed(root: string): RepoScanResult {
  const relPaths: string[] = [];
  walkShellFiles(root, root, relPaths);

  if (relPaths.length === 0) {
    throw new Error(
      `examined 0 shell (.sh/.bash) files under ${root} — refusing to report "clean" for a ` +
        'tree that was never read (inconclusive)',
    );
  }

  const findings: CaptureFinding[] = [];
  let totalCaptures = 0;
  for (const rel of relPaths) {
    const content = readFileSync(path.join(root, rel), 'utf8');
    const scan = scanScriptDetailed(rel, content);
    totalCaptures += scan.captureCount;
    findings.push(...scan.findings);
  }

  if (totalCaptures === 0) {
    throw new Error(
      `examined ${relPaths.length} shell file(s) under ${root} but found 0 \`node -e\`/\`node -p\` ` +
        'captures — refusing to certify a class-guard against an empty population (inconclusive)',
    );
  }

  return { findings, scannedFiles: relPaths.length, totalCaptures };
}

/** Findings-only view, for callers that already know the scan was non-vacuous. */
export function scanRepo(root: string): CaptureFinding[] {
  return scanRepoDetailed(root).findings;
}

function main(): number {
  const root = process.argv[2] ?? process.cwd();
  let result: RepoScanResult;
  try {
    result = scanRepoDetailed(root);
  } catch (err) {
    console.error(`[shell-node-integer-capture-guard] FATAL ${(err as Error).message}`);
    return 2;
  }
  const { findings, scannedFiles, totalCaptures } = result;
  if (findings.length === 0) {
    console.log(
      `[shell-node-integer-capture-guard] clean (0 unvalidated captures across ${totalCaptures} ` +
        `node -e/-p capture(s) in ${scannedFiles} shell file(s))`,
    );
    return 0;
  }
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.detail}`);
  console.error(`[shell-node-integer-capture-guard] ${findings.length} unvalidated capture(s) — BLOCK`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
