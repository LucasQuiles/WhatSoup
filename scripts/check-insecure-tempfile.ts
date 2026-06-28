/**
 * check-insecure-tempfile.ts — block insecure temp-file creation in python + shell.
 * Detects CREATION/WRITE only (tempfile.mktemp(, /tmp write-targets, shell redirect to
 * /tmp, bare mktemp without a private dir/template). Read-only /tmp references, comments,
 * docstrings, and assertions are NOT flagged. No baseline — fix, don't grandfather.
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

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
// Flag both tempfile.mktemp( calls and direct-import form (kind py-mktemp)
const PY_MKTEMP = /\b(?:tempfile\.mktemp\s*\(|from\s+tempfile\s+import\s+(?:\w+\s*,\s*)*mktemp\b)/;
// /tmp/<name> as a write/create target: open(...,'w'|'a'|'x') positional or mode=kw,
// pathlib .open() with write mode, write_text, write_bytes, mkdir, touch
const PY_TMP_WRITE =
  /(?:open\(\s*["']\/tmp\/[^"']+["']\s*,\s*["'][wax]|open\(\s*["']\/tmp\/[^"']+["'][^)]*mode\s*=\s*["'][wax]|["']\/tmp\/[^"']+["']\s*\)\s*\.\s*(?:write_text|write_bytes|mkdir|touch|open\s*\(\s*(?:["'][wax]|[^)]*mode\s*=\s*["'][wax])))/;
// Shell redirects to /tmp and tee (with optional flags) writing to /tmp
const SH_REDIRECT = /(?:>>?|\bcat\s*>)\s*\/tmp\/\S+|\btee\b(?:\s+-\S+)*\s+\/tmp\/\S+/;
// Bare mktemp: no -d, no $TMPDIR/$TMP reference, no X{3,} template
const SH_MKTEMP_BARE = /\bmktemp\b(?!\s+-d)(?![^\n]*["']?\$\{?(?:TMPDIR|TMP)\b)(?![^\n]*X{3,})/;

function isComment(line: string): boolean {
  return line.trimStart().startsWith('#');
}

function scanFile(abs: string, rel: string): Finding[] {
  const out: Finding[] = [];
  const py = abs.endsWith('.py');
  const sh = abs.endsWith('.sh');
  if (!py && !sh) return out;
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((raw, i) => {
    if (isComment(raw)) return;
    const line = raw.split('#')[0]; // drop trailing comments for matching
    const push = (kind: Finding['kind']) =>
      out.push({ file: rel, line: i + 1, kind, snippet: raw.trim().slice(0, 120) });
    if (py && PY_MKTEMP.test(line)) push('py-mktemp');
    if (py && PY_TMP_WRITE.test(line)) push('py-tmp-write');
    if (sh && SH_REDIRECT.test(line)) push('sh-redirect');
    if (sh && SH_MKTEMP_BARE.test(line)) push('sh-mktemp');
  });
  return out;
}

export function scanForInsecureTempfile(root: string): Finding[] {
  const findings: Finding[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else findings.push(...scanFile(abs, path.relative(root, abs)));
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
