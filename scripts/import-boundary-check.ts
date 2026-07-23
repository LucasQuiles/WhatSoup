import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fitnessRules } from './lib/fitness/registry.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoundaryViolation {
  file: string;
  line: number;
  specifier: string;
  fromLayer: string;
  toLayer: string;
}

interface RunResult {
  allViolations: BoundaryViolation[];
  newViolations: BoundaryViolation[];
  baselinedViolations: BoundaryViolation[];
}

interface LayerMatrix {
  [layer: string]: string[];
}

export interface BoundaryParams {
  layers?: Record<string, string[]>;
  anyMayImportRoot?: boolean;
}

// ---------------------------------------------------------------------------
// Matrix construction — SSOT is the registry rule params
// ---------------------------------------------------------------------------

export function buildLayerMatrix(params?: BoundaryParams): LayerMatrix {
  if (params?.layers) {
    // Injected params (used in tests to verify registry indirection)
    const matrix: LayerMatrix = {};
    for (const [layer, allowed] of Object.entries(params.layers)) {
      matrix[layer] = allowed;
    }
    // Honour anyMayImportRoot: every layer may also import 'root'
    if (params.anyMayImportRoot !== false) {
      for (const layer of Object.keys(matrix)) {
        if (!matrix[layer]!.includes('root')) {
          matrix[layer] = [...matrix[layer]!, 'root'];
        }
      }
      matrix['root'] = ['*'];
    }
    return matrix;
  }

  // Read from the registry rule's params
  const rule = fitnessRules.find((r) => r.id === 'arch.import-boundaries');
  if (!rule?.params) throw new Error('arch.import-boundaries rule or params not found in registry');

  const ruleParams = rule.params as BoundaryParams;
  if (!ruleParams.layers) throw new Error('arch.import-boundaries params.layers not found in registry');

  return buildLayerMatrix(ruleParams);
}

// ---------------------------------------------------------------------------
// Layer resolution
// ---------------------------------------------------------------------------

function resolveLayer(absFilePath: string, repoRoot: string): string | null {
  const rel = path.relative(repoRoot, absFilePath).split(path.sep).join('/');

  if (rel.startsWith('src/')) {
    const afterSrc = rel.slice('src/'.length);
    const slash = afterSrc.indexOf('/');
    if (slash === -1) {
      // Direct file in src/ (e.g. src/config.ts)
      return 'root';
    }
    return afterSrc.slice(0, slash);
  }

  if (rel.startsWith('tests/')) return 'tests';
  if (rel.startsWith('scripts/')) return 'scripts';

  return null; // Outside tracked directories
}

// ---------------------------------------------------------------------------
// Import specifier extraction
// ---------------------------------------------------------------------------

interface RawEdge {
  line: number;
  specifier: string;
}

/** `from '...'` specifier — terminal clause of a static import/export. */
const FROM_SPEC = /\bfrom\s+['"]([^'"]+)['"]/;
/** Side-effect import: `import './x.ts'` (no binding list, no `from`). */
const SIDE_EFFECT_IMPORT = /^import\s+['"]([^'"]+)['"]/;
/**
 * Dynamic `import('...')` anywhere on a line. Accepts single, double, and
 * backtick quotes so a non-interpolated template-literal specifier
 * (`import(`../x.ts`)`) is not a silent miss. The closing `)` is optional so
 * a parenthesis that opens on this line but closes on a later one is still
 * caught after continuation lines are joined.
 */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)?/;
/** `import(` opener whose specifier/closer may sit on a later line. */
const DYNAMIC_IMPORT_OPEN = /\bimport\s*\(\s*$/;
/** Line begins an import/export statement. */
const OPENS_STATEMENT = /^(?:import|export)\b/;
/**
 * `export` declarations that can never carry a `from` clause — joining
 * continuation lines for these would scan unrelated code.
 */
const EXPORT_DECLARATION =
  /^export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|abstract\b|async\b|enum\b|interface\b|namespace\b|type\s+[A-Za-z_$][\w$]*\s*=)/;
/** Upper bound on continuation-line joining for one binding list. */
const MAX_JOINED_LINES = 40;

function extractImportSpecifiers(source: string): RawEdge[] {
  const edges: RawEdge[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trimStart();

    // Dynamic import(...) — skipped on comment lines so a commented-out
    // `// await import('../x.ts')` is not a false positive. A specifier that
    // sits on a later line than the `import(` opener (a parenthesized
    // multiline dynamic import) is reached by joining continuation lines.
    if (!trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
      let dynScan = trimmed;
      let k = i;
      while (
        DYNAMIC_IMPORT_OPEN.test(dynScan) &&
        k - i < MAX_JOINED_LINES &&
        k + 1 < lines.length
      ) {
        k += 1;
        dynScan += ' ' + (lines[k] ?? '').trim();
      }
      const dyn = dynScan.match(DYNAMIC_IMPORT);
      if (dyn?.[1]) {
        edges.push({ line: i + 1, specifier: dyn[1] });
        continue;
      }
    }

    if (!OPENS_STATEMENT.test(trimmed)) continue;
    if (EXPORT_DECLARATION.test(trimmed)) continue;

    const side = trimmed.match(SIDE_EFFECT_IMPORT);
    if (side?.[1]) {
      edges.push({ line: i + 1, specifier: side[1] });
      continue;
    }

    // Static import/export ... from '...'. A multiline binding list puts the
    // `} from '...'` clause on a later line, so join continuation lines until
    // the specifier (or a statement terminator) appears. The edge is recorded
    // at the line the statement OPENS on.
    let joined = trimmed;
    let j = i;
    while (
      !FROM_SPEC.test(joined) &&
      !/;\s*$/.test(joined) &&
      j - i < MAX_JOINED_LINES &&
      j + 1 < lines.length
    ) {
      j += 1;
      joined += ' ' + (lines[j] ?? '').trim();
    }
    const m = joined.match(FROM_SPEC);
    if (m?.[1]) edges.push({ line: i + 1, specifier: m[1] });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Walk src/**/*.ts
// ---------------------------------------------------------------------------

function walkSrcFiles(repoRoot: string): string[] {
  const srcDir = path.join(repoRoot, 'src');
  if (!existsSync(srcDir)) return [];

  const results: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile()
        && entry.name.endsWith('.ts')
        && !entry.name.endsWith('.d.ts')
      ) {
        results.push(full);
      }
    }
  }

  walk(srcDir);
  return results;
}

// ---------------------------------------------------------------------------
// Core violation scanner
// ---------------------------------------------------------------------------

export function findImportViolations(
  repoRoot: string,
  params?: BoundaryParams,
): BoundaryViolation[] {
  const matrix = buildLayerMatrix(params);
  const violations: BoundaryViolation[] = [];

  for (const srcFile of walkSrcFiles(repoRoot)) {
    const fromLayer = resolveLayer(srcFile, repoRoot);
    if (fromLayer === null) continue;

    const source = readFileSync(srcFile, 'utf8');
    const edges = extractImportSpecifiers(source);
    // Store repo-relative path so the baseline file is portable and
    // does not leak local home paths into committed history.
    const relSrcFile = path.relative(repoRoot, srcFile).split(path.sep).join('/');

    for (const { line, specifier } of edges) {
      // Only relative specifiers are relevant
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;

      // Resolve target to absolute path
      const targetAbs = path.resolve(path.dirname(srcFile), specifier);
      const toLayer = resolveLayer(targetAbs, repoRoot);
      if (toLayer === null) continue; // Outside tracked scope

      // Same layer is always allowed
      if (fromLayer === toLayer) continue;

      // 'root' can import anything
      if (fromLayer === 'root') continue;

      // Any layer may import 'root'
      if (toLayer === 'root') continue;

      // Check matrix
      const allowed = matrix[fromLayer];
      if (allowed === undefined) {
        // Unknown layer — flag it
        violations.push({ file: relSrcFile, line, specifier, fromLayer, toLayer });
        continue;
      }

      // '*' means unrestricted (used for 'root')
      if (allowed.includes('*')) continue;

      if (!allowed.includes(toLayer)) {
        violations.push({ file: relSrcFile, line, specifier, fromLayer, toLayer });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Baseline (ratchet) helpers
// ---------------------------------------------------------------------------

function baselinePath(repoRoot: string): string {
  return path.join(repoRoot, '.claude/fitness/boundary-baseline.json');
}

function loadBaseline(repoRoot: string): BoundaryViolation[] {
  const bp = baselinePath(repoRoot);
  if (!existsSync(bp)) return [];
  const raw = readFileSync(bp, 'utf8');
  // Fail-closed: a corrupt baseline must not silently pass the check.
  // Any JSON parse error propagates up to the run() caller so it can
  // set a nonzero exit code rather than treating all violations as new.
  return JSON.parse(raw) as BoundaryViolation[];
}

/**
 * Ratchet identity for a violation. Deliberately EXCLUDES the line number:
 * a formatter shifting a baselined import to a different line must not
 * resurrect it as "new" debt. `line` remains in the record for navigation.
 *
 * Tradeoff: two distinct forbidden imports of the SAME specifier from the
 * SAME file collapse to one key, so once one is grandfathered a second
 * forbidden import of that exact module would not fire. Accepted because a
 * forbidden edge to that module already exists in the baseline (the
 * architectural violation is already recorded); the per-module grain keeps
 * the ratchet formatter- and refactor-stable.
 */
function violationKey(v: BoundaryViolation): string {
  return `${v.file}:${v.specifier}`;
}

function saveBaseline(repoRoot: string, violations: BoundaryViolation[]): void {
  const bp = baselinePath(repoRoot);
  mkdirSync(path.dirname(bp), { recursive: true });
  const sorted = [...violations].sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
  writeFileSync(bp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printReport(repoRoot: string): void {
  const allFiles = walkSrcFiles(repoRoot);
  const matrix = buildLayerMatrix();
  const edgeCounts = new Map<string, number>();

  for (const srcFile of allFiles) {
    const fromLayer = resolveLayer(srcFile, repoRoot);
    if (fromLayer === null) continue;

    const source = readFileSync(srcFile, 'utf8');
    const edges = extractImportSpecifiers(source);

    for (const { specifier } of edges) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const targetAbs = path.resolve(path.dirname(srcFile), specifier);
      const toLayer = resolveLayer(targetAbs, repoRoot);
      if (toLayer === null) continue;

      const key = `${fromLayer} → ${toLayer}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  console.log('\nLayer edge report:');
  console.log('==================');
  for (const [edge, count] of [...edgeCounts.entries()].sort()) {
    const [from, , to] = edge.split(' ');
    if (!from || !to) continue;
    const allowed = matrix[from];
    const status =
      from === to || to === 'root' || from === 'root'
        ? 'SAME/ROOT'
        : allowed?.includes(to) || allowed?.includes('*')
          ? 'OK'
          : 'VIOLATION';
    console.log(`  ${edge.padEnd(40)} ${String(count).padStart(4)}  [${status}]`);
  }
  console.log('');
}

function printViolation(v: BoundaryViolation, _repoRoot: string): void {
  // v.file is already repo-relative
  const relFile = v.file;
  const matrix = buildLayerMatrix();
  const allowed = matrix[v.fromLayer] ?? [];
  const allowedStr = allowed.length > 0 ? allowed.join(', ') : '(none)';

  console.error(`
${relFile}:${v.line}  ${v.fromLayer} → ${v.toLayer} not allowed
  Matrix rule: ${v.fromLayer} may only import [${allowedStr}]
  Remediation: Route through an allowed layer, move shared code into src/lib or src/core,
               or — if this edge is genuinely architectural — change the matrix in
               scripts/lib/fitness/registry.ts params (requires code review).`);
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  mode: 'check' | 'report' | 'baseline-save';
  root: string;
  help: boolean;
}

function parseArgs(argv: string[], defaultRoot: string): ParsedArgs {
  const args: ParsedArgs = { mode: 'check', root: defaultRoot, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--report') {
      args.mode = 'report';
    } else if (arg === '--baseline-save') {
      args.mode = 'baseline-save';
    } else if (arg === '--root') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--root requires a directory path');
      args.root = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run guard:boundaries [-- [--report] [--baseline-save] [--root <dir>]]

Checks import direction between src/ layers against the allowed matrix.

Modes:
  (default)         Check for new violations not in baseline; exit 1 on new debt.
  --report          Print the full observed edge list and exit 0.
  --baseline-save   Write current violations to .claude/fitness/boundary-baseline.json.

Options:
  --root <dir>      Repo root to scan (default: process.cwd()).
  --help            Show this help.

Environment:
  WHATSOUP_SKIP_BOUNDARY_CHECK=1  Skip locally (ignored when CI/GITHUB_ACTIONS is set).`);
}

// ---------------------------------------------------------------------------
// Exported run() for tests
// ---------------------------------------------------------------------------

export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): RunResult {
  // Honor skip env var — but not in CI
  if (env.WHATSOUP_SKIP_BOUNDARY_CHECK === '1') {
    const inCi = env.CI === 'true' || Boolean(env.GITHUB_ACTIONS);
    if (inCi) {
      console.warn(
        'WHATSOUP_SKIP_BOUNDARY_CHECK=1 ignored: CI/GITHUB_ACTIONS detected; import boundary check will run (this skip is for local dev only)',
      );
    } else {
      console.warn('import boundary check skipped via WHATSOUP_SKIP_BOUNDARY_CHECK=1');
      return { allViolations: [], newViolations: [], baselinedViolations: [] };
    }
  }

  const args = parseArgs(argv, cwd);

  if (args.help) {
    printHelp();
    return { allViolations: [], newViolations: [], baselinedViolations: [] };
  }

  const repoRoot = args.root;

  if (args.mode === 'report') {
    printReport(repoRoot);
    return { allViolations: [], newViolations: [], baselinedViolations: [] };
  }

  const allViolations = findImportViolations(repoRoot);

  if (args.mode === 'baseline-save') {
    saveBaseline(repoRoot, allViolations);
    console.log(`Saved ${allViolations.length} violations to .claude/fitness/boundary-baseline.json`);
    return { allViolations, newViolations: [], baselinedViolations: allViolations };
  }

  // Refuse to certify a tree that was never read. This backs severity:'block' rule
  // arch.import-boundaries, so "passed (no violations)" from a zero-file scan is a false
  // green on a blocking gate. The check is on files READ, not on `src/` existing: a decoy
  // checkout with an empty `src/` satisfies any presence proxy while reading nothing —
  // which is how the reverted version of this refusal (`9cf044d45`) still passed.
  const scannedFiles = walkSrcFiles(repoRoot).length;
  if (scannedFiles === 0) {
    console.error(
      `import boundary check INCONCLUSIVE — examined 0 source file(s) under ` +
        `${path.join(repoRoot, 'src')}; refusing to report "passed" for a tree that was ` +
        'never read',
    );
    process.exitCode = 2;
    return { allViolations, newViolations: [], baselinedViolations: [] };
  }

  // Default: check mode with ratchet
  const baseline = loadBaseline(repoRoot);
  const baselined = new Set(baseline.map(violationKey));
  const newViolations = allViolations.filter((v) => !baselined.has(violationKey(v)));
  const baselinedViolations = allViolations.filter((v) => baselined.has(violationKey(v)));

  // Check for shrinkage
  const baselineCount = baseline.length;
  if (baselineCount > allViolations.length) {
    console.log(
      `Baseline shrunk (${baselineCount} → ${allViolations.length} violations); run --baseline-save to ratchet down.`,
    );
  }

  if (newViolations.length > 0) {
    console.error(`\n${newViolations.length} new import boundary violation(s):`);
    for (const v of newViolations) {
      printViolation(v, repoRoot);
    }
    process.exitCode = 1;
  } else if (allViolations.length === 0) {
    console.log(`import boundary check passed (no violations across ${scannedFiles} file(s))`);
  } else {
    console.log(
      `import boundary check passed (${baselinedViolations.length} grandfathered violation(s) in baseline, ${scannedFiles} file(s) examined)`,
    );
  }

  return { allViolations, newViolations, baselinedViolations };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
