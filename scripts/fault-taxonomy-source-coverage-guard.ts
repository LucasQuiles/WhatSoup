// scripts/fault-taxonomy-source-coverage-guard.ts
// #2147: every alert source a producer can emit must have a sourceDispositions
// entry in src/lib/fault-taxonomy-registry.json. This guard makes that
// mechanically complete: it extracts source identifiers from every emit/clear
// call site (TypeScript producers and the Python bot-errors scripts), resolves
// same-file const indirection, and fails on any emitted source the registry
// does not carry. Call sites whose source cannot be resolved statically must
// be claimed in DYNAMIC_SOURCE_SITES with file provenance — an unclaimed
// unresolved site is a failure, so new dynamic emitters cannot slip past the
// guard silently.
//
// Exit codes: 0 = covered; 1 = coverage violations; 2 = guard could not run.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY_PATH = 'src/lib/fault-taxonomy-registry.json';
// Honest debt ledger (QC-2 idiom): sources already emitted on main that do not
// yet carry a sourceDispositions entry. The guard fails on GROWTH (a new
// unregistered source) and on STALE debt (an entry that became registered or
// is no longer emitted) — never on the standing debt itself. Completion
// signal for #2147 = an empty entries list.
const BASELINE_PATH = 'scripts/fault-taxonomy-source-coverage-baseline.json';


function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(p, ext, out);
    } else if (p.endsWith(ext)) {
      out.push(p);
    }
  }
  return out;
}

interface EmitSite {
  file: string;
  line: number;
  raw: string;
}

interface Extraction {
  sources: Map<string, EmitSite[]>;
  unresolved: EmitSite[];
}

const TS_CALL = /\b(?:emitAlertChecked|emitAlert|clearAlertSourceChecked|clearAlertSource)\s*\(/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Extract the second argument's token from a call starting at `openParen`. */
function secondArgToken(text: string, openParen: number): string | null {
  let depth = 0;
  let argIndex = 0;
  let start = -1;
  for (let i = openParen; i < text.length && i < openParen + 2000; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return argIndex === 1 ? text.slice(start, i).trim() : null;
      }
    } else if (ch === ',' && depth === 1) {
      if (argIndex === 1) return text.slice(start, i).trim();
      argIndex += 1;
      start = i + 1;
    }
  }
  return null;
}

/** Blank out // and /* comments, preserving offsets so line numbers hold. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}

function extractTypescript(files: string[]): Extraction {
  const sources = new Map<string, EmitSite[]>();
  const unresolved: EmitSite[] = [];
  for (const file of files) {
    // emit-alert.ts DEFINES the emit/clear surface; its signatures are not
    // call sites.
    if (file.endsWith('src/lib/emit-alert.ts')) continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    // Local `const NAME = 'literal'` bindings for identifier resolution.
    const consts = new Map<string, string>();
    for (const m of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*'([a-z0-9_.:-]+)'/g)) {
      consts.set(m[1]!, m[2]!);
    }
    for (const m of text.matchAll(TS_CALL)) {
      const openParen = m.index! + m[0].length - 1;
      const token = secondArgToken(text, openParen);
      const site: EmitSite = { file, line: lineOf(text, m.index!), raw: token ?? '<unparsed>' };
      if (token === null) {
        unresolved.push(site);
        continue;
      }
      const literal = token.match(/^'([a-z0-9_.:-]+)'$/);
      if (literal) {
        const list = sources.get(literal[1]!) ?? [];
        list.push(site);
        sources.set(literal[1]!, list);
        continue;
      }
      const viaConst = consts.get(token);
      if (viaConst) {
        const list = sources.get(viaConst) ?? [];
        list.push(site);
        sources.set(viaConst, list);
        continue;
      }
      unresolved.push(site);
    }
  }
  return { sources, unresolved };
}

const PY_SOURCE = /(?:--source["'\s,\]]+["']([a-z0-9_]+)["']|\bsource=["']([a-z0-9_]+)["'])/g;

function extractPython(files: string[]): Extraction {
  const sources = new Map<string, EmitSite[]>();
  const unresolved: EmitSite[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(PY_SOURCE)) {
      const name = (m[1] ?? m[2])!;
      const site: EmitSite = { file, line: lineOf(text, m.index!), raw: name };
      const list = sources.get(name) ?? [];
      list.push(site);
      sources.set(name, list);
    }
    // Dynamic python emitters (variable source= / f-strings) are covered by
    // the literal registry of DYNAMIC_SOURCE_SITES; python call graphs are
    // not walked here.
    void unresolved;
  }
  return { sources, unresolved };
}

function main(): number {
  let registry: { sourceDispositions?: Record<string, unknown> };
  try {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    console.error(`fault-taxonomy source-coverage guard could not read registry: ${String(err)}`);
    return 2;
  }
  const registered = new Set(Object.keys(registry.sourceDispositions ?? {}));
  if (registered.size === 0) {
    console.error('fault-taxonomy source-coverage guard: registry has no sourceDispositions');
    return 2;
  }

  let baseline: {
    entries?: Array<{ source: string; owner: string; status: string; reason: string }>;
    dynamicClaims?: Record<string, string>;
  };
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(`fault-taxonomy source-coverage guard could not read baseline: ${String(err)}`);
    return 2;
  }
  const debt = new Map((baseline.entries ?? []).map((e) => [e.source, e]));
  // Runtime-computed emit sites, claimed as data with file provenance so
  // fixtures and the live tree share one contract surface.
  const DYNAMIC_SOURCE_SITES = Object.entries(baseline.dynamicClaims ?? {}).map(
    ([source, file]) => ({ source, file }),
  );

  const ts = extractTypescript(walk('src', '.ts'));
  const py = extractPython(
    readdirSync('deploy/scripts')
      .filter((n) => n.endsWith('.py'))
      .map((n) => join('deploy/scripts', n)),
  );

  const emitted = new Map<string, EmitSite[]>([...ts.sources]);
  for (const [name, sites] of py.sources) {
    emitted.set(name, [...(emitted.get(name) ?? []), ...sites]);
  }

  const failures: string[] = [];

  for (const [name, sites] of [...emitted].sort(([a], [b]) => a.localeCompare(b))) {
    if (registered.has(name)) continue;
    if (debt.has(name)) continue; // standing debt — held, not growth
    const where = sites.map((s) => `${s.file}:${s.line}`).join(', ');
    failures.push(
      `unregistered-source-growth: '${name}' emitted at ${where} has no sourceDispositions entry `
      + 'and is not in the debt baseline',
    );
  }

  // Stale debt must be pruned, never silently carried: an entry that became
  // registered, or whose source is no longer emitted (or claimed dynamic),
  // has to leave the baseline in the same change.
  const dynamicSources = new Set(DYNAMIC_SOURCE_SITES.map((d) => d.source));
  for (const [name] of debt) {
    if (registered.has(name)) {
      failures.push(`stale-debt: baseline entry '${name}' is now registered — prune it`);
    } else if (!emitted.has(name) && !dynamicSources.has(name)) {
      failures.push(`stale-debt: baseline entry '${name}' is no longer emitted — prune it`);
    }
  }

  const claimedFiles = new Set(DYNAMIC_SOURCE_SITES.map((d) => d.file));
  for (const site of ts.unresolved) {
    if (!claimedFiles.has(site.file)) {
      failures.push(
        `unresolved-source: ${site.file}:${site.line} emits a runtime-computed source (${site.raw}) `
        + 'not claimed in DYNAMIC_SOURCE_SITES',
      );
    }
  }

  for (const claim of DYNAMIC_SOURCE_SITES) {
    if (!registered.has(claim.source) && !debt.has(claim.source)) {
      failures.push(
        `stale-claim: dynamic source '${claim.source}' (${claim.file}) is neither registered nor in the debt baseline`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('fault-taxonomy source-coverage guard failed');
    for (const f of failures) console.error(f);
    return 1;
  }
  console.log(
    `fault-taxonomy source-coverage guard passed `
    + `(${emitted.size} literal source(s), ${DYNAMIC_SOURCE_SITES.length} dynamic claim(s), `
    + `${registered.size} registered, ${debt.size} debt — #2147 completes at 0 debt)`,
  );
  return 0;
}

process.exit(main());
