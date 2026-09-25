import { isHelpFlag, parseClosedOptions, type ClosedOptionError } from './cli-args.ts';
import { parseBoundaryJsonBytes } from './verification/boundary-run/schema.ts';
import { hasExactKeys, isRecord, isSafePath } from './verification/boundary-run/shared.ts';

export const GUARD_TEST_COVERAGE_CONTROL_ID = 'test.guard-coverage' as const;
export const GUARD_TEST_COVERAGE_REPRODUCE = 'npm run guard:guard-test-coverage' as const;
export const MAX_GUARD_COVERAGE_GUARDS = 2_048;
export const MAX_GUARD_COVERAGE_FINDINGS = 48;
export const MAX_GUARD_COVERAGE_VERBOSE_ITEMS = 256;
export const MAX_GUARD_COVERAGE_REPORT_BYTES = 32_768;

const MAX_DIAGNOSTIC_PATH_BYTES = 256;
const MAX_CONCISE_FINDINGS = 12;

export type GuardTestCoverageReason =
  | 'no-test'
  | 'test-not-wired'
  | 'test-does-not-parse'
  | 'test-does-not-import-or-invoke-guard'
  | 'test-does-not-exercise-failure';

export interface GuardCoverageGap {
  guard: string;
  reason: GuardTestCoverageReason;
  expectedTest: string;
  detail?: string;
}

export interface GuardAllowlistEntry {
  guard: string;
  reason: string;
}

export interface GuardCoverageResult {
  covered: string[];
  allowlisted: GuardAllowlistEntry[];
  gaps: GuardCoverageGap[];
  semanticGaps: GuardCoverageGap[];
}

export type GuardTestCoverageOutcome = 'pass' | 'warn' | 'block' | 'inconclusive';
export type GuardTestCoverageExitCode = 0 | 1 | 2;
export type GuardTestCoverageSemanticMode = 'shadow' | 'enforce';
export type GuardTestCoverageFormat = 'text' | 'json';

export type GuardTestCoverageFindingCode =
  | 'test.guard-coverage.test-missing'
  | 'test.guard-coverage.test-not-wired'
  | 'test.guard-coverage.test-unparseable'
  | 'test.guard-coverage.guard-not-invoked'
  | 'test.guard-coverage.failure-not-proved';

export type GuardTestCoverageCauseCode =
  | GuardTestCoverageFindingCode
  | ClosedOptionError
  | 'ci.input.option-value-invalid'
  | 'test.guard-coverage.inventory-empty'
  | 'test.guard-coverage.inventory-limit-exceeded'
  | 'test.guard-coverage.scan-unavailable'
  | 'test.guard-coverage.output-truncated';

export type GuardTestCoverageCode =
  | 'test.guard-coverage.pass'
  | 'test.guard-coverage.semantic-shadow'
  | 'test.guard-coverage.block'
  | Exclude<GuardTestCoverageCauseCode, GuardTestCoverageFindingCode | 'test.guard-coverage.output-truncated'>;

export interface GuardTestCoverageFindingV1 {
  code: GuardTestCoverageFindingCode;
  decision: 'warn' | 'block';
  guard: string;
  expectedTest: string;
}

export interface GuardTestCoverageReportV1 {
  schemaVersion: 1;
  controlId: typeof GUARD_TEST_COVERAGE_CONTROL_ID;
  outcome: GuardTestCoverageOutcome;
  exitCode: GuardTestCoverageExitCode;
  code: GuardTestCoverageCode;
  semanticMode: GuardTestCoverageSemanticMode;
  counts: {
    scanned: number;
    covered: number;
    allowlisted: number;
    structuralGaps: number;
    semanticGaps: number;
    reportedFindings: number;
  };
  causeCodes: GuardTestCoverageCauseCode[];
  findings: GuardTestCoverageFindingV1[];
  truncation: {
    truncated: boolean;
    omittedFindings: number;
  };
  reproduce: string;
}

export interface GuardTestCoverageCliOptions {
  semanticMode: GuardTestCoverageSemanticMode;
  format: GuardTestCoverageFormat;
  verbose: boolean;
}

export type GuardTestCoverageCliParseResult =
  | { kind: 'help' }
  | { kind: 'options'; options: GuardTestCoverageCliOptions }
  | {
      kind: 'error';
      code: Exclude<GuardTestCoverageCode, 'test.guard-coverage.pass' | 'test.guard-coverage.semantic-shadow' | 'test.guard-coverage.block'>;
      options: GuardTestCoverageCliOptions;
    };

export interface GuardTestCoverageCliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const GUARD_TEST_COVERAGE_USAGE = [
  'Usage: npm run guard:guard-test-coverage -- [options]',
  '',
  'Options:',
  '  --semantic-mode <shadow|enforce>  Warn on or block semantic proof gaps (default: shadow).',
  '  --format <text|json>              Select deterministic output (default: text).',
  '  --verbose                         List bounded covered and allowlisted inventories in text.',
  '  --help, -h                        Show this help without scanning the repository.',
  '',
  'Exit codes: 0 = pass/advisory, 1 = actionable finding, 2 = inconclusive evidence.',
  '',
].join('\n');

const FINDING_CODE_BY_REASON: Readonly<Record<GuardTestCoverageReason, GuardTestCoverageFindingCode>> = {
  'no-test': 'test.guard-coverage.test-missing',
  'test-not-wired': 'test.guard-coverage.test-not-wired',
  'test-does-not-parse': 'test.guard-coverage.test-unparseable',
  'test-does-not-import-or-invoke-guard': 'test.guard-coverage.guard-not-invoked',
  'test-does-not-exercise-failure': 'test.guard-coverage.failure-not-proved',
};

const ROOT_KEYS = [
  'schemaVersion',
  'controlId',
  'outcome',
  'exitCode',
  'code',
  'semanticMode',
  'counts',
  'causeCodes',
  'findings',
  'truncation',
  'reproduce',
] as const;
const COUNT_KEYS = [
  'scanned',
  'covered',
  'allowlisted',
  'structuralGaps',
  'semanticGaps',
  'reportedFindings',
] as const;
const FINDING_KEYS = ['code', 'decision', 'guard', 'expectedTest'] as const;
const TRUNCATION_KEYS = ['truncated', 'omittedFindings'] as const;
const AGGREGATE_CODES = new Set<GuardTestCoverageCode>([
  'test.guard-coverage.pass',
  'test.guard-coverage.semantic-shadow',
  'test.guard-coverage.block',
  'ci.input.duplicate-option',
  'ci.input.option-unknown',
  'ci.input.option-value-missing',
  'ci.input.option-value-invalid',
  'test.guard-coverage.inventory-empty',
  'test.guard-coverage.inventory-limit-exceeded',
  'test.guard-coverage.scan-unavailable',
]);
const CAUSE_CODES = new Set<GuardTestCoverageCauseCode>([
  ...Object.values(FINDING_CODE_BY_REASON),
  'ci.input.duplicate-option',
  'ci.input.option-unknown',
  'ci.input.option-value-missing',
  'ci.input.option-value-invalid',
  'test.guard-coverage.inventory-empty',
  'test.guard-coverage.inventory-limit-exceeded',
  'test.guard-coverage.scan-unavailable',
  'test.guard-coverage.output-truncated',
]);

export class GuardTestCoverageReportError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'GuardTestCoverageReportError';
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-keys');
  }
  return value;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_GUARD_COVERAGE_GUARDS;
}

function diagnosticPath(value: unknown, prefix: 'scripts' | 'tests/scripts'): value is string {
  return isSafePath(value)
    && value.startsWith(`${prefix}/`)
    && Buffer.byteLength(value, 'utf8') <= MAX_DIAGNOSTIC_PATH_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sortedUnique(values: readonly string[]): boolean {
  const sorted = [...values].sort();
  return new Set(values).size === values.length
    && values.every((value, index) => value === sorted[index]);
}

function reproductionCommand(semanticMode: GuardTestCoverageSemanticMode): string {
  return `${GUARD_TEST_COVERAGE_REPRODUCE} -- --semantic-mode ${semanticMode} --format json`;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareFindings(
  left: GuardTestCoverageFindingV1,
  right: GuardTestCoverageFindingV1,
): number {
  return compareStrings(left.guard, right.guard)
    || compareStrings(left.code, right.code)
    || compareStrings(left.expectedTest, right.expectedTest);
}

function isSemanticFindingCode(code: GuardTestCoverageFindingCode): boolean {
  return code === 'test.guard-coverage.test-unparseable'
    || code === 'test.guard-coverage.guard-not-invoked'
    || code === 'test.guard-coverage.failure-not-proved';
}

export function validateGuardTestCoverageReport(value: unknown): GuardTestCoverageReportV1 {
  const report = exactRecord(value, ROOT_KEYS);
  const counts = exactRecord(report.counts, COUNT_KEYS);
  const truncation = exactRecord(report.truncation, TRUNCATION_KEYS);

  if (report.schemaVersion !== 1 || report.controlId !== GUARD_TEST_COVERAGE_CONTROL_ID) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-identity');
  }
  if (
    (report.outcome !== 'pass' && report.outcome !== 'warn' && report.outcome !== 'block' && report.outcome !== 'inconclusive')
    || (report.exitCode !== 0 && report.exitCode !== 1 && report.exitCode !== 2)
    || (report.semanticMode !== 'shadow' && report.semanticMode !== 'enforce')
    || typeof report.code !== 'string'
    || !AGGREGATE_CODES.has(report.code as GuardTestCoverageCode)
  ) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-verdict');
  }
  if (
    !(
      (report.outcome === 'pass' && report.exitCode === 0 && report.code === 'test.guard-coverage.pass')
      || (report.outcome === 'warn' && report.exitCode === 0 && report.code === 'test.guard-coverage.semantic-shadow')
      || (report.outcome === 'block' && report.exitCode === 1 && report.code === 'test.guard-coverage.block')
      || (report.outcome === 'inconclusive' && report.exitCode === 2)
    )
  ) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.outcome-mismatch');
  }

  if (!COUNT_KEYS.every((key) => count(counts[key]))) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-count');
  }
  const scanned = Number(counts.scanned);
  const covered = Number(counts.covered);
  const allowlisted = Number(counts.allowlisted);
  const structuralGaps = Number(counts.structuralGaps);
  const semanticGaps = Number(counts.semanticGaps);
  const reportedFindings = Number(counts.reportedFindings);
  const totalFindings = structuralGaps + semanticGaps;
  if (
    scanned !== covered + allowlisted + structuralGaps
    || semanticGaps > covered
    || reportedFindings > MAX_GUARD_COVERAGE_FINDINGS
    || reportedFindings > totalFindings
    || reportedFindings !== Math.min(totalFindings, MAX_GUARD_COVERAGE_FINDINGS)
  ) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.count-mismatch');
  }

  if (!Array.isArray(report.findings) || report.findings.length !== reportedFindings) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-findings');
  }
  for (const value of report.findings) {
    const finding = exactRecord(value, FINDING_KEYS);
    if (
      typeof finding.code !== 'string'
      || !Object.values(FINDING_CODE_BY_REASON).includes(finding.code as GuardTestCoverageFindingCode)
      || (finding.decision !== 'warn' && finding.decision !== 'block')
      || !diagnosticPath(finding.guard, 'scripts')
      || !diagnosticPath(finding.expectedTest, 'tests/scripts')
    ) {
      throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-finding');
    }
    const semantic = isSemanticFindingCode(finding.code as GuardTestCoverageFindingCode);
    const expectedDecision = semantic && report.semanticMode === 'shadow' ? 'warn' : 'block';
    if (finding.decision !== expectedDecision) {
      throw new GuardTestCoverageReportError('test.guard-coverage.report.finding-decision-mismatch');
    }
  }
  const findings = report.findings as GuardTestCoverageFindingV1[];
  if (findings.some((finding, index) => index > 0 && compareFindings(findings[index - 1]!, finding) >= 0)) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-finding-order');
  }

  if (
    !Array.isArray(report.causeCodes)
    || report.causeCodes.length > 8
    || report.causeCodes.some((code) => typeof code !== 'string' || !CAUSE_CODES.has(code as GuardTestCoverageCauseCode))
    || !sortedUnique(report.causeCodes as string[])
  ) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-cause-codes');
  }
  const causeCodes = report.causeCodes as GuardTestCoverageCauseCode[];
  for (const finding of findings) {
    if (!causeCodes.includes(finding.code)) {
      throw new GuardTestCoverageReportError('test.guard-coverage.report.cause-code-mismatch');
    }
  }

  const omittedFindings = truncation.omittedFindings;
  if (
    typeof truncation.truncated !== 'boolean'
    || !count(omittedFindings)
    || Number(omittedFindings) !== totalFindings - reportedFindings
    || truncation.truncated !== (Number(omittedFindings) > 0)
    || (truncation.truncated && !causeCodes.includes('test.guard-coverage.output-truncated'))
  ) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-truncation');
  }
  if (report.outcome === 'pass' && causeCodes.length !== 0) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.cause-code-mismatch');
  }
  if (report.outcome === 'warn' || report.outcome === 'block') {
    const findingCodes = [...new Set(findings.map((finding) => finding.code))].sort();
    const allowedCauseCodes = new Set<GuardTestCoverageCauseCode>([
      ...Object.values(FINDING_CODE_BY_REASON),
      ...(truncation.truncated ? ['test.guard-coverage.output-truncated' as const] : []),
    ]);
    if (
      causeCodes.some((code) => !allowedCauseCodes.has(code))
      || (!truncation.truncated && causeCodes.join('\n') !== findingCodes.join('\n'))
    ) {
      throw new GuardTestCoverageReportError('test.guard-coverage.report.cause-code-mismatch');
    }
  }
  if (report.reproduce !== reproductionCommand(report.semanticMode as GuardTestCoverageSemanticMode)) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-reproduction');
  }

  if (report.outcome === 'pass' && totalFindings !== 0) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.outcome-mismatch');
  }
  if (report.outcome === 'warn' && (structuralGaps !== 0 || semanticGaps === 0 || report.semanticMode !== 'shadow')) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.outcome-mismatch');
  }
  if (report.outcome === 'block' && structuralGaps === 0 && (semanticGaps === 0 || report.semanticMode !== 'enforce')) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.outcome-mismatch');
  }
  if (report.outcome === 'inconclusive') {
    if (scanned !== 0 || totalFindings !== 0 || causeCodes.length !== 1 || causeCodes[0] !== report.code) {
      throw new GuardTestCoverageReportError('test.guard-coverage.report.outcome-mismatch');
    }
  }

  return value as GuardTestCoverageReportV1;
}

export function parseGuardTestCoverageReportBytes(bytes: Uint8Array): GuardTestCoverageReportV1 {
  if (bytes.byteLength > MAX_GUARD_COVERAGE_REPORT_BYTES) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.byte-budget');
  }
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.value === null) {
    throw new GuardTestCoverageReportError('test.guard-coverage.report.invalid-json');
  }
  return validateGuardTestCoverageReport(parsed.value);
}

function safePath(value: string, prefix: 'scripts' | 'tests/scripts'): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  return diagnosticPath(normalized, prefix) ? normalized : `${prefix}/unreportable-path`;
}

function findingFor(
  gap: GuardCoverageGap,
  semanticMode: GuardTestCoverageSemanticMode,
): GuardTestCoverageFindingV1 {
  const code = FINDING_CODE_BY_REASON[gap.reason];
  const semantic = isSemanticFindingCode(code);
  return {
    code,
    decision: semantic && semanticMode === 'shadow' ? 'warn' : 'block',
    guard: safePath(gap.guard, 'scripts'),
    expectedTest: safePath(gap.expectedTest, 'tests/scripts'),
  };
}

function emptyCounts(): GuardTestCoverageReportV1['counts'] {
  return {
    scanned: 0,
    covered: 0,
    allowlisted: 0,
    structuralGaps: 0,
    semanticGaps: 0,
    reportedFindings: 0,
  };
}

export function buildInconclusiveGuardTestCoverageReport(
  code: Exclude<GuardTestCoverageCode, 'test.guard-coverage.pass' | 'test.guard-coverage.semantic-shadow' | 'test.guard-coverage.block'>,
  semanticMode: GuardTestCoverageSemanticMode,
): GuardTestCoverageReportV1 {
  return validateGuardTestCoverageReport({
    schemaVersion: 1,
    controlId: GUARD_TEST_COVERAGE_CONTROL_ID,
    outcome: 'inconclusive',
    exitCode: 2,
    code,
    semanticMode,
    counts: emptyCounts(),
    causeCodes: [code],
    findings: [],
    truncation: { truncated: false, omittedFindings: 0 },
    reproduce: reproductionCommand(semanticMode),
  });
}

export function buildGuardTestCoverageReport(
  result: GuardCoverageResult,
  semanticMode: GuardTestCoverageSemanticMode,
): GuardTestCoverageReportV1 {
  const findings = [
    ...result.gaps.map((gap) => findingFor(gap, semanticMode)),
    ...result.semanticGaps.map((gap) => findingFor(gap, semanticMode)),
  ].sort(compareFindings);
  const reportedFindings = findings.slice(0, MAX_GUARD_COVERAGE_FINDINGS);
  const omittedFindings = findings.length - reportedFindings.length;
  const causeCodes = [...new Set<GuardTestCoverageCauseCode>([
    ...findings.map((finding) => finding.code),
    ...(omittedFindings > 0 ? ['test.guard-coverage.output-truncated' as const] : []),
  ])].sort();
  const blocks = result.gaps.length > 0
    || (semanticMode === 'enforce' && result.semanticGaps.length > 0);
  const warns = !blocks && result.semanticGaps.length > 0;

  return validateGuardTestCoverageReport({
    schemaVersion: 1,
    controlId: GUARD_TEST_COVERAGE_CONTROL_ID,
    outcome: blocks ? 'block' : warns ? 'warn' : 'pass',
    exitCode: blocks ? 1 : 0,
    code: blocks
      ? 'test.guard-coverage.block'
      : warns
        ? 'test.guard-coverage.semantic-shadow'
        : 'test.guard-coverage.pass',
    semanticMode,
    counts: {
      scanned: result.covered.length + result.allowlisted.length + result.gaps.length,
      covered: result.covered.length,
      allowlisted: result.allowlisted.length,
      structuralGaps: result.gaps.length,
      semanticGaps: result.semanticGaps.length,
      reportedFindings: reportedFindings.length,
    },
    causeCodes,
    findings: reportedFindings,
    truncation: { truncated: omittedFindings > 0, omittedFindings },
    reproduce: reproductionCommand(semanticMode),
  });
}

function requestedJson(argv: readonly string[]): boolean {
  return argv.some((value, index) => value === '--format' && argv[index + 1] === 'json');
}

export function parseGuardTestCoverageCliOptions(
  argv: readonly string[],
): GuardTestCoverageCliParseResult {
  if (argv.length === 1 && isHelpFlag(argv[0]!)) return { kind: 'help' };

  const fallback: GuardTestCoverageCliOptions = {
    semanticMode: 'shadow',
    format: requestedJson(argv) ? 'json' : 'text',
    verbose: false,
  };
  const parsed = parseClosedOptions(argv, {
    booleanOptions: ['--verbose', '--help', '-h'],
    valueOptions: ['--semantic-mode', '--format'],
  });
  if (parsed.error !== null) return { kind: 'error', code: parsed.error, options: fallback };
  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    return { kind: 'error', code: 'ci.input.option-value-invalid', options: fallback };
  }

  const semanticMode = parsed.values.get('--semantic-mode') ?? 'shadow';
  const format = parsed.values.get('--format') ?? 'text';
  if (
    (semanticMode !== 'shadow' && semanticMode !== 'enforce')
    || (format !== 'text' && format !== 'json')
  ) {
    return { kind: 'error', code: 'ci.input.option-value-invalid', options: fallback };
  }
  return {
    kind: 'options',
    options: {
      semanticMode,
      format,
      verbose: parsed.flags.has('--verbose'),
    },
  };
}

function textLines(
  report: GuardTestCoverageReportV1,
  result: GuardCoverageResult | null,
  verbose: boolean,
): string[] {
  const label = report.outcome === 'pass'
    ? 'PASS'
    : report.outcome === 'warn'
      ? 'WARN'
      : report.outcome === 'block'
        ? 'BLOCK'
        : 'INCONCLUSIVE';
  const lines = [
    `${label} ${report.controlId} ${report.code}`,
    `Counts: scanned=${report.counts.scanned} covered=${report.counts.covered} allowlisted=${report.counts.allowlisted} structural=${report.counts.structuralGaps} semantic=${report.counts.semanticGaps} mode=${report.semanticMode}`,
  ];
  const findingLimit = verbose ? report.findings.length : Math.min(report.findings.length, MAX_CONCISE_FINDINGS);
  for (const finding of report.findings.slice(0, findingLimit)) {
    lines.push(`  ${finding.decision.toUpperCase()} ${finding.code} ${finding.guard} -> ${finding.expectedTest}`);
  }
  if (report.findings.length > findingLimit) {
    lines.push(`  DETAILS-TRUNCATED ${report.findings.length - findingLimit} finding(s); re-run with --verbose or --format json`);
  }
  if (report.truncation.truncated) {
    lines.push(`  ${'test.guard-coverage.output-truncated'} omitted=${report.truncation.omittedFindings}`);
  }

  if (verbose && result !== null) {
    const covered = result.covered
      .map((guard) => safePath(guard, 'scripts'))
      .sort()
      .slice(0, MAX_GUARD_COVERAGE_VERBOSE_ITEMS);
    const allowlisted = result.allowlisted
      .map((entry) => safePath(entry.guard, 'scripts'))
      .sort()
      .slice(0, MAX_GUARD_COVERAGE_VERBOSE_ITEMS);
    for (const guard of covered) lines.push(`  COVERED ${guard}`);
    for (const guard of allowlisted) lines.push(`  ALLOWLISTED ${guard}`);
    const omittedInventory = Math.max(0, result.covered.length - covered.length)
      + Math.max(0, result.allowlisted.length - allowlisted.length);
    if (omittedInventory > 0) lines.push(`  INVENTORY-TRUNCATED omitted=${omittedInventory}`);
  }
  lines.push(`Reproduce: ${report.reproduce}`);
  return lines;
}

export function emitGuardTestCoverageReport(
  report: GuardTestCoverageReportV1,
  result: GuardCoverageResult | null,
  options: GuardTestCoverageCliOptions,
  output: GuardTestCoverageCliOutput,
): void {
  if (options.format === 'json') {
    const serialized = `${JSON.stringify(validateGuardTestCoverageReport(report))}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_GUARD_COVERAGE_REPORT_BYTES) {
      throw new GuardTestCoverageReportError('test.guard-coverage.report.byte-budget');
    }
    output.stdout(serialized);
    return;
  }
  const text = `${textLines(report, result, options.verbose).join('\n')}\n`;
  if (report.outcome === 'pass') output.stdout(text);
  else output.stderr(text);
}
