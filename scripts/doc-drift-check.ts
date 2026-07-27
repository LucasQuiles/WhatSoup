import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanGitEnv, normalizeRepoPath } from './lib/guard-core.ts';

export type DocDriftKind =
  | 'tool-count'
  | 'module-count'
  | 'migration-history'
  | 'raw-form-control-inventory'
  | 'brand-regression-lint-count'
  | 'soup-kitchen-label-count'
  | 'test-file-test-count'
  | 'theme-parity-token-count'
  | 'shadow-baseline-total'
  | 'design-regression-check-count'
  | 'design-regression-blocking-check-count'
  | 'design-regression-blocking-check'
  | 'design-burndown-total'
  | 'design-burndown-blocking-count'
  | 'design-guard-test-file-count'
  | 'design-guard-test-count';

export interface DocDriftIssue {
  filePath: string;
  line: number;
  kind: DocDriftKind;
  claimed: number;
  actual: number;
  text: string;
  expected?: string;
}

export interface DocDriftOptions {
  cwd?: string;
  docPaths?: string[];
}

interface ToolRegistration {
  filePath: string;
  line: number;
  name: string;
}

interface ModuleImport {
  filePath: string;
  line: number;
  modulePath: string;
}

export interface RawFormControlInventory {
  total: number;
  consumerMigrations: number;
  primitiveSelfHits: number;
  input: number;
  select: number;
  textarea: number;
}

export interface ShadowBaselineInventory {
  total: number;
  byRule: Record<string, number>;
}

export interface DesignGuardTestInventory {
  fileCount: number;
  testCount: number;
}

export interface DesignBurndownSummary {
  total: number;
  blocking: number;
}

interface PackageJsonWithScripts {
  scripts?: Record<string, unknown>;
}

const defaultDocPaths = [
  'CLAUDE.md',
  'README.md',
  'docs/tools.md',
  'docs/configuration.md',
  'docs/design-system/04-enforcement/lint-plan.md',
  'docs/design-system/05-cutover/push-gate-readiness.md',
  'docs/design-system/06-implementation/qa-hardening.md',
  'docs/design-system/06-implementation/conformance-manifest.md',
];

const claimContextPattern = /\b(?:MCP|Tool registry|tool API reference|MCP Tool Reference|docs\/tools\.md|register imports?)\b/i;
const toolClaimPattern = /\b(\d+)\s+(?:MCP\s+)?tools?\b(?!\s+modules?\b)/gi;
const moduleClaimPatterns = [
  /\b(\d+)\s+(?:tool\s+)?modules?\b/gi,
  /\b(\d+)\s+register imports?\b/gi,
];
const toolsTableHeaderPattern = /^\|\s*Module\s*\|\s*Tools\s*\|/;
const toolsTableModuleRowPattern = /^\|\s*\[([^|\]]+\.ts)\]\([^)]*\)\s*\|\s*(\d+)\s*\|/;
const toolsTableTotalRowPattern = /^\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/;
const migrationHistoryHeaderPattern = /^## Database Migration History\s*$/;
const migrationHistoryRowPattern = /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/;
const migrationRequiredFragments = new Map<number, string[]>([
  [1, ['`messages`', '`contacts`', '`access_list`', '`agent_sessions`', '`rate_limits`', '`enrichment_runs`']],
  [2, ['`inbound_events`', '`outbound_ops`', '`tool_calls`', '`session_checkpoints`', '`recovery_runs`']],
]);

const currentRawFormContextPattern =
  /\bcurrent\b.*\b(?:raw[ -]form-control|soup\/no-raw-form-control|generated manifest|enforced inventory)\b/i;
const rawFormTotalPattern =
  /\b(\d+)\s+total(?: findings)?\b.*?\b(\d+)\s+consumer(?:-migration| migrations?)\b.*?\b(\d+)\s+primitive\s+self-?hits?\b/i;
const rawFormConsumerHitsPattern =
  /\bmanifest\s+is\s+exactly\s+(\d+)\s+consumer\s+hits?\b/i;
const rawFormElementSplitPattern =
  /\belement split of\s+(\d+)\s+inputs?,\s+(\d+)\s+selects?,\s+and\s+(\d+)\s+textareas?\b/i;
const currentDesignEnforcementDocPattern =
  /(?:^|\/)docs\/design-system\/06-implementation\/conformance-manifest\.md$|(?:^|\/)conformance-manifest\.md$/;
const currentDesignEnforcementContextPattern =
  /\b(?:current|live)\b.*\b(?:design[- ]enforcement|shadow baseline|shadow ratchet|design-regression)\b/i;
const brandRegressionLintCountPattern =
  /\bbrand-regression lint\s*\(\s*(\d+)\s+hits?\b/i;
const soupKitchenLabelCountPattern =
  /["“]?Soup Kitchen["”]?\s*[×x]\s*(\d+)\s+counter\b/i;
const nonBrowserTestFileCountPattern =
  /`(tests\/(?!browser\/)[^`]+?\.(?:test|spec)\.[cm]?[tj]sx?)`\s*\(\s*(\d+)\s+tests?\b/gi;
const shadowBaselineTotalPattern =
  /\blint-shadow-baseline\.json\b[^\n]*?(?:—|=|:|\bis\b|\btotal\b|\bceiling\b)\s*(\d+)\b/i;
const themeParityTokenCountPattern =
  /\b(?:theme parity|check-theme-parity\.mjs)\b[^\n]*?\b(\d+)\s*(?:tokens?\b)?/i;
const designRegressionCheckCountPattern =
  /\bdesign-regression\b[^\n]*?\b(\d+)\s+checks?\b/i;
const designRegressionNamedBlockingSetPattern =
  /\ball\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+blocking\s+design-regression\s+checks?\s*\(([^)]*)\)/i;
const designRegressionBlockingSetPattern =
  /\bdesign-regression\b[^\n]*?\bblocking set\s+`([^`]+)`/i;
const designRegressionExitOnFailPattern =
  /\bEXIT_ON_FAIL=\(([^)]*)\)/i;
const designBurndownSummaryPattern =
  /\bburndown\b[^\n]*?\b(\d+)\s+total\s*\/\s*(\d+)\s+blocking\b/i;
const designGuardTestInventoryPattern =
  /\btest:design-guards\b[^\n]*?\b(\d+)\s+files?\s*\/\s*(\d+)\s+tests?\b/i;
const designGuardTestFilePattern = /^tests\/.+\.(?:test|spec)\.[cm]?[tj]sx?$/;

function lineForOffset(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function displayPath(cwd: string, requestedPath: string): string {
  return path.isAbsolute(requestedPath)
    ? requestedPath
    : normalizeRepoPath(path.relative(cwd, path.resolve(cwd, requestedPath)));
}

function existingDefaultDocs(cwd: string): string[] {
  return defaultDocPaths.filter((docPath) => existsSync(path.resolve(cwd, docPath)));
}

export function findToolRegistrations(cwd: string = process.cwd()): ToolRegistration[] {
  const toolsDir = path.resolve(cwd, 'src/mcp/tools');
  const registrations: ToolRegistration[] = [];
  const toolNamePattern = /^\s*name:\s*['"]([a-z][a-z0-9_]*)['"]/gm;

  for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const absolutePath = path.join(toolsDir, entry.name);
    const filePath = normalizeRepoPath(path.relative(cwd, absolutePath));
    const text = readFileSync(absolutePath, 'utf8');

    for (const match of text.matchAll(toolNamePattern)) {
      const name = match[1];
      if (!name) continue;
      registrations.push({
        filePath,
        line: lineForOffset(text, match.index ?? 0),
        name,
      });
    }
  }

  // Inline tool registrations live outside src/mcp/tools/. They are gated on
  // runtime configuration (e.g. control-plane peers) and call
  // `this.registry.register({ ... })` directly from a runtime module. The
  // canonical tool surface — the count documented in docs/tools.md and
  // docs/public-surface.md — includes these, so doc-drift must count them too.
  // Inline registrations are listed here explicitly to keep this scan
  // file-anchored rather than AST-derived.
  const inlineRegistrationSources: ReadonlyArray<{ relativePath: string; toolName: string }> = [
    // emit_heal_result's declaration lives in runtime-tool-registrations.ts
    // (buildEmitHealResultTool); AgentRuntime.start() wires it via
    // registerRuntimeInlineTools. Anchor the scan at the declaration file (where
    // the `name:` field is) so the canonical count stays correct after #1977.
    { relativePath: 'src/runtimes/agent/runtime-tool-registrations.ts', toolName: 'emit_heal_result' },
  ];

  const inlineRegistrationPattern = (toolName: string) =>
    new RegExp(`^\\s*name:\\s*['"]${toolName}['"]`, 'm');

  for (const { relativePath, toolName } of inlineRegistrationSources) {
    const absolutePath = path.resolve(cwd, relativePath);
    if (!existsSync(absolutePath)) continue;
    const text = readFileSync(absolutePath, 'utf8');
    const match = text.match(inlineRegistrationPattern(toolName));
    if (!match || match.index === undefined) continue;
    registrations.push({
      filePath: normalizeRepoPath(relativePath),
      line: lineForOffset(text, match.index),
      name: toolName,
    });
  }

  return registrations.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line);
}

export function findRegisterModuleImports(cwd: string = process.cwd()): ModuleImport[] {
  const registerAllPath = path.resolve(cwd, 'src/mcp/register-all.ts');
  const text = readFileSync(registerAllPath, 'utf8');
  const filePath = normalizeRepoPath(path.relative(cwd, registerAllPath));
  const imports: ModuleImport[] = [];
  // Accept both named and namespace imports of ./tools/*.ts modules. Namespace
  // imports (`import * as foo from './tools/x.ts'`) are required for some test
  // surfaces (vi.spyOn on the module binding) so the canonical-module-count
  // count must include them.
  const namedImportPattern = /^import\s+\{[^}]*\}\s+from\s+['"](\.\/tools\/[^'"]+\.ts)['"];?$/gm;
  const namespaceImportPattern = /^import\s+\*\s+as\s+\w+\s+from\s+['"](\.\/tools\/[^'"]+\.ts)['"];?$/gm;
  const seen = new Set<string>();

  // Module count is derived from register-all.ts imports because that file is
  // the canonical runtime wiring point for tool modules, including conditional
  // modules such as knowledge search.
  for (const pattern of [namedImportPattern, namespaceImportPattern]) {
    for (const match of text.matchAll(pattern)) {
      const modulePath = match[1];
      if (!modulePath || seen.has(modulePath)) continue;
      seen.add(modulePath);
      imports.push({
        filePath,
        line: lineForOffset(text, match.index ?? 0),
        modulePath,
      });
    }
  }

  return imports;
}

function findMigrationRegistryVersions(cwd: string): number[] {
  const databasePath = path.resolve(cwd, 'src/core/database.ts');
  const text = readFileSync(databasePath, 'utf8');
  const versions = [...text.matchAll(/^\s*\[(\d+),/gm)]
    .map((match) => Number(match[1]))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  return versions;
}

export function findRawFormControlInventory(cwd: string = process.cwd()): RawFormControlInventory {
  const inventoryPath = path.resolve(cwd, 'console/design-raw-form-control-inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
    totals?: {
      total?: number;
      by_classification?: Record<string, number>;
      by_element?: Record<string, number>;
    };
  };
  const totals = inventory.totals ?? {};
  const byClassification = totals.by_classification ?? {};
  const byElement = totals.by_element ?? {};

  return {
    total: totals.total ?? 0,
    consumerMigrations: byClassification.consumer_migration ?? 0,
    primitiveSelfHits: byClassification.exemption_movement ?? 0,
    input: byElement.input ?? 0,
    select: byElement.select ?? 0,
    textarea: byElement.textarea ?? 0,
  };
}

export function findShadowBaselineInventory(cwd: string = process.cwd()): ShadowBaselineInventory {
  const baselinePath = path.resolve(cwd, 'console/lint-shadow-baseline.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { total?: unknown; rules?: unknown };
  if (typeof baseline.total !== 'number' || !Number.isFinite(baseline.total)) {
    throw new Error('ERROR(schema:lint-shadow-baseline.json): missing numeric total');
  }
  if (typeof baseline.rules !== 'object' || baseline.rules === null || Array.isArray(baseline.rules)) {
    throw new Error('ERROR(schema:lint-shadow-baseline.json): missing rules object');
  }

  const byRule: Record<string, number> = {};
  for (const [key, count] of Object.entries(baseline.rules)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      throw new Error(`ERROR(schema:lint-shadow-baseline.json): non-numeric count for key "${key}"`);
    }
    const separatorIndex = key.indexOf(' :: ');
    if (separatorIndex === -1) {
      throw new Error(`ERROR(schema:lint-shadow-baseline.json): key missing " :: " separator: "${key}"`);
    }
    const rule = key.slice(0, separatorIndex);
    byRule[rule] = (byRule[rule] ?? 0) + count;
  }

  return { total: baseline.total, byRule };
}

function walkRepoFiles(dir: string, extensions: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRepoFiles(absolutePath, extensions, out);
    } else if (entry.isFile() && extensions.test(entry.name)) {
      out.push(absolutePath);
    }
  }
  return out;
}

export function findSoupKitchenLabelCount(cwd: string = process.cwd()): number {
  const files = walkRepoFiles(path.resolve(cwd, 'console/src'), /\.(?:ts|tsx|js|jsx)$/);
  const consoleGuidePath = path.resolve(cwd, 'docs/console-guide.md');
  if (existsSync(consoleGuidePath)) files.push(consoleGuidePath);

  return files.reduce((total, filePath) => {
    const text = readFileSync(filePath, 'utf8');
    return total + [...text.matchAll(/Soup Kitchen/g)].length;
  }, 0);
}

export function findDesignRegressionCheckCount(cwd: string = process.cwd()): number {
  const scriptPath = path.resolve(cwd, 'console/scripts/design-regression.sh');
  const text = readFileSync(scriptPath, 'utf8');
  const checks = [...text.matchAll(/^# Check\s+(\d+):/gm)]
    .map((match) => Number(match[1]))
    .filter(Number.isInteger);
  if (checks.length === 0) {
    throw new Error('ERROR(schema:design-regression.sh): no check headers found');
  }
  const uniqueChecks = new Set(checks);
  const maxCheck = Math.max(...uniqueChecks);
  if (uniqueChecks.size !== maxCheck) {
    throw new Error('ERROR(schema:design-regression.sh): check headers are not contiguous');
  }
  return uniqueChecks.size;
}

function integerSetFromText(text: string, label: string): number[] {
  const values = [...text.matchAll(/\b\d+\b/g)]
    .map((match) => Number(match[0]))
    .filter(Number.isInteger);
  if (values.length === 0) {
    throw new Error(`ERROR(schema:${label}): no numeric checks found`);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function integerFromWordOrDigits(text: string, label: string): number {
  const digitValue = Number(text);
  if (Number.isInteger(digitValue)) return digitValue;
  const wordValues: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  const wordValue = wordValues[text.toLowerCase()];
  if (wordValue) return wordValue;
  throw new Error(`ERROR(schema:${label}): unsupported numeric word "${text}"`);
}

export function findDesignRegressionBlockingChecks(cwd: string = process.cwd()): number[] {
  const scriptPath = path.resolve(cwd, 'console/scripts/design-regression.sh');
  const text = readFileSync(scriptPath, 'utf8');
  const match = text.match(/^EXIT_ON_FAIL=\(([^)]*)\)/m);
  if (!match?.[1]) {
    throw new Error('ERROR(schema:design-regression.sh): missing EXIT_ON_FAIL set');
  }
  return integerSetFromText(match[1], 'design-regression.sh EXIT_ON_FAIL');
}

function scopeTokens(css: string, scopeMatcher: (selector: string) => boolean): Set<string> {
  const tokens = new Set<string>();
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(blockPattern)) {
    const selector = match[1]?.trim() ?? '';
    const body = match[2] ?? '';
    if (!scopeMatcher(selector)) continue;
    for (const tokenMatch of body.matchAll(/--([a-z0-9-]+)\s*:/g)) {
      const token = tokenMatch[1];
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

export function findThemeParityTokenCount(cwd: string = process.cwd()): number {
  const tokensPath = path.resolve(cwd, 'console/src/styles/tokens.semantic.css');
  const css = readFileSync(tokensPath, 'utf8');
  const dark = scopeTokens(css, (selector) => selector.includes('[data-theme="dark"]'));
  const light = scopeTokens(css, (selector) => selector.includes('[data-theme="light"]'));
  const missingInLight = [...dark].filter((token) => !light.has(token));
  const missingInDark = [...light].filter((token) => !dark.has(token));
  if (missingInLight.length > 0 || missingInDark.length > 0) {
    throw new Error('ERROR(schema:tokens.semantic.css): theme parity token sets differ');
  }
  return dark.size;
}

export function findDesignBurndownSummary(cwd: string = process.cwd()): DesignBurndownSummary {
  const queuePath = path.resolve(cwd, 'console/design-burndown-queue.json');
  const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as {
    summary?: {
      total?: unknown;
      blocking?: unknown;
    };
  };
  const total = queue.summary?.total;
  const blocking = queue.summary?.blocking;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    throw new Error('ERROR(schema:design-burndown-queue.json): missing numeric summary.total');
  }
  if (typeof blocking !== 'number' || !Number.isFinite(blocking)) {
    throw new Error('ERROR(schema:design-burndown-queue.json): missing numeric summary.blocking');
  }
  return { total, blocking };
}

function findDesignGuardVitestArgs(cwd: string): { testFiles: string[]; vitestArgs: string[] } {
  const packagePath = path.resolve(cwd, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageJsonWithScripts;
  const script = packageJson.scripts?.['test:design-guards'];
  if (typeof script !== 'string' || script.trim() === '') {
    throw new Error('ERROR(schema:package.json): missing scripts.test:design-guards');
  }

  const tokens = script.split(/\s+/).filter(Boolean);
  const separatorIndex = tokens.indexOf('--');
  const vitestArgs = separatorIndex >= 0
    ? tokens.slice(separatorIndex + 1)
    : tokens.filter((token) => designGuardTestFilePattern.test(token) || token.startsWith('--'));
  const testFiles = vitestArgs.filter((token) => designGuardTestFilePattern.test(token));
  if (testFiles.length === 0) {
    throw new Error('ERROR(schema:test:design-guards): no test files found in package.json script');
  }
  if (new Set(testFiles).size !== testFiles.length) {
    throw new Error('ERROR(schema:test:design-guards): duplicate test files in package.json script');
  }
  for (const testFile of testFiles) {
    if (!existsSync(path.resolve(cwd, testFile))) {
      throw new Error(`ERROR(schema:test:design-guards): missing test file ${testFile}`);
    }
  }

  return { testFiles, vitestArgs };
}

function parseVitestListJson(stdout: string): unknown[] {
  const jsonStart = stdout.indexOf('[');
  const jsonEnd = stdout.lastIndexOf(']');
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error('ERROR(schema:test:design-guards): vitest list did not emit JSON');
  }

  const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('ERROR(schema:test:design-guards): vitest list JSON is not an array');
  }
  return parsed;
}

function vitestListEntryFile(entry: unknown): string {
  if (
    typeof entry !== 'object'
    || entry === null
    || typeof (entry as { file?: unknown }).file !== 'string'
    || typeof (entry as { name?: unknown }).name !== 'string'
  ) {
    throw new Error('ERROR(schema:test:design-guards): vitest list entry is malformed');
  }
  return (entry as { file: string }).file;
}

function listVitestTests(cwd: string, vitestArgs: string[]): unknown[] {
  const vitestPath = path.resolve(cwd, 'node_modules/.bin/vitest');
  if (!existsSync(vitestPath)) {
    throw new Error('ERROR(schema:vitest-list): missing local Vitest binary');
  }

  const result = spawnSync(vitestPath, ['list', ...vitestArgs, '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), CI: 'true' },
  });
  if (result.error) {
    throw new Error(`ERROR(schema:vitest-list): vitest list failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
    throw new Error(`ERROR(schema:vitest-list): vitest list exited ${result.status}: ${output}`);
  }

  return parseVitestListJson(result.stdout);
}

export function findTestFileTestCount(cwd: string = process.cwd(), testFile: string): number {
  if (!designGuardTestFilePattern.test(testFile) || testFile.startsWith('tests/browser/')) {
    throw new Error(`ERROR(schema:test-file-count): unsupported test file ${testFile}`);
  }
  if (!existsSync(path.resolve(cwd, testFile))) {
    throw new Error(`ERROR(schema:test-file-count): missing test file ${testFile}`);
  }

  const entries = listVitestTests(cwd, [testFile, '--pool=forks']);
  const expectedFile = normalizeRepoPath(testFile);
  const count = entries.reduce<number>((total, entry) => {
    const entryFile = vitestListEntryFile(entry);
    const absoluteFile = path.isAbsolute(entryFile) ? entryFile : path.resolve(cwd, entryFile);
    return normalizeRepoPath(path.relative(cwd, absoluteFile)) === expectedFile ? total + 1 : total;
  }, 0);
  if (count === 0) {
    throw new Error(`ERROR(schema:test-file-count): Vitest collected no tests for ${testFile}`);
  }
  return count;
}

export function findDesignGuardTestInventory(cwd: string = process.cwd()): DesignGuardTestInventory {
  const { testFiles, vitestArgs } = findDesignGuardVitestArgs(cwd);
  const entries = listVitestTests(cwd, vitestArgs);
  const collectedFiles = new Set<string>();
  for (const entry of entries) {
    const entryFile = vitestListEntryFile(entry);
    const absoluteFile = path.isAbsolute(entryFile) ? entryFile : path.resolve(cwd, entryFile);
    collectedFiles.add(normalizeRepoPath(path.relative(cwd, absoluteFile)));
  }

  const expectedFiles = new Set(testFiles.map((testFile) => normalizeRepoPath(testFile)));
  if (collectedFiles.size !== expectedFiles.size || [...expectedFiles].some((testFile) => !collectedFiles.has(testFile))) {
    throw new Error('ERROR(schema:test:design-guards): vitest list collected a different file set than package.json');
  }

  return {
    fileCount: testFiles.length,
    testCount: entries.length,
  };
}

function checkMigrationHistoryTable(
  filePath: string,
  lines: string[],
  expectedVersions: number[],
): DocDriftIssue[] {
  const headerIndex = lines.findIndex((line) => migrationHistoryHeaderPattern.test(line));
  if (headerIndex < 0) return [];

  const issues: DocDriftIssue[] = [];
  const rows = new Map<number, { line: number; text: string }>();

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const lineText = lines[index] ?? '';
    if (index > headerIndex + 1 && lineText.startsWith('## ')) break;

    const row = lineText.match(migrationHistoryRowPattern);
    if (!row) continue;

    const version = Number(row[1]);
    if (!Number.isInteger(version)) continue;
    rows.set(version, { line: index + 1, text: lineText });
  }

  const expectedSet = new Set(expectedVersions);
  const actualVersions = [...rows.keys()].sort((left, right) => left - right);

  for (const expectedVersion of expectedVersions) {
    if (!rows.has(expectedVersion)) {
      issues.push({
        filePath,
        line: headerIndex + 1,
        kind: 'migration-history',
        claimed: 0,
        actual: expectedVersion,
        text: lines[headerIndex] ?? '',
        expected: `migration history row for version ${expectedVersion}`,
      });
    }
  }

  for (const actualVersion of actualVersions) {
    if (!expectedSet.has(actualVersion)) {
      const row = rows.get(actualVersion);
      issues.push({
        filePath,
        line: row?.line ?? headerIndex + 1,
        kind: 'migration-history',
        claimed: actualVersion,
        actual: 0,
        text: row?.text ?? '',
        expected: 'no row for an unregistered migration version',
      });
    }
  }

  for (const [version, requiredFragments] of migrationRequiredFragments) {
    const row = rows.get(version);
    if (!row) continue;
    for (const fragment of requiredFragments) {
      if (!row.text.includes(fragment)) {
        issues.push({
          filePath,
          line: row.line,
          kind: 'migration-history',
          claimed: version,
          actual: version,
          text: row.text,
          expected: `migration ${version} row to mention ${fragment}`,
        });
      }
    }
  }

  return issues;
}

function addCountIssue(
  issues: DocDriftIssue[],
  filePath: string,
  line: number,
  claimed: number,
  actual: number,
  text: string,
  expected: string,
): void {
  if (claimed === actual) return;

  issues.push({
    filePath,
    line,
    kind: 'raw-form-control-inventory',
    claimed,
    actual,
    text,
    expected,
  });
}

function addTypedCountIssue(
  issues: DocDriftIssue[],
  kind: DocDriftKind,
  filePath: string,
  line: number,
  claimed: number,
  actual: number,
  text: string,
  expected: string,
): void {
  if (claimed === actual) return;

  issues.push({
    filePath,
    line,
    kind,
    claimed,
    actual,
    text,
    expected,
  });
}

function checkRawFormControlInventoryClaims(
  filePath: string,
  lines: string[],
  actual: RawFormControlInventory,
): DocDriftIssue[] {
  const issues: DocDriftIssue[] = [];

  lines.forEach((lineText, index) => {
    const span = `${lineText} ${lines[index + 1] ?? ''}`.replace(/\s+/g, ' ').trim();
    if (!currentRawFormContextPattern.test(lineText)) return;

    const line = index + 1;
    const totalMatch = span.match(rawFormTotalPattern);
    if (totalMatch) {
      addCountIssue(
        issues,
        filePath,
        line,
        Number(totalMatch[1]),
        actual.total,
        span,
        'raw form-control total from console/design-raw-form-control-inventory.json',
      );
      addCountIssue(
        issues,
        filePath,
        line,
        Number(totalMatch[2]),
        actual.consumerMigrations,
        span,
        'raw form-control consumer migrations from console/design-raw-form-control-inventory.json',
      );
      addCountIssue(
        issues,
        filePath,
        line,
        Number(totalMatch[3]),
        actual.primitiveSelfHits,
        span,
        'raw form-control primitive self-hits from console/design-raw-form-control-inventory.json',
      );
    }

    const consumerHitsMatch = span.match(rawFormConsumerHitsPattern);
    if (consumerHitsMatch) {
      addCountIssue(
        issues,
        filePath,
        line,
        Number(consumerHitsMatch[1]),
        actual.consumerMigrations,
        span,
        'raw form-control consumer migrations from console/design-raw-form-control-inventory.json',
      );
    }

    const elementSplitMatch = span.match(rawFormElementSplitPattern);
    if (elementSplitMatch) {
      addCountIssue(
        issues,
        filePath,
        line,
        Number(elementSplitMatch[1]),
        actual.input,
        span,
        'raw form-control input count from console/design-raw-form-control-inventory.json',
      );
      addCountIssue(
        issues,
        filePath,
        line,
        Number(elementSplitMatch[2]),
        actual.select,
        span,
        'raw form-control select count from console/design-raw-form-control-inventory.json',
      );
      addCountIssue(
        issues,
        filePath,
        line,
        Number(elementSplitMatch[3]),
        actual.textarea,
        span,
        'raw form-control textarea count from console/design-raw-form-control-inventory.json',
      );
    }
  });

  return issues;
}

function checkTestFileCountClaims(
  cwd: string,
  filePath: string,
  lines: string[],
  testFileCountCache: Map<string, number>,
): DocDriftIssue[] {
  const issues: DocDriftIssue[] = [];

  lines.forEach((lineText, index) => {
    for (const match of lineText.matchAll(nonBrowserTestFileCountPattern)) {
      const testFile = match[1];
      if (!testFile) continue;
      const claimed = Number(match[2]);
      const actual = testFileCountCache.get(testFile) ?? findTestFileTestCount(cwd, testFile);
      testFileCountCache.set(testFile, actual);
      addTypedCountIssue(
        issues,
        'test-file-test-count',
        filePath,
        index + 1,
        claimed,
        actual,
        lineText,
        `Vitest collected test count for ${testFile}`,
      );
    }
  });

  return issues;
}

function isCurrentDesignEnforcementClaim(filePath: string, lineText: string): boolean {
  return currentDesignEnforcementDocPattern.test(filePath)
    || currentDesignEnforcementContextPattern.test(lineText);
}

function wrappedDesignClaim(lines: string[], index: number): string {
  const lineText = lines[index] ?? '';
  if (!/\b(?:design-regression|EXIT_ON_FAIL)\b/i.test(lineText)) return lineText;
  return [lineText, lines[index + 1] ?? '', lines[index + 2] ?? '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addDesignRegressionBlockingSetIssues(
  issues: DocDriftIssue[],
  filePath: string,
  line: number,
  claimed: number[],
  actual: number[],
  lineText: string,
): void {
  const claimedSet = new Set(claimed);
  const actualSet = new Set(actual);
  for (const actualCheck of actual) {
    if (claimedSet.has(actualCheck)) continue;
    issues.push({
      filePath,
      line,
      kind: 'design-regression-blocking-check',
      claimed: 0,
      actual: actualCheck,
      text: lineText,
      expected: 'design-regression blocking check from console/scripts/design-regression.sh EXIT_ON_FAIL',
    });
  }
  for (const claimedCheck of claimed) {
    if (actualSet.has(claimedCheck)) continue;
    issues.push({
      filePath,
      line,
      kind: 'design-regression-blocking-check',
      claimed: claimedCheck,
      actual: 0,
      text: lineText,
      expected: 'no undocumented design-regression blocking check',
    });
  }
}

function checkDesignEnforcementClaims(
  filePath: string,
  lines: string[],
  soupKitchenLabelCount: number,
  themeParityTokenCount: number,
  shadowBaseline: ShadowBaselineInventory,
  designRegressionCheckCount: number,
  designRegressionBlockingChecks: number[],
  designBurndownSummary: DesignBurndownSummary,
  designGuardTestInventory: DesignGuardTestInventory,
): DocDriftIssue[] {
  const issues: DocDriftIssue[] = [];

  lines.forEach((_, index) => {
    const claimText = wrappedDesignClaim(lines, index);
    if (!isCurrentDesignEnforcementClaim(filePath, claimText)) return;

    const line = index + 1;
    const brandRegressionMatch = claimText.match(brandRegressionLintCountPattern);
    if (brandRegressionMatch) {
      addTypedCountIssue(
        issues,
        'brand-regression-lint-count',
        filePath,
        line,
        Number(brandRegressionMatch[1]),
        shadowBaseline.byRule['soup/no-brand-regression'] ?? 0,
        claimText,
        'soup/no-brand-regression count from console/lint-shadow-baseline.json',
      );
    }

    const soupKitchenMatch = claimText.match(soupKitchenLabelCountPattern);
    if (soupKitchenMatch) {
      addTypedCountIssue(
        issues,
        'soup-kitchen-label-count',
        filePath,
        line,
        Number(soupKitchenMatch[1]),
        soupKitchenLabelCount,
        claimText,
        'Soup Kitchen label count from console/src and docs/console-guide.md',
      );
    }

    const themeParityMatch = claimText.match(themeParityTokenCountPattern);
    if (themeParityMatch) {
      addTypedCountIssue(
        issues,
        'theme-parity-token-count',
        filePath,
        line,
        Number(themeParityMatch[1]),
        themeParityTokenCount,
        claimText,
        'theme parity token count from console/src/styles/tokens.semantic.css',
      );
    }

    const shadowBaselineMatch = claimText.match(shadowBaselineTotalPattern);
    if (shadowBaselineMatch) {
      addTypedCountIssue(
        issues,
        'shadow-baseline-total',
        filePath,
        line,
        Number(shadowBaselineMatch[1]),
        shadowBaseline.total,
        claimText,
        'shadow lint total from console/lint-shadow-baseline.json',
      );
    }

    const designRegressionMatch = claimText.match(designRegressionCheckCountPattern);
    if (designRegressionMatch) {
      addTypedCountIssue(
        issues,
        'design-regression-check-count',
        filePath,
        line,
        Number(designRegressionMatch[1]),
        designRegressionCheckCount,
        claimText,
        'design-regression check count from console/scripts/design-regression.sh',
      );
    }

    const namedBlockingSetMatch = claimText.match(designRegressionNamedBlockingSetPattern);
    if (namedBlockingSetMatch) {
      const claimedCount = integerFromWordOrDigits(
        namedBlockingSetMatch[1] ?? '',
        `${filePath}:${line} design-regression blocking check count`,
      );
      addTypedCountIssue(
        issues,
        'design-regression-blocking-check-count',
        filePath,
        line,
        claimedCount,
        designRegressionBlockingChecks.length,
        claimText,
        'design-regression blocking check count from console/scripts/design-regression.sh EXIT_ON_FAIL',
      );
      const claimed = integerSetFromText(
        namedBlockingSetMatch[2] ?? '',
        `${filePath}:${line} design-regression named blocking set`,
      );
      addDesignRegressionBlockingSetIssues(
        issues,
        filePath,
        line,
        claimed,
        designRegressionBlockingChecks,
        claimText,
      );
    }

    const designRegressionBlockingSetMatch = claimText.match(designRegressionBlockingSetPattern);
    const designRegressionExitOnFailMatch = claimText.match(designRegressionExitOnFailPattern);
    const designRegressionBlockingSetText =
      designRegressionBlockingSetMatch?.[1] ?? designRegressionExitOnFailMatch?.[1];
    if (designRegressionBlockingSetText) {
      const claimed = integerSetFromText(
        designRegressionBlockingSetText,
        `${filePath}:${line} design-regression blocking set`,
      );
      addDesignRegressionBlockingSetIssues(
        issues,
        filePath,
        line,
        claimed,
        designRegressionBlockingChecks,
        claimText,
      );
    }

    const designBurndownMatch = claimText.match(designBurndownSummaryPattern);
    if (designBurndownMatch) {
      addTypedCountIssue(
        issues,
        'design-burndown-total',
        filePath,
        line,
        Number(designBurndownMatch[1]),
        designBurndownSummary.total,
        claimText,
        'design burndown total from console/design-burndown-queue.json',
      );
      addTypedCountIssue(
        issues,
        'design-burndown-blocking-count',
        filePath,
        line,
        Number(designBurndownMatch[2]),
        designBurndownSummary.blocking,
        claimText,
        'design burndown blocking count from console/design-burndown-queue.json',
      );
    }

    const designGuardTestMatch = claimText.match(designGuardTestInventoryPattern);
    if (designGuardTestMatch) {
      addTypedCountIssue(
        issues,
        'design-guard-test-file-count',
        filePath,
        line,
        Number(designGuardTestMatch[1]),
        designGuardTestInventory.fileCount,
        claimText,
        'test:design-guards file count from package.json',
      );
      addTypedCountIssue(
        issues,
        'design-guard-test-count',
        filePath,
        line,
        Number(designGuardTestMatch[2]),
        designGuardTestInventory.testCount,
        claimText,
        'test:design-guards test count from Vitest list',
      );
    }
  });

  return issues;
}

export function findDocDrift(options: DocDriftOptions = {}): DocDriftIssue[] {
  const cwd = options.cwd ?? process.cwd();
  const docPaths = options.docPaths ?? existingDefaultDocs(cwd);
  const registrations = findToolRegistrations(cwd);
  const toolCount = registrations.length;
  const moduleCount = findRegisterModuleImports(cwd).length;
  const migrationVersions = findMigrationRegistryVersions(cwd);
  const rawFormControlInventory = findRawFormControlInventory(cwd);
  const soupKitchenLabelCount = findSoupKitchenLabelCount(cwd);
  const themeParityTokenCount = findThemeParityTokenCount(cwd);
  const shadowBaselineInventory = findShadowBaselineInventory(cwd);
  const designRegressionCheckCount = findDesignRegressionCheckCount(cwd);
  const designRegressionBlockingChecks = findDesignRegressionBlockingChecks(cwd);
  const designBurndownSummary = findDesignBurndownSummary(cwd);
  const designGuardTestInventory = findDesignGuardTestInventory(cwd);
  const testFileCountCache = new Map<string, number>();
  const toolCountsByModule = new Map<string, number>();
  for (const registration of registrations) {
    const moduleName = path.basename(registration.filePath);
    toolCountsByModule.set(moduleName, (toolCountsByModule.get(moduleName) ?? 0) + 1);
  }
  const issues: DocDriftIssue[] = [];

  for (const docPath of docPaths) {
    const absolutePath = path.isAbsolute(docPath) ? docPath : path.resolve(cwd, docPath);
    const filePath = displayPath(cwd, docPath);
    const text = readFileSync(absolutePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const toolsTableHeaderIndex = lines.findIndex((line) => toolsTableHeaderPattern.test(line));
    const toolsTableModules = new Set<string>();

    issues.push(...checkMigrationHistoryTable(filePath, lines, migrationVersions));
    issues.push(...checkRawFormControlInventoryClaims(filePath, lines, rawFormControlInventory));
    issues.push(...checkTestFileCountClaims(cwd, filePath, lines, testFileCountCache));
    issues.push(...checkDesignEnforcementClaims(
      filePath,
      lines,
      soupKitchenLabelCount,
      themeParityTokenCount,
      shadowBaselineInventory,
      designRegressionCheckCount,
      designRegressionBlockingChecks,
      designBurndownSummary,
      designGuardTestInventory,
    ));

    lines.forEach((lineText, index) => {
      if (claimContextPattern.test(lineText)) {
        for (const match of lineText.matchAll(toolClaimPattern)) {
          const claimed = Number(match[1]);
          if (claimed !== toolCount) {
            issues.push({
              filePath,
              line: index + 1,
              kind: 'tool-count',
              claimed,
              actual: toolCount,
              text: lineText,
            });
          }
        }

        for (const pattern of moduleClaimPatterns) {
          for (const match of lineText.matchAll(pattern)) {
            const claimed = Number(match[1]);
            if (claimed !== moduleCount) {
              issues.push({
                filePath,
                line: index + 1,
                kind: 'module-count',
                claimed,
                actual: moduleCount,
                text: lineText,
              });
            }
          }
        }
      }

      if (toolsTableHeaderIndex >= 0) {
        const moduleRow = lineText.match(toolsTableModuleRowPattern);
        if (moduleRow) {
          const moduleName = moduleRow[1];
          const claimed = Number(moduleRow[2]);
          const actual = toolCountsByModule.get(moduleName ?? '') ?? 0;
          if (moduleName) toolsTableModules.add(moduleName);
          if (claimed !== actual) {
            issues.push({
              filePath,
              line: index + 1,
              kind: 'tool-count',
              claimed,
              actual,
              text: lineText,
            });
          }
        }

        const totalRow = lineText.match(toolsTableTotalRowPattern);
        if (totalRow) {
          const claimed = Number(totalRow[1]);
          if (claimed !== toolCount) {
            issues.push({
              filePath,
              line: index + 1,
              kind: 'tool-count',
              claimed,
              actual: toolCount,
              text: lineText,
            });
          }
        }
      }
    });

    if (toolsTableHeaderIndex >= 0 && toolsTableModules.size !== moduleCount) {
      issues.push({
        filePath,
        line: toolsTableHeaderIndex + 1,
        kind: 'module-count',
        claimed: toolsTableModules.size,
        actual: moduleCount,
        text: lines[toolsTableHeaderIndex] ?? '',
      });
    }
  }

  return issues;
}

function parseArgs(argv: string[]): { docPaths?: string[]; help: boolean } {
  const args: { docPaths?: string[]; help: boolean } = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--doc') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--doc requires a file path');
      args.docPaths = [...(args.docPaths ?? []), next];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run guard:doc-drift
       npm run guard:doc-drift -- --doc <file>

Checks explicit MCP tool/module count claims and current design inventory claims in docs against source registrations.

Options:
  --doc <file>  Check a specific documentation file. May be repeated.
  --help        Show this help.`);
}

function printIssues(issues: DocDriftIssue[]): void {
  for (const issue of issues) {
    const expected = issue.expected ? ` expected="${issue.expected}"` : '';
    console.error(
      `${issue.filePath}:${issue.line} ${issue.kind} drift: claimed=${issue.claimed} actual=${issue.actual}${expected} text="${issue.text}"`,
    );
  }
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): DocDriftIssue[] {
  if (env.WHATSOUP_SKIP_DOC_DRIFT === '1') {
    const inCi = env.CI === 'true' || Boolean(env.GITHUB_ACTIONS);
    if (inCi) {
      console.warn(
        'WHATSOUP_SKIP_DOC_DRIFT=1 ignored: CI/GITHUB_ACTIONS detected; doc drift check will run (this skip is for local dev only)',
      );
    } else {
      console.warn('doc drift check skipped via WHATSOUP_SKIP_DOC_DRIFT=1');
      return [];
    }
  }

  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  const issues = findDocDrift({ cwd, docPaths: args.docPaths });
  if (issues.length > 0) {
    printIssues(issues);
    process.exitCode = 1;
  } else {
    console.log('doc drift check passed');
  }

  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
