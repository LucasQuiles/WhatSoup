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

/**
 * `analysed` is false when the file was skipped without being parsed (wrong extension, no
 * recognised shebang). It exists so the caller can count files it genuinely READ: counting
 * every file the walker touched would let a directory holding only a `package.json` report
 * "1 file examined" and satisfy the non-vacuity check while analysing nothing.
 */
interface FileScan {
  findings: Finding[];
  analysed: boolean;
}

function scanFile(abs: string, rel: string): FileScan {
  const out: Finding[] = [];
  const py = abs.endsWith('.py');
  const sh = abs.endsWith('.sh');
  // A file with a dot-bearing extension that is NOT .py/.sh is skipped without reading.
  const hasDotInBase = path.basename(abs).includes('.');
  if (!py && !sh && hasDotInBase) return { findings: out, analysed: false };

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
      return { findings: out, analysed: false }; // no recognised shebang (binary / data guard)
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
  return { findings: out, analysed: true };
}

/**
 * Scan result plus the number of files actually READ.
 *
 * The count is the whole point. A presence check ("does package.json exist?") proves the
 * scan was pointed somewhere plausible, not that it examined anything — a checkout whose
 * directories all exist but are empty passes every such proxy while reading zero files.
 * That gap is why the first attempt at this refusal (`9cf044d45`) was reverted as
 * incomplete.
 */
export interface InsecureTempfileScan {
  findings: Finding[];
  /** Files actually PARSED (.py/.sh or a matching shebang) — not files merely walked past. */
  filesExamined: number;
}

/** Counting scan. `scanForInsecureTempfile` keeps the original findings-only contract. */
export function scanForInsecureTempfileCounted(root: string): InsecureTempfileScan {
  const findings: Finding[] = [];
  let filesExamined = 0;
  // Relative-path directory exclusions (vs the SKIP_DIRS basename set). Both are
  // computed against the scan ROOT, so they do NOT fire when the scan root IS the
  // excluded directory — unit tests call scanForInsecureTempfile(redDir) directly
  // and must still find violations:
  //   - tests/fixtures/insecure-tempfile — the guard's own intentional-violation
  //     corpus; scanning it would make this blocking gate permanently un-greenable.
  //   - .claude/worktrees — harness isolation worktrees of OTHER branches
  //     (see SKIP_DIRS note); their fixtures must not gate THIS checkout's push.
  const SKIP_RELPATHS = new Set(['tests/fixtures/insecure-tempfile', '.claude/worktrees', '.tmup-artifacts']);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_RELPATHS.has(path.relative(root, abs))) continue;
        walk(abs);
      } else {
        const scan = scanFile(abs, path.relative(root, abs));
        if (scan.analysed) filesExamined += 1;
        findings.push(...scan.findings);
      }
    }
  };
  walk(root);
  return { findings, filesExamined };
}

/** Findings only — pure, and legitimately allowed to return []. Unit tests use this. */
export function scanForInsecureTempfile(root: string): Finding[] {
  return scanForInsecureTempfileCounted(root).findings;
}

function main(): number {
  const root = process.argv[2] ?? process.cwd();
  let scan: InsecureTempfileScan;
  try {
    scan = scanForInsecureTempfileCounted(root);
  } catch (err) {
    console.error(`[insecure-tempfile] FATAL ${(err as Error).message}`); // fail-closed
    return 2;
  }
  const { findings, filesExamined } = scan;

  // Refuse to certify a tree that was never read. This backs severity:'block' rule
  // test.insecure-tempfile, so "clean" from a zero-file scan is a false green on a
  // blocking gate. The check is on files READ, not on paths existing: a decoy checkout
  // whose directories are all present but empty satisfies any presence proxy while
  // reading nothing, which is exactly how the reverted version of this refusal failed.
  if (filesExamined === 0) {
    console.error(
      `[insecure-tempfile] INCONCLUSIVE — examined 0 files under ${root}; refusing to ` +
        'report "clean" for a tree that was never read',
    );
    return 2;
  }

  if (findings.length === 0) {
    console.log(`[insecure-tempfile] clean (0 findings across ${filesExamined} file(s))`);
    return 0;
  }
  for (const f of findings) console.error(`  ${f.kind}  ${f.file}:${f.line}  ${f.snippet}`);
  console.error(`[insecure-tempfile] ${findings.length} insecure pattern(s) — BLOCK`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(main());
}
