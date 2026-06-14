import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeRepoPath } from './lib/guard-core.ts';

export type DocDriftKind =
  | 'tool-count'
  | 'module-count'
  | 'migration-history'
  | 'raw-form-control-inventory';

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

const defaultDocPaths = [
  'CLAUDE.md',
  'README.md',
  'docs/tools.md',
  'docs/configuration.md',
  'docs/design-system/04-enforcement/lint-plan.md',
  'docs/design-system/06-implementation/qa-hardening.md',
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
    { relativePath: 'src/runtimes/agent/runtime.ts', toolName: 'emit_heal_result' },
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

export function findDocDrift(options: DocDriftOptions = {}): DocDriftIssue[] {
  const cwd = options.cwd ?? process.cwd();
  const docPaths = options.docPaths ?? existingDefaultDocs(cwd);
  const registrations = findToolRegistrations(cwd);
  const toolCount = registrations.length;
  const moduleCount = findRegisterModuleImports(cwd).length;
  const migrationVersions = findMigrationRegistryVersions(cwd);
  const rawFormControlInventory = findRawFormControlInventory(cwd);
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
