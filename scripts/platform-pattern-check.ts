/**
 * guard:platform-patterns — cross-platform portability pattern enforcement.
 *
 * Enforces portability rules from the fitness registry whose `rings` include
 * `guard`. Based on the same architecture as transport-pattern-check.ts:
 *   - Rule params are read from scripts/lib/fitness/registry.ts (SSOT).
 *   - Ratchet baseline at .claude/fitness/platform-baseline.json.
 *   - Modes: check (default) | --report | --baseline-save | --root <dir>.
 *
 * Exit codes: 0 = no NEW violations; 1 = new violations found (actionable);
 * 2 = infrastructure failure (missing params, corrupt baseline, unreadable
 * tree).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fitnessRules } from './lib/fitness/registry.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlatformRuleParams {
  globs: string[];
  extensions: string[];
  patterns: string[];
  allowlistPaths: string[];
}

export interface PlatformViolation {
  ruleId: string;
  file: string;
  line: number;
  pattern: string;
  lineText: string;
}

interface RuleSpec {
  id: string;
  params: PlatformRuleParams;
}

export const ENFORCED_RULE_IDS = [
  'portability.no-hardcoded-platform-binaries',
  'portability.platform-paths-guarded',
  'portability.systemctl-guarded',
  'portability.gnu-bsd-shell-flags',
] as const;

// ---------------------------------------------------------------------------
// Registry access (fail-closed)
// ---------------------------------------------------------------------------

export function loadRuleSpecs(ruleIds: readonly string[] = ENFORCED_RULE_IDS): RuleSpec[] {
  const specs: RuleSpec[] = [];
  for (const id of ruleIds) {
    const rule = fitnessRules.find((r) => r.id === id);
    if (!rule?.params) {
      throw new Error(`${id} rule or params not found in fitness registry`);
    }
    const p = rule.params as Partial<PlatformRuleParams>;
    if (
      !Array.isArray(p.globs) || !Array.isArray(p.extensions)
      || !Array.isArray(p.patterns) || !Array.isArray(p.allowlistPaths)
    ) {
      throw new Error(`${id} params malformed: need globs/extensions/patterns/allowlistPaths arrays`);
    }
    specs.push({ id, params: p as PlatformRuleParams });
  }
  // Non-vacuity check: if the declared rule set is actually empty, something
  // is wrong — registry data changed or rule list drifted. Refuse to proceed.
  if (specs.length === 0) {
    throw new Error('platform-pattern guard: zero rules loaded — registry mismatch');
  }
  return specs;
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function walkFiles(dir: string, extensions: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, extensions, out);
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function isAllowlisted(relFile: string, allowlistPaths: string[]): boolean {
  const norm = relFile.split(path.sep).join('/');
  return allowlistPaths.some((allowed) => norm === allowed || norm.startsWith(allowed));
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export function scanRule(repoRoot: string, spec: RuleSpec): PlatformViolation[] {
  const violations: PlatformViolation[] = [];
  for (const globRoot of spec.params.globs) {
    const absRoot = path.join(repoRoot, globRoot);
    const files = walkFiles(absRoot, spec.params.extensions);
    for (const absFile of files) {
      const relFile = path.relative(repoRoot, absFile).split(path.sep).join('/');
      if (isAllowlisted(relFile, spec.params.allowlistPaths)) continue;
      const source = readFileSync(absFile, 'utf8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i]!;
        for (const pattern of spec.params.patterns) {
          if (lineText.includes(pattern)) {
            violations.push({
              ruleId: spec.id,
              file: relFile,
              line: i + 1,
              pattern,
              lineText: lineText.trim().slice(0, 160),
            });
          }
        }
      }
    }
  }
  return violations;
}

export function scanAll(repoRoot: string, specs: RuleSpec[] = loadRuleSpecs()): PlatformViolation[] {
  const out: PlatformViolation[] = [];
  for (const spec of specs) out.push(...scanRule(repoRoot, spec));
  return out;
}

/**
 * The set of distinct files the rule globs would examine.
 */
export function collectScannableFiles(
  repoRoot: string,
  specs: RuleSpec[] = loadRuleSpecs(),
): Set<string> {
  const files = new Set<string>();
  for (const spec of specs) {
    for (const globRoot of spec.params.globs) {
      for (const abs of walkFiles(path.join(repoRoot, globRoot), spec.params.extensions)) {
        files.add(abs);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Baseline (ratchet) helpers
// ---------------------------------------------------------------------------

function baselinePath(repoRoot: string): string {
  return path.join(repoRoot, '.claude/fitness/platform-baseline.json');
}

function loadBaseline(repoRoot: string): PlatformViolation[] {
  const bp = baselinePath(repoRoot);
  if (!existsSync(bp)) return [];
  const raw = readFileSync(bp, 'utf8');
  return JSON.parse(raw) as PlatformViolation[];
}

function violationKey(v: PlatformViolation): string {
  return `${v.ruleId}:${v.file}:${v.pattern}`;
}

function saveBaseline(repoRoot: string, violations: PlatformViolation[]): void {
  const bp = baselinePath(repoRoot);
  mkdirSync(path.dirname(bp), { recursive: true });
  const sorted = [...violations].sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
  writeFileSync(bp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

export interface PartitionResult {
  newViolations: PlatformViolation[];
  baselinedViolations: PlatformViolation[];
}

export function partitionByBaseline(
  violations: PlatformViolation[],
  baseline: PlatformViolation[],
): PartitionResult {
  const baseKeys = new Set(baseline.map(violationKey));
  const newViolations: PlatformViolation[] = [];
  const baselinedViolations: PlatformViolation[] = [];
  for (const v of violations) {
    if (baseKeys.has(violationKey(v))) {
      baselinedViolations.push(v);
    } else {
      newViolations.push(v);
    }
  }
  return { newViolations, baselinedViolations };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printViolation(v: PlatformViolation): void {
  const remediationMessages: Record<string, string> = {
    'portability.no-hardcoded-platform-binaries':
      'Use shutil.which() or find-on-path resolution instead of hardcoded /usr/bin/ paths.',
    'portability.platform-paths-guarded':
      'Guard behind process.platform === "linux" check before accessing /proc/ or /sys/.',
    'portability.systemctl-guarded':
      'Wrap in HOST_PLATFORM === "linux" guard or provide launchctl fallback for macOS.',
    'portability.gnu-bsd-shell-flags':
      'Use portable equivalents: readlink -f -> helper, sha256sum -> shasum + fallback, mktemp -> portable template.',
  };
  const remediation = remediationMessages[v.ruleId] ?? 'Review for cross-platform compatibility.';
  console.error(`
${v.file}:${v.line}  [${v.ruleId}]
  pattern: ${JSON.stringify(v.pattern)}
  line:    ${v.lineText}
  Remediation: ${remediation}`);
}

function printReport(violations: PlatformViolation[], baseline: PlatformViolation[]): void {
  const { newViolations, baselinedViolations } = partitionByBaseline(violations, baseline);
  const byRule = new Map<string, { total: number; fresh: number; base: number }>();
  for (const v of violations) {
    const entry = byRule.get(v.ruleId) ?? { total: 0, fresh: 0, base: 0 };
    entry.total += 1;
    byRule.set(v.ruleId, entry);
  }
  for (const v of newViolations) byRule.get(v.ruleId)!.fresh += 1;
  for (const v of baselinedViolations) byRule.get(v.ruleId)!.base += 1;

  console.log('\nPlatform portability report:');
  console.log('============================');
  for (const [ruleId, counts] of [...byRule.entries()].sort()) {
    console.log(
      `  ${ruleId.padEnd(52)} total=${String(counts.total).padStart(3)} new=${String(counts.fresh).padStart(3)} baselined=${String(counts.base).padStart(3)}`,
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI
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

export async function run(
  argv: string[] = process.argv.slice(2),
  repoRoot: string = path.resolve(import.meta.dirname, '..'),
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, repoRoot);
  } catch (err) {
    console.error(`platform-pattern check: ${(err as Error).message}`);
    return 2;
  }

  if (args.help) {
    console.log(`Usage: npm run guard:platform-patterns [-- [--report] [--baseline-save] [--root <dir>]]

Enforces portability registry rules against src/, scripts/, deploy/scripts/.
Default mode exits 1 when NEW (unbaselined) violations exist; 0 when clean
or only baselined debt; 2 on infrastructure failure.

  --report         print per-rule totals (no exit change)
  --baseline-save  rewrite the ratchet baseline with current violations
  --root <dir>     scan a different repo root (testing)`);
    return 0;
  }

  let specs: RuleSpec[];
  try {
    specs = loadRuleSpecs();
  } catch (err) {
    console.error(`platform-pattern check FAILED closed: ${(err as Error).message}`);
    return 2;
  }

  const violations = scanAll(args.root, specs);

  if (args.mode === 'baseline-save') {
    saveBaseline(args.root, violations);
    console.log(`platform-pattern baseline saved: ${violations.length} violation(s) -> ${baselinePath(args.root)}`);
    return 0;
  }

  let baseline: PlatformViolation[];
  try {
    baseline = loadBaseline(args.root);
  } catch (err) {
    console.error(`platform-pattern check FAILED closed: corrupt baseline at ${baselinePath(args.root)}: ${(err as Error).message}`);
    return 2;
  }

  if (args.mode === 'report') {
    printReport(violations, baseline);
  }

  const { newViolations, baselinedViolations } = partitionByBaseline(violations, baseline);

  if (newViolations.length > 0) {
    console.error(`\nplatform-pattern check: ${newViolations.length} NEW violation(s) (portability rules):`);
    for (const v of newViolations) printViolation(v);
    console.error(`
${baselinedViolations.length} baselined violation(s) suppressed by the ratchet.
Fix the new occurrences, or — if they are intentional — review and run:
  npm run guard:platform-patterns -- --baseline-save`);
    return 1;
  }

  // Non-vacuity floor
  const filesScanned = collectScannableFiles(args.root, specs).size;
  if (filesScanned === 0) {
    console.error(
      `platform-pattern check: INCONCLUSIVE — the rule globs matched 0 files under ${args.root}. ` +
        'A scan that read no files finds no portability violations trivially, which is not a pass.',
    );
    return 2;
  }

  console.log(
    `platform-pattern check passed (${violations.length} total, ${baselinedViolations.length} baselined, 0 new; ${filesScanned} file(s) scanned)`,
  );
  return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  run().then((code) => process.exit(code));
}
