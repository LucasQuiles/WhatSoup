/**
 * Free nowUnixSec() ratchet — pins free `nowUnixSec()` call sites in src/ to
 * exactly zero.
 *
 * #2200 migrates production wall-clock reads off the free `nowUnixSec()`
 * helper (src/core/substrate/time.ts) onto an injected Clock —
 * `clock.nowUnixSec()` / `systemClock.nowUnixSec()`. The whole point of the
 * injection is that a test can drive the clock to a known instant. A stray
 * free `nowUnixSec()` call bypasses that and reads the real wall clock, so a
 * reverted or newly-introduced free call site must fail the suite — loudly,
 * not as a budget that could be raised by accident.
 *
 * Scope is CALL SITES only (`nowUnixSec(`), not bare references. A bare
 * `nowUnixSec` handed out as a function value (e.g. `opts.now ?? nowUnixSec`)
 * is a reference, not a call site, and is deliberately out of scope here.
 *
 * Two files are exempt BY PATH — never by matching the line content:
 *   - src/core/substrate/time.ts — defines the free helper.
 *   - src/lib/clock.ts           — Clock interface + SystemClock/FakeClock
 *     nowUnixSec() method impls.
 *
 * The match uses a PCRE negative lookbehind `(?<!(?:clock|systemClock|fakeClock)\.)`
 * so Clock method calls (`clock.nowUnixSec()`, `systemClock.nowUnixSec()`,
 * `this.clock.nowUnixSec()`) are NOT counted as free sites, while a
 * namespace-qualified free call — `time.nowUnixSec()`, i.e. `import * as time
 * from './time.ts'` — IS counted. The distinction is WHICH symbol the dot
 * follows, not whether a dot is present: a dot after one of the three Clock
 * receiver identifiers is a method call; a dot after the time module namespace
 * (or any identifier that is NOT a Clock receiver) is a free call.
 *
 * The separation is by receiver NAME, not by type — a static regex cannot know
 * that an identifier is a `Clock`. The whitelist `clock`, `systemClock`,
 * `fakeClock` is the canonical set of Clock receivers in src/ (verified at the
 * time of writing); an unknown receiver name (`myClock.nowUnixSec()`,
 * `fc.nowUnixSec()`) is therefore flagged as a free site. That is the
 * fail-closed direction: a false positive is loud and trivial to fix (rename
 * to the conventional `clock`, or extend the whitelist), whereas silently
 * exempting an unknown name would re-open the exact escape hatch this ratchet
 * closes.
 *
 * That lookbehind is load-bearing: a POSIX ERE engine silently ignores
 * `(?<!…)` and would then count every method call as a free site — a ratchet
 * that always reads zero (or always reads wrong) is worse than no ratchet.
 * Because this test runs under Node's V8 RegExp, which supports lookbehind
 * natively, the pattern evaluates correctly; the `lookbehind is live` test
 * below self-checks that before any count is trusted, so a future engine/port
 * that drops lookbehind cannot silently pass.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

// Exempt BY PATH (resolved absolute). The definition and the interface impls
// are declarations, not call sites.
const EXEMPT_PATHS = new Set([
  resolve(srcRoot, 'core', 'substrate', 'time.ts'),
  resolve(srcRoot, 'lib', 'clock.ts'),
]);

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name))
    .filter((f) => !EXEMPT_PATHS.has(f));
}

// PCRE negative lookbehind: a free call site is `nowUnixSec(` that is NOT a
// method call on a Clock receiver. The three Clock receiver identifiers that
// can legitimately precede `.nowUnixSec(` are whitelisted; a dot before any
// OTHER identifier (e.g. the `time` module namespace) is a namespace-qualified
// free call and must still match. The lookbehind is the ONLY mechanism
// distinguishing free from method — no `[^.]` prefix that a POSIX engine might
// also mangle.
const FREE_NOW_UNIX_SEC = /(?<!(?:clock|systemClock|fakeClock)\.)nowUnixSec\(/g;

/**
 * Split source into its code lines with ORIGINAL 1-based line numbers,
 * dropping whole-line comments (lines whose trimmed form starts with `//`,
 * `/*`, or `*`).
 *
 * Why whole-line rather than inline, and why dropping prose matters: an inline
 * `/*…*\/` or `//` stripper can swallow real code behind a string that merely
 * contains a comment opener, and undercounting is the one direction that lets
 * the ratchet silently permit new debt. Whole-line stripping can only OVERcount
 * (trailing comments are kept), the safe direction. The line numbers are the
 * ORIGINAL file lines so a failure points at the true location.
 */
function codeLines(src: string): Array<{ line: number; text: string }> {
  const kept: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    kept.push({ line: i + 1, text: lines[i] });
  }
  return kept;
}

interface FreeSite {
  file: string;
  line: number;
}

function findFreeCallSites(): FreeSite[] {
  const sites: FreeSite[] = [];
  for (const file of collectSrcFiles()) {
    for (const { line, text } of codeLines(readFileSync(file, 'utf8'))) {
      const matches = text.match(FREE_NOW_UNIX_SEC);
      if (matches) {
        for (let k = 0; k < matches.length; k++) {
          sites.push({ file: file.replace(repoRoot + '/', ''), line });
        }
      }
    }
  }
  return sites;
}

describe('free nowUnixSec() ratchet', () => {
  it('the lookbehind is live: method calls are not free sites, namespace calls are', () => {
    // If the engine silently ignored `(?<!…)` — as POSIX ERE does — the method
    // call below would match and the ratchet would false-positive on legitimate
    // code. The bare call is the positive control: a real free site MUST match.
    expect('const t = nowUnixSec();'.match(FREE_NOW_UNIX_SEC)).not.toBeNull();
    // Namespace-qualified free call (`import * as time from './time.ts'`): the
    // dot follows the module namespace, NOT a Clock receiver, so it MUST match.
    // This is the escape hatch the ratchet previously missed.
    expect('const t = time.nowUnixSec();'.match(FREE_NOW_UNIX_SEC)).not.toBeNull();
    // Clock method calls: the dot follows a Clock receiver identifier, so they
    // MUST NOT be counted as free sites.
    expect('const t = clock.nowUnixSec();'.match(FREE_NOW_UNIX_SEC)).toBeNull();
    expect('const t = systemClock.nowUnixSec();'.match(FREE_NOW_UNIX_SEC)).toBeNull();
    expect('const t = fakeClock.nowUnixSec();'.match(FREE_NOW_UNIX_SEC)).toBeNull();
    expect('const t = this.clock.nowUnixSec();'.match(FREE_NOW_UNIX_SEC)).toBeNull();
  });

  it('drops whole-line comments without hiding real code', () => {
    // Pins the perverse-incentive guard: a comment naming the pattern must not
    // trip the ratchet, and a real code line must survive with its original
    // line number (so a failure points at the true location).
    const kept = codeLines([
      '// a comment mentioning nowUnixSec() is not a call site',
      '/* block comment nowUnixSec() */',
      'const t = clock.nowUnixSec();',
    ].join('\n'));
    expect(kept.map((l) => l.text)).toEqual(['const t = clock.nowUnixSec();']);
    expect(kept[0].line).toBe(3);
  });

  it('the scanned source corpus is non-empty (a zero-file scan must fail, not pass vacuously)', () => {
    // Vacuity guard: "zero free sites" is only a meaningful claim if we actually
    // scanned some source. If collectSrcFiles() ever returns an empty list —
    // srcRoot resolving somewhere empty, a filter regression, a dropped
    // `recursive` flag on a future Node — the ratchet below would still compare
    // `[]` against `[]` and pass, manufacturing false confidence. Pin the corpus
    // non-empty so a vacuous scan fails loudly instead of silently passing.
    expect(collectSrcFiles().length).toBeGreaterThan(0);
  });

  it('src/ has exactly zero free nowUnixSec() call sites', () => {
    const sites = findFreeCallSites();
    expect(
      sites,
      `free nowUnixSec() call sites must be zero — use clock.nowUnixSec() / ` +
        `systemClock.nowUnixSec() from an injected Clock (#2200):\n` +
        sites.map((s) => `  ${s.file}:${s.line}`).join('\n'),
    ).toEqual([]);
  });
});
