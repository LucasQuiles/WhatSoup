import { listStagedFiles, normalizeRepoPath, readStagedAddedLines } from './lib/guard-core.ts';

export interface DesignSystemHygieneIssue {
  code: string;
  filePath: string;
  message: string;
  required: string[];
}

interface GuardRule {
  code: string;
  description: string;
  required: string[];
  matches(filePath: string, staged: Set<string>, cwd: string): boolean;
}

interface ParsedArgs {
  help: boolean;
  json: boolean;
  staged: boolean;
}

const tokensSpec = 'docs/design-system/03-spec/tokens-v3.md';
const lintPlan = 'docs/design-system/04-enforcement/lint-plan.md';
const qaHardening = 'docs/design-system/06-implementation/qa-hardening.md';
const typographySpec = 'docs/design-system/03-spec/typography.md';
const fontProvenance = 'console/public/fonts/README.md';
const brandSpec = 'docs/design-system/03-spec/brand.md';
const iconographySpec = 'docs/design-system/03-spec/iconography.md';

const tokenFiles = new Set([
  'console/src/styles/tokens.primitive.css',
  'console/src/styles/tokens.semantic.css',
  'console/src/styles/tokens.component.css',
]);

const lintFiles = [
  /^console\/eslint\.config\.js$/,
  /^console\/eslint(?:\.config(?:\.shadow)?\.mjs|-rules\/.+\.mjs)$/,
  /^console\/scripts\/check-design-lint-fixtures\.mjs$/,
  /^tests\/console\/design-lints\.test\.tsx?$/,
  /^tests\/scripts\/design-lint-fixtures\.test\.ts$/,
];

const qaFiles = [
  /^console\/scripts\/capture-visual-matrix\.mjs$/,
  /^console\/scripts\/validate-visual-manifest\.mjs$/,
  /^console\/scripts\/check-brand-assets\.mjs$/,
  /^console\/scripts\/check-color-semantics\.mjs$/,
  /^console\/scripts\/check-contrast-matrix\.mjs$/,
  /^console\/scripts\/check-design-resilience\.mjs$/,
  /^console\/scripts\/check-font-assets\.mjs$/,
  /^console\/scripts\/check-token-spec-drift\.mjs$/,
  /^tests\/browser\/.+$/,
  /^vitest\.browser(?:\.motion)?\.config\.ts$/,
];

const fontFiles = [
  /^console\/src\/styles\/fonts\.css$/,
  /^console\/public\/fonts\/.+\.(?:woff2|ttf|otf)$/,
];

const brandAssetFiles = [
  /^console\/public\/favicon\.svg$/,
  /^console\/public\/manifest\.webmanifest$/,
  /^console\/public\/icons\/.+$/,
  /^console\/index\.html$/,
];

function pathMatches(filePath: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(filePath));
}

function packageDesignScriptChanged(filePath: string, cwd: string): boolean {
  if (filePath !== 'package.json' && filePath !== 'console/package.json') return false;
  const diff = readStagedAddedLines(cwd, filePath);
  return /^\+.*"(?:guard:design-system-hygiene|design:[^"]+)"/m.test(diff);
}

const rules: GuardRule[] = [
  {
    code: 'token-implementation-missing-spec',
    description: 'staged token implementation changes must update the token spec SSOT',
    required: [tokensSpec],
    matches: (filePath) => tokenFiles.has(filePath),
  },
  {
    code: 'lint-implementation-missing-plan',
    description: 'staged soup/design lint changes must update the enforcement plan SSOT',
    required: [lintPlan],
    matches: (filePath) => pathMatches(filePath, lintFiles),
  },
  {
    code: 'qa-harness-missing-docs',
    description: 'staged visual, contrast, color-semantics, browser, font, resilience, or token-drift harness changes must update QA hardening docs',
    required: [qaHardening],
    matches: (filePath) => pathMatches(filePath, qaFiles),
  },
  {
    code: 'font-implementation-missing-typography-spec',
    description: 'staged font implementation changes must update the typography spec SSOT',
    required: [typographySpec],
    matches: (filePath) => pathMatches(filePath, fontFiles),
  },
  {
    code: 'font-asset-missing-provenance',
    description: 'staged font asset changes must update the font provenance README',
    required: [fontProvenance],
    matches: (filePath) => pathMatches(filePath, fontFiles),
  },
  {
    code: 'brand-asset-missing-brand-spec',
    description: 'staged brand asset changes must update the brand spec SSOT',
    required: [brandSpec],
    matches: (filePath) => pathMatches(filePath, brandAssetFiles),
  },
  {
    code: 'brand-asset-missing-iconography-spec',
    description: 'staged brand asset changes must update the iconography spec SSOT',
    required: [iconographySpec],
    matches: (filePath) => pathMatches(filePath, brandAssetFiles),
  },
  {
    code: 'design-script-missing-docs',
    description: 'staged design/guard package scripts must update their tracked QA/enforcement docs',
    required: [qaHardening],
    matches: (filePath, _staged, cwd) => packageDesignScriptChanged(filePath, cwd),
  },
];

function hasRequiredDoc(staged: Set<string>, required: string[]): boolean {
  return required.some((filePath) => staged.has(filePath));
}

export function findDesignSystemHygieneIssues(cwd = process.cwd()): DesignSystemHygieneIssue[] {
  const stagedFiles = listStagedFiles(cwd, 'ACMR').map(normalizeRepoPath);
  const staged = new Set(stagedFiles);
  const issues: DesignSystemHygieneIssue[] = [];

  for (const filePath of stagedFiles) {
    for (const rule of rules) {
      if (!rule.matches(filePath, staged, cwd)) continue;
      if (hasRequiredDoc(staged, rule.required)) continue;
      issues.push({
        code: rule.code,
        filePath,
        message: rule.description,
        required: rule.required,
      });
    }
  }

  return issues;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { help: false, json: false, staged: true };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--staged') args.staged = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage(): string {
  return `Usage: npm run guard:design-system-hygiene -- [--staged] [--json]

Checks staged design-system implementation files for their tracked SSOT documentation companions.
This is a local/report-only promotion gate; it is not wired into verify:* yet.
`;
}

function printText(issues: DesignSystemHygieneIssue[]) {
  if (issues.length === 0) {
    console.log('design-system hygiene guard passed');
    return;
  }
  console.error(`design-system hygiene guard failed: ${issues.length} issue(s)`);
  for (const issue of issues) {
    console.error(
      `${issue.filePath}:1 ${issue.code}: ${issue.message}; stage one of: ${issue.required.join(', ')}`
    );
  }
}

export function runDesignSystemHygieneGuard(argv = process.argv.slice(2), cwd = process.cwd()): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`design-system hygiene guard: ${(err as Error).message}`);
    console.log(usage());
    return 2;
  }

  if (args.help) {
    console.log(usage());
    return 0;
  }

  const issues = findDesignSystemHygieneIssues(cwd);
  if (args.json) {
    console.log(JSON.stringify({ issues, issue_count: issues.length, schema_version: 1, verdict: issues.length === 0 ? 'PASS' : 'FAIL' }, null, 2));
  } else {
    printText(issues);
  }
  return issues.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runDesignSystemHygieneGuard();
}
