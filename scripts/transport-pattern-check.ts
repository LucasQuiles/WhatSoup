/**
 * guard:transport-patterns — transport-agnostic pattern enforcement.
 *
 * Enforces the three `hygiene.no-*-in-generic-ui` registry rules:
 *   - hygiene.no-wa-jid-literal-in-generic-ui   (S4/S14/S18 surface audit)
 *   - hygiene.no-whatsapp-copy-in-generic-ui    (S2/S3/S15 surface audit)
 *   - hygiene.no-health-whatsapp-key-read       (S17 surface audit)
 *
 * Shape mirrors scripts/import-boundary-check.ts:
 *   - Rule params are read from scripts/lib/fitness/registry.ts (SSOT).
 *     Missing rule or params fails closed (throws → nonzero exit).
 *   - Ratchet baseline at .claude/fitness/transport-patterns-baseline.json.
 *     Baseline identity EXCLUDES line numbers (formatter-stable), keyed
 *     `ruleId:file:pattern`. A corrupt baseline fails closed.
 *   - Modes: check (default) | --report | --baseline-save | --root <dir>.
 *
 * Exit codes: 0 = no NEW violations; 1 = new violations found (actionable);
 * 2 = infrastructure failure (missing params, corrupt baseline, unreadable
 * tree). This mirrors the named-exit-code convention so CI can branch.
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

export interface PatternRuleParams {
  globs: string[];
  extensions: string[];
  patterns: string[];
  allowlistPaths: string[];
}

export interface PatternViolation {
  ruleId: string;
  file: string;
  line: number;
  pattern: string;
  lineText: string;
}

interface RuleSpec {
  id: string;
  params: PatternRuleParams;
}

export const ENFORCED_RULE_IDS = [
  'hygiene.no-wa-jid-literal-in-generic-ui',
  'hygiene.no-whatsapp-copy-in-generic-ui',
  'hygiene.no-health-whatsapp-key-read',
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
    const p = rule.params as Partial<PatternRuleParams>;
    if (!Array.isArray(p.globs) || !Array.isArray(p.extensions)
      || !Array.isArray(p.patterns) || !Array.isArray(p.allowlistPaths)) {
      throw new Error(`${id} params malformed: need globs/extensions/patterns/allowlistPaths arrays`);
    }
    specs.push({ id, params: p as PatternRuleParams });
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
  return allowlistPaths.some((allowed) => {
    const a = allowed.endsWith('/') ? allowed : `${allowed}`;
    return norm === a || norm.startsWith(a);
  });
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export function scanRule(repoRoot: string, spec: RuleSpec): PatternViolation[] {
  const violations: PatternViolation[] = [];
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

export function scanAll(repoRoot: string, specs: RuleSpec[] = loadRuleSpecs()): PatternViolation[] {
  const out: PatternViolation[] = [];
  for (const spec of specs) out.push(...scanRule(repoRoot, spec));
  return out;
}

// ---------------------------------------------------------------------------
// Baseline (ratchet) helpers
// ---------------------------------------------------------------------------

function baselinePath(repoRoot: string): string {
  return path.join(repoRoot, '.claude/fitness/transport-patterns-baseline.json');
}

function loadBaseline(repoRoot: string): PatternViolation[] {
  const bp = baselinePath(repoRoot);
  if (!existsSync(bp)) return [];
  const raw = readFileSync(bp, 'utf8');
  // Fail-closed: a corrupt baseline must not silently pass the check.
  // Any JSON parse error propagates to the caller so it exits nonzero
  // instead of treating every violation as new (or none as baselined).
  return JSON.parse(raw) as PatternViolation[];
}

/**
 * Ratchet identity EXCLUDES the line number: a formatter shifting a
 * baselined occurrence to a different line must not resurrect it as "new"
 * debt. Keyed per rule+file+pattern so a second occurrence of the SAME
 * pattern in the SAME file under the SAME rule collapses to one key —
 * accepted because that edge is already recorded as debt (same tradeoff as
 * the import-boundary ratchet).
 */
function violationKey(v: PatternViolation): string {
  return `${v.ruleId}:${v.file}:${v.pattern}`;
}

function saveBaseline(repoRoot: string, violations: PatternViolation[]): void {
  const bp = baselinePath(repoRoot);
  mkdirSync(path.dirname(bp), { recursive: true });
  const sorted = [...violations].sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
  writeFileSync(bp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

export interface PartitionResult {
  newViolations: PatternViolation[];
  baselinedViolations: PatternViolation[];
}

export function partitionByBaseline(
  violations: PatternViolation[],
  baseline: PatternViolation[],
): PartitionResult {
  const baseKeys = new Set(baseline.map(violationKey));
  const newViolations: PatternViolation[] = [];
  const baselinedViolations: PatternViolation[] = [];
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

function printViolation(v: PatternViolation): void {
  console.error(`
${v.file}:${v.line}  [${v.ruleId}]
  pattern: ${JSON.stringify(v.pattern)}
  line:    ${v.lineText}
  Remediation: route through the transport layer / a per-transport helper, or —
               if this occurrence is genuinely transport-specific — extend the
               rule allowlist in scripts/lib/fitness/registry.ts (code review).`);
}

function printReport(violations: PatternViolation[], baseline: PatternViolation[]): void {
  const { newViolations, baselinedViolations } = partitionByBaseline(violations, baseline);
  const byRule = new Map<string, { total: number; fresh: number; base: number }>();
  for (const v of violations) {
    const entry = byRule.get(v.ruleId) ?? { total: 0, fresh: 0, base: 0 };
    entry.total += 1;
    byRule.set(v.ruleId, entry);
  }
  for (const v of newViolations) byRule.get(v.ruleId)!.fresh += 1;
  for (const v of baselinedViolations) byRule.get(v.ruleId)!.base += 1;

  console.log('\nTransport-pattern report:');
  console.log('=========================');
  for (const [ruleId, counts] of [...byRule.entries()].sort()) {
    console.log(
      `  ${ruleId.padEnd(46)} total=${String(counts.total).padStart(3)} new=${String(counts.fresh).padStart(3)} baselined=${String(counts.base).padStart(3)}`,
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
    console.error(`transport-pattern check: ${(err as Error).message}`);
    return 2;
  }

  if (args.help) {
    console.log(`Usage: npm run guard:transport-patterns [-- [--report] [--baseline-save] [--root <dir>]]

Enforces the hygiene.no-* transport-agnostic registry rules against
console/src + deploy/scripts. Default mode exits 1 when NEW (unbaselined)
violations exist; 0 when clean or only baselined debt; 2 on infrastructure
failure (missing registry params, corrupt baseline, unreadable tree).

  --report         print per-rule totals (no exit change)
  --baseline-save  rewrite the ratchet baseline with the current violations
                   (requires code review; this is how debt is grandfathered)
  --root <dir>     scan a different repo root (testing)`);
    return 0;
  }

  let specs: RuleSpec[];
  try {
    specs = loadRuleSpecs();
  } catch (err) {
    console.error(`transport-pattern check FAILED closed: ${(err as Error).message}`);
    return 2;
  }

  const violations = scanAll(args.root, specs);

  if (args.mode === 'baseline-save') {
    saveBaseline(args.root, violations);
    console.log(`transport-pattern baseline saved: ${violations.length} violation(s) -> ${baselinePath(args.root)}`);
    return 0;
  }

  let baseline: PatternViolation[];
  try {
    baseline = loadBaseline(args.root);
  } catch (err) {
    console.error(`transport-pattern check FAILED closed: corrupt baseline at ${baselinePath(args.root)}: ${(err as Error).message}`);
    return 2;
  }

  if (args.mode === 'report') {
    printReport(violations, baseline);
  }

  const { newViolations, baselinedViolations } = partitionByBaseline(violations, baseline);

  if (newViolations.length > 0) {
    console.error(`\ntransport-pattern check: ${newViolations.length} NEW violation(s) (transport-agnostic rules):`);
    for (const v of newViolations) printViolation(v);
    console.error(`
${baselinedViolations.length} baselined violation(s) suppressed by the ratchet.
Fix the new occurrences, or — if they are intentional — review and run:
  npm run guard:transport-patterns -- --baseline-save`);
    return 1;
  }

  console.log(
    `transport-pattern check passed (${violations.length} total, ${baselinedViolations.length} baselined, 0 new)`,
  );
  return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  run().then((code) => process.exit(code));
}
