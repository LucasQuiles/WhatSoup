/**
 * check-insecure-tempfile.ts — block insecure temp-file creation in python + shell.
 * Detects CREATION/WRITE only (tempfile.mktemp(, /tmp write-targets, shell redirect to
 * /tmp, bare mktemp without a private dir/template). Read-only /tmp references, comments,
 * docstrings, and assertions are NOT flagged. No baseline — fix, don't grandfather.
 *
 * Extensionless files are classified by shebang (first line):
 *   #!...python  → python matchers
 *   #!...(ba|da|k|z)?sh  → shell matchers
 *   otherwise   → skipped (binary / data file guard)
 *
 * Known limitations (dataflow analysis required; do NOT add fragile regex for these):
 *   os.path.join("/tmp", x)  write-targets are not detected.
 *   shutil.copy(..., "/tmp/...")  write-targets are not detected.
 *   os.open("/tmp/...")  write-targets are not detected.
 * f-string /tmp write-targets (e.g. open(f"/tmp/{name}","w"), Path(f"/tmp/{x}").write_text())
 * ARE detected — the regex allows an optional string prefix (f/r/b) before each quote.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Finding {
  file: string;
  line: number;
  kind: 'py-mktemp' | 'py-tmp-write' | 'sh-redirect' | 'sh-mktemp';
  snippet: string;
}

// `.worktrees` (and `.claude/worktrees`, the harness isolation-worktree tree) hold
// sibling git-worktree checkouts of OTHER branches; their content is gated by
// their own pushes. Scanning them makes this checkout's push gate depend on
// unrelated branch state (observed 2026-07-04: a red-team fixture corpus in a
// parked `.worktrees` checkout blocked an unrelated push with 56 hits; recurred
// 2026-07-19 via `.claude/worktrees/<parked>/tests/fixtures/insecure-tempfile/red`
// — 14 hits). `.worktrees` is a basename skip (caught at any depth). `.claude/`
// nests real scannable content beside its `worktrees/`, so `.claude/worktrees`
// is excluded by relative path in the walk below, not by basename.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.worktrees']);
// Flag both tempfile.mktemp( calls and direct-import form (kind py-mktemp)
const PY_MKTEMP = /\b(?:tempfile\.mktemp\s*\(|from\s+tempfile\s+import\s+(?:\w+\s*,\s*)*mktemp\b)/;
// /tmp/<name> as a write/create target: open(...,'w'|'a'|'x') positional or mode=kw,
// pathlib .open() with write mode, write_text, write_bytes, mkdir, touch.
// Optional Python string prefix (f/r/b and combos, case-insensitive) is allowed before
// each /tmp/ literal so f-string paths like open(f"/tmp/{x}","w") are also detected.
const PY_TMP_WRITE =
  /(?:open\(\s*(?:[rfbRFB]{1,2})?["']\/tmp\/[^"']+["']\s*,\s*["'][wax]|open\(\s*(?:[rfbRFB]{1,2})?["']\/tmp\/[^"']+["'][^)]*mode\s*=\s*["'][wax]|(?:[rfbRFB]{1,2})?["']\/tmp\/[^"']+["']\s*\)\s*\.\s*(?:write_text|write_bytes|mkdir|touch|open\s*\(\s*(?:["'][wax]|[^)]*mode\s*=\s*["'][wax])))/;
// Shell redirects to /tmp and tee (with optional flags) writing to /tmp
const SH_REDIRECT = /(?:>>?|\bcat\s*>)\s*\/tmp\/\S+|\btee\b(?:\s+-\S+)*\s+\/tmp\/\S+/;
// Bare mktemp: no -d / --directory, no $TMPDIR/$TMP reference, no X{3,} template
const SH_MKTEMP_BARE = /\bmktemp\b(?!\s+(?:-d\b|--directory\b))(?![^\n]*["']?\$\{?(?:TMPDIR|TMP)\b)(?![^\n]*X{3,})/;

function isComment(line: string): boolean {
  return line.trimStart().startsWith('#');
}

function scanFile(abs: string, rel: string): Finding[] {
  const out: Finding[] = [];
  const py = abs.endsWith('.py');
  const sh = abs.endsWith('.sh');
  // A file with a dot-bearing extension that is NOT .py/.sh is skipped without reading.
  const hasDotInBase = path.basename(abs).includes('.');
  if (!py && !sh && hasDotInBase) return out;

  const lines = readFileSync(abs, 'utf8').split('\n');

  // Extensionless: classify by shebang on first line; skip if not a py/sh script.
  let isPy = py;
  let isSh = sh;
  if (!py && !sh) {
    const firstLine = lines[0] ?? '';
    if (/^#!.*python/.test(firstLine)) {
      isPy = true;
    } else if (/^#!.*\b(?:ba|da|k|z)?sh\b/.test(firstLine)) {
      isSh = true;
    } else {
      return out; // no recognised shebang — skip (binary / data guard)
    }
  }
  lines.forEach((raw, i) => {
    if (isComment(raw)) return;
    const line = raw.split('#')[0]; // drop trailing comments for matching
    const push = (kind: Finding['kind']) =>
      out.push({ file: rel, line: i + 1, kind, snippet: raw.trim().slice(0, 120) });
    if (isPy && PY_MKTEMP.test(line)) push('py-mktemp');
    if (isPy && PY_TMP_WRITE.test(line)) push('py-tmp-write');
    if (isSh && SH_REDIRECT.test(line)) push('sh-redirect');
    if (isSh && SH_MKTEMP_BARE.test(line)) push('sh-mktemp');
  });
  return out;
}

export function scanForInsecureTempfile(root: string): Finding[] {
  const findings: Finding[] = [];
  // Relative-path directory exclusions (vs the SKIP_DIRS basename set). Both are
  // computed against the scan ROOT, so they do NOT fire when the scan root IS the
  // excluded directory — unit tests call scanForInsecureTempfile(redDir) directly
  // and must still find violations:
  //   - tests/fixtures/insecure-tempfile — the guard's own intentional-violation
  //     corpus; scanning it would make this blocking gate permanently un-greenable.
  //   - .claude/worktrees — harness isolation worktrees of OTHER branches
  //     (see SKIP_DIRS note); their fixtures must not gate THIS checkout's push.
  const SKIP_RELPATHS = new Set(['tests/fixtures/insecure-tempfile', '.claude/worktrees']);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_RELPATHS.has(path.relative(root, abs))) continue;
        walk(abs);
      } else {
        findings.push(...scanFile(abs, path.relative(root, abs)));
      }
    }
  };
  walk(root);
  return findings;
}

function main(): number {
  const root = process.argv[2] ?? process.cwd();
  let findings: Finding[];
  try {
    findings = scanForInsecureTempfile(root);
  } catch (err) {
    console.error(`[insecure-tempfile] FATAL ${(err as Error).message}`); // fail-closed
    return 2;
  }
  if (findings.length === 0) {
    console.log('[insecure-tempfile] clean (0 findings)');
    return 0;
  }
  for (const f of findings) console.error(`  ${f.kind}  ${f.file}:${f.line}  ${f.snippet}`);
  console.error(`[insecure-tempfile] ${findings.length} insecure pattern(s) — BLOCK`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(main());
}
