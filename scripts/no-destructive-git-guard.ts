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
 * Comments are stripped before matching (a leading-`#` line is skipped whole; a trailing
 * `# …` is dropped), mirroring `scripts/check-insecure-tempfile.ts`.
 *
 * Escape hatch (for legit future recovery/one-off tooling): an inline
 * `# no-destructive-git:allow <reason>` comment ON the offending line, or on the line
 * IMMEDIATELY ABOVE it, suppresses that single finding.
 *
 * The banned set (`DESTRUCTIVE_GIT_PATTERNS`) is a clearly-named exported constant so the
 * owner can broaden/narrow it. Each pattern is whitespace-tolerant and bounded so it does
 * NOT cross a shell command separator (`; & |`) — e.g. `git checkout main && rm -f x`
 * must not be misread as a forced checkout.
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
  // Bare `git clean` and dry-run (`-n`/`--dry-run`) are intentionally NOT matched.
  { command: 'git clean', pattern: new RegExp(`\\bgit\\s+clean\\b${GAP}(?:\\s-[a-zA-Z]*[fdxX]|\\s--force\\b)`) },
  { command: 'git reset --hard', pattern: new RegExp(`\\bgit\\s+reset\\b${GAP}--hard\\b`) },
  { command: 'git checkout --force', pattern: new RegExp(`\\bgit\\s+checkout\\b${GAP}(?:\\s-f\\b|\\s--force\\b)`) },
  { command: 'git switch --force', pattern: new RegExp(`\\bgit\\s+switch\\b${GAP}(?:\\s-f\\b|\\s--force\\b|\\s--discard-changes\\b)`) },
  { command: 'git push --force', pattern: new RegExp(`\\bgit\\s+push\\b${GAP}(?:\\s--force(?:-with-lease)?\\b|\\s-f\\b)`) },
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

  lines.forEach((raw, i) => {
    if (isComment(raw)) return; // whole-line comment: nothing executable to match
    // Escape hatch: allow marker as a trailing comment on THIS line, OR as a standalone
    // comment line IMMEDIATELY ABOVE. The above-line form requires the previous line to be
    // a comment line, so a trailing allow-comment on a code line suppresses ONLY that line
    // and does not leak to the next.
    const prev = lines[i - 1] ?? '';
    if (ALLOW_MARKER.test(raw) || (isComment(prev) && ALLOW_MARKER.test(prev))) return;
    const code = raw.split('#')[0]; // drop trailing comment before matching
    for (const { command, pattern } of DESTRUCTIVE_GIT_PATTERNS) {
      if (pattern.test(code)) {
        out.push({ file: rel, line: i + 1, command, snippet: raw.trim().slice(0, 120) });
      }
    }
  });
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
  let findings: Finding[];
  try {
    findings = scanForDestructiveGit(root);
  } catch (err) {
    console.error(`[no-destructive-git] FATAL ${(err as Error).message}`); // fail-closed
    return 2;
  }
  if (findings.length === 0) {
    console.log('[no-destructive-git] clean (0 findings)');
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
