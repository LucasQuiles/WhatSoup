/**
 * no-destructive-git-guard.ts — block destructive git cleanup commands in committed
 * shell automation. Implements the `process.no-destructive-git` fitness rule
 * (registry.ts, severity `block`, rings `['guard','hook']`), which was declared but
 * had no enforcer (a false-green). No baseline — fix, don't grandfather.
 *
 * Scan surface: SHELL scripts only — `.sh` files, shebang-detected shell scripts, and
 * every hook under `.husky/` — walked under `scripts/`, `deploy/`, `tools/`, `.husky/`.
 * `.ts`/`.py`/data files are NOT read: the registry rule text and the fitness taxonomy
 * prose NAME these commands in strings, so scanning them would self-flag. The rule's own
 * scope is "committed scripts and hooks".
 *
 * Comments are stripped before matching, quote-aware (a leading-`#` line is skipped whole;
 * a trailing `# …` that starts at a word boundary is dropped; a `#` INSIDE a quoted string
 * is data, not a comment), mirroring `scripts/check-insecure-tempfile.ts`.
 *
 * Matching is COMMAND-POSITION aware, not substring: each line is lexed (quote-aware) into
 * command segments split on unquoted separators (`;`, `&&`, `||`, `|`, `&`); a segment is
 * only tested if — after stripping leading env-assignments (`FOO=bar`) and simple command
 * prefixes (`sudo`, `if`, `then`, …) — its command word is `git`. So a destructive command
 * name that appears only inside a string literal (`echo "… git reset --hard …"`), a message
 * (`MSG="git push --force …"`), or a heredoc body is DATA and is NOT flagged. `git` GLOBAL
 * options before the subcommand (`git -C <dir> …`, `git -c k=v …`, `git --git-dir=… …`) are
 * consumed so they cannot mask the destructive subcommand. Heredoc bodies (`<<EOF … EOF`,
 * `<<-` with leading tabs) are skipped entirely as data.
 *
 * Escape hatch (for legit future recovery/one-off tooling): an inline
 * `# no-destructive-git:allow <reason>` comment ON the offending line, or on the line
 * IMMEDIATELY ABOVE it, suppresses that single finding.
 *
 * The banned set (`DESTRUCTIVE_GIT_PATTERNS`) is a clearly-named exported constant so the
 * owner can broaden/narrow it. Each pattern is whitespace-tolerant and bounded so it does
 * NOT cross a shell command separator (`; & |`) — e.g. `git checkout main && rm -f x`
 * must not be misread as a forced checkout. Patterns run against a NORMALISED
 * `git <subcommand> <args…>` string (global options already stripped), one per segment.
 *
 * Scope note (F5): only committed SHELL scripts/hooks under scripts/deploy/tools/.husky are
 * scanned. `.github/workflows/*.yml` `run:` blocks are intentionally OUT of scope (owner-
 * tuned) — CI YAML is not walked here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Finding {
  file: string;
  line: number;
  /** Human-readable banned-command label, matches a DESTRUCTIVE_GIT_PATTERNS entry. */
  command: string;
  snippet: string;
}

export interface DestructiveGitPattern {
  command: string;
  pattern: RegExp;
}

// Gap between the git subcommand and its destructive flag: any run of characters that
// are NOT a newline or a shell command separator, so a flag belonging to a LATER command
// on the same line (`git checkout main && rm -f x`) is never attributed to the git call.
const GAP = '[^\\n;&|]*?';

/**
 * Banned destructive-git commands. EXPORTED + owner-tunable — add/remove entries to adjust
 * enforcement without touching the scan engine. Derived from the rule rationale
 * ("destructive git cleanup commands"); `--force-with-lease` is intentionally still flagged
 * (less destructive than `--force`, but still rewrites remote history).
 */
export const DESTRUCTIVE_GIT_PATTERNS: ReadonlyArray<DestructiveGitPattern> = [
  // git clean with a force/dir/ignored flag (-f/-d/-x, combined shorts, or --force).
  // Bare `git clean` and any DRY-RUN form are intentionally NOT matched: the leading
  // negative-lookahead exempts the command when `--dry-run` appears OR any short-flag group
  // contains `n` (e.g. `-n`, `-nd`, `-nx`, `-fdn`) — a dry run removes nothing (F3).
  {
    command: 'git clean',
    pattern: new RegExp(
      `\\bgit\\s+clean\\b(?![^\\n;&|]*(?:\\s--dry-run\\b|\\s-[a-zA-Z]*n))${GAP}(?:\\s-[a-zA-Z]*[fdxX]|\\s--force\\b)`,
    ),
  },
  { command: 'git reset --hard', pattern: new RegExp(`\\bgit\\s+reset\\b${GAP}--hard\\b`) },
  { command: 'git checkout --force', pattern: new RegExp(`\\bgit\\s+checkout\\b${GAP}(?:\\s-f\\b|\\s--force\\b)`) },
  { command: 'git switch --force', pattern: new RegExp(`\\bgit\\s+switch\\b${GAP}(?:\\s-f\\b|\\s--force\\b|\\s--discard-changes\\b)`) },
  // `--force` / `--force-with-lease` / `-f` rewrite remote history. The `(?![-\\w])` bound
  // stops `--force` from matching inside `--force-if-includes` / `--force-if-equal`, which
  // are SAFE preconditioned pushes (F4).
  { command: 'git push --force', pattern: new RegExp(`\\bgit\\s+push\\b${GAP}(?:\\s--force(?:-with-lease)?(?![-\\w])|\\s-f\\b)`) },
  { command: 'git branch -D', pattern: new RegExp(`\\bgit\\s+branch\\b${GAP}(?:\\s-[a-zA-Z]*D|\\s--delete\\s+--force\\b|\\s--force\\s+--delete\\b)`) },
  { command: 'git update-ref -d', pattern: new RegExp(`\\bgit\\s+update-ref\\b${GAP}(?:\\s-d\\b|\\s--delete\\b)`) },
  { command: 'git stash clear', pattern: /\bgit\s+stash\s+clear\b/ },
  { command: 'git reflog expire', pattern: /\bgit\s+reflog\s+expire\b/ },
  { command: 'git gc --prune=now', pattern: new RegExp(`\\bgit\\s+gc\\b${GAP}--prune\\s*=\\s*(?:now|all)\\b`) },
  { command: 'git filter-branch', pattern: /\bgit\s+filter-branch\b/ },
  { command: 'git filter-repo', pattern: /\bgit\s+filter-repo\b/ },
];

// The escape hatch marker. A trailing reason is expected but not required to match.
const ALLOW_MARKER = /#\s*no-destructive-git:allow\b/;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.worktrees']);
// Surface roots (relative to the scan root): shell automation + git hooks.
const SURFACE_DIRS = ['scripts', 'deploy', 'tools', '.husky'] as const;
// Shell shebang on the first line (mirrors check-insecure-tempfile's classifier).
const SHELL_SHEBANG = /^#!.*\b(?:ba|da|k|z)?sh\b/;

function isComment(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/** True when `rel` sits under the `.husky/` hooks dir (all shell, may lack a shebang). */
function isHuskyPath(rel: string): boolean {
  return rel === '.husky' || rel.startsWith(`.husky${path.sep}`) || rel.startsWith('.husky/');
}

// `git` GLOBAL options that take a SEPARATE argument token (`-C <dir>`, `-c <k=v>`, …). When
// given in `--opt=val` form the value is part of the same token, so only the `=`-less spellings
// consume a following token. Anything else starting with `-` is a self-contained global flag.
const GIT_GLOBAL_OPTS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

// Leading words that precede a real command and must be stripped before the command word is
// read. Reserved shell keywords (`if`/`then`/…) are included so `if git push --force; then …`
// is still attributed to `git` — omitting them would be a silent false negative in a
// safety-critical guard, and being reserved words they add zero false positives.
const COMMAND_PREFIXES = new Set([
  'sudo', 'command', 'time', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', '\\',
]);

// Heredoc opener on a line: `<<`/`<<-` then an optional-quoted delimiter word. Detected only
// OUTSIDE quotes by the lexer (so `echo "a <<B"` is not mistaken for a heredoc).
interface HeredocState {
  delim: string;
  dash: boolean;
}

/**
 * Quote-aware lexer for a single line. Returns command-position segments (each a token list),
 * split on UNQUOTED separators (`;`, `&&`, `||`, `|`, `&`), stopping at an unquoted comment
 * (`#` at a word boundary), plus any heredoc opened on the line. Quotes/backslashes are kept
 * verbatim inside tokens; separators/comments/heredoc operators inside quotes are inert.
 */
function analyzeLine(line: string): { segments: string[][]; heredoc: HeredocState | null } {
  const segments: string[][] = [];
  let seg: string[] = [];
  let tok = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;
  // Depth of open arithmetic `((` / `$((` on this line. While > 0, a `<<` is a left-shift
  // OPERATOR, not a heredoc opener — so `n=$((1 << 10))` does not spuriously start a heredoc
  // and blind the guard to the rest of the file. Per-line (reset each call), so an unclosed
  // `((` cannot leak across lines.
  let arithDepth = 0;
  let heredoc: HeredocState | null = null;

  const endTok = (): void => {
    if (started) {
      seg.push(tok);
      tok = '';
      started = false;
    }
  };
  const endSeg = (): void => {
    endTok();
    if (seg.length > 0) {
      segments.push(seg);
      seg = [];
    }
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inSingle) {
      tok += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < line.length) {
        tok += ch + line[i + 1];
        i++;
        continue;
      }
      tok += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    // outside quotes
    if (ch === "'") { inSingle = true; tok += ch; started = true; continue; }
    if (ch === '"') { inDouble = true; tok += ch; started = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { tok += ch + line[i + 1]; i++; started = true; continue; }
    if (ch === '#' && !started) break; // unquoted word-boundary `#` → rest of line is a comment
    if (ch === ' ' || ch === '\t') { endTok(); continue; }
    if (ch === ';') { endSeg(); continue; }
    if (ch === '&') { endSeg(); if (line[i + 1] === '&') i++; continue; }
    if (ch === '|') { endSeg(); if (line[i + 1] === '|') i++; continue; }
    // Arithmetic `((` / `$((` … `))` — track depth so an inner `<<` (left-shift) is not read
    // as a heredoc. The paren pair stays part of the current token (identical token content).
    if (ch === '(' && line[i + 1] === '(') { arithDepth++; tok += '(('; started = true; i++; continue; }
    if (ch === ')' && line[i + 1] === ')' && arithDepth > 0) { arithDepth--; tok += '))'; started = true; i++; continue; }
    if (ch === '<' && line[i + 1] === '<' && heredoc === null && arithDepth === 0) {
      // heredoc redirection: record the delimiter, do NOT emit it as a command token
      let j = i + 2;
      let dash = false;
      if (line[j] === '-') { dash = true; j++; }
      while (line[j] === ' ' || line[j] === '\t') j++;
      if (line[j] === '"' || line[j] === "'") j++;
      let delim = '';
      while (j < line.length && /\w/.test(line[j]!)) { delim += line[j]; j++; }
      if (delim) heredoc = { delim, dash };
      i = j - 1;
      continue;
    }
    tok += ch;
    started = true;
  }
  endSeg();
  return { segments, heredoc };
}

/**
 * Reduce one command segment to a normalised `git <subcommand> <args…>` string, or `null` when
 * the segment is not a git command. Strips leading env-assignments and command prefixes, then
 * consumes `git` global options so the destructive subcommand cannot hide behind them.
 */
function normalizeGitCommand(tokens: string[]): string | null {
  let k = 0;
  while (k < tokens.length) {
    const t = tokens[k]!;
    if (/^[A-Za-z_]\w*=/.test(t)) { k++; continue; } // env-assignment: `FOO=bar` / `MSG="…"`
    if (COMMAND_PREFIXES.has(t)) { k++; continue; }
    break;
  }
  const head = tokens[k];
  if (head === undefined) return null;
  if (head !== 'git' && !head.endsWith('/git')) return null; // command word is not `git`
  // Consume zero or more git GLOBAL options preceding the subcommand.
  let m = k + 1;
  while (m < tokens.length && tokens[m]!.startsWith('-')) {
    const t = tokens[m]!;
    if (!t.includes('=') && GIT_GLOBAL_OPTS_WITH_ARG.has(t)) m += 2; // flag + its separate arg
    else m += 1;
  }
  if (m >= tokens.length) return null; // `git` with only global options — no subcommand
  return `git ${tokens.slice(m).join(' ')}`;
}

function scanFile(abs: string, rel: string): Finding[] {
  const out: Finding[] = [];
  const isSh = abs.endsWith('.sh');
  const hasDotInBase = path.basename(abs).includes('.');
  const husky = isHuskyPath(rel);
  // A dot-bearing extension that is NOT `.sh` (and not a husky hook) is skipped WITHOUT
  // reading — .ts/.py/.json/.md/.plist data files are out of scope.
  if (!isSh && !husky && hasDotInBase) return out;

  const lines = readFileSync(abs, 'utf8').split('\n');

  // Extensionless / husky: classify as shell by shebang, or force-shell inside `.husky/`.
  let shell = isSh || husky;
  if (!shell) {
    const firstLine = lines[0] ?? '';
    if (SHELL_SHEBANG.test(firstLine)) {
      shell = true;
    } else {
      return out; // not a recognised shell script — skip (binary / data / other-lang guard)
    }
  }

  let heredoc: HeredocState | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;

    // Inside a heredoc body: every line is DATA. Consume until the closing delimiter word
    // (leading tabs allowed for the `<<-` form), then resume scanning on the next line.
    if (heredoc !== null) {
      const body = (heredoc.dash ? raw.replace(/^\t+/, '') : raw).replace(/\r$/, '');
      if (body === heredoc.delim) heredoc = null;
      continue;
    }

    if (isComment(raw)) continue; // whole-line comment: nothing executable to match

    const { segments, heredoc: opened } = analyzeLine(raw);

    // Escape hatch: allow marker as a trailing comment on THIS line, OR as a standalone
    // comment line IMMEDIATELY ABOVE. The above-line form requires the previous line to be
    // a comment line, so a trailing allow-comment on a code line suppresses ONLY that line
    // and does not leak to the next.
    const prev = lines[i - 1] ?? '';
    const suppressed = ALLOW_MARKER.test(raw) || (isComment(prev) && ALLOW_MARKER.test(prev));
    if (!suppressed) {
      for (const tokens of segments) {
        const normalized = normalizeGitCommand(tokens);
        if (normalized === null) continue; // not a git command at command position
        for (const { command, pattern } of DESTRUCTIVE_GIT_PATTERNS) {
          if (pattern.test(normalized)) {
            out.push({ file: rel, line: i + 1, command, snippet: raw.trim().slice(0, 120) });
          }
        }
      }
    }

    // A heredoc opened on this line makes the following lines DATA until its delimiter — even
    // when the opening line itself was allow-suppressed.
    if (opened !== null) heredoc = opened;
  }
  return out;
}

export function scanForDestructiveGit(root: string): Finding[] {
  // Fail-closed: a missing/unreadable root must throw (propagated to main()'s catch →
  // non-zero exit), never be swallowed into a clean-looking empty result.
  if (!existsSync(root)) {
    throw new Error(`scan root does not exist: ${root}`);
  }
  const findings: Finding[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else {
        findings.push(...scanFile(abs, path.relative(root, abs)));
      }
    }
  };
  for (const surface of SURFACE_DIRS) {
    const abs = path.join(root, surface);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs);
    } else {
      findings.push(...scanFile(abs, path.relative(root, abs)));
    }
  }
  return findings;
}

function main(): number {
  const root = process.argv[2] ?? process.cwd();

  // Refuse to certify a tree we never examined. Run against an empty directory this guard
  // printed "clean (0 findings)" and exited 0 — a false green for a severity:'block' rule
  // (process.no-destructive-git). The IO-fault path below already fails closed; this covers
  // the quieter case where nothing threw because there was simply nothing there, which is
  // what a wrong cwd or a renamed surface directory looks like.
  const presentSurfaces = SURFACE_DIRS.filter((d) => {
    try {
      return statSync(path.join(root, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (presentSurfaces.length === 0) {
    console.error(
      `[no-destructive-git] INCONCLUSIVE — none of ${SURFACE_DIRS.join(', ')} exists under ${root}; ` +
        'refusing to report "clean" for a tree that was never examined',
    );
    return 2;
  }

  let findings: Finding[];
  try {
    findings = scanForDestructiveGit(root);
  } catch (err) {
    console.error(`[no-destructive-git] FATAL ${(err as Error).message}`); // fail-closed
    return 2;
  }
  if (findings.length === 0) {
    console.log(`[no-destructive-git] clean (0 findings across ${presentSurfaces.join(', ')})`);
    return 0;
  }
  for (const f of findings) {
    console.error(`  ${f.command}  ${f.file}:${f.line}  ${f.snippet}`);
  }
  console.error(
    `[no-destructive-git] ${findings.length} destructive git command(s) — BLOCK. ` +
      `Justify a legitimate use with an inline '# no-destructive-git:allow <reason>' comment.`,
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(main());
}
