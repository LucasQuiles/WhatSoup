import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type PublicSurfaceDriftKind =
  | 'missing-source'
  | 'missing-npm-script'
  | 'missing-registry-entry'
  | 'registry-doc-mismatch';

export interface PublicSurfaceDriftIssue {
  filePath: string;
  line: number;
  kind: PublicSurfaceDriftKind;
  identifier: string;
  sourcePath?: string;
  scriptName?: string;
  expected?: string | number;
  actual?: string | number;
  text: string;
}

export interface PublicSurfaceDriftOptions {
  cwd?: string;
  registryPath?: string;
}

interface TableRow {
  line: number;
  text: string;
  cells: string[];
}

interface ParsedTable {
  headerLine: number;
  headers: string[];
  rows: TableRow[];
}

const defaultRegistryPath = 'docs/public-surface.md';
const cliNpmIdentifierPrefix = 'cli:npm.';
const mcpIdentifierPrefix = 'mcp:tools.';

interface DocumentedMcpModule {
  moduleName: string;
  tools: number;
  line: number;
  text: string;
}

interface RegistryMcpModule {
  identifier: string;
  moduleName: string;
  tools: number | null;
  line: number;
  text: string;
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function splitTableRow(line: string): string[] {
  // Trim leading/trailing pipe, then split. Cells are not escaped in this
  // registry, so a simple split is sufficient.
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function parseTables(text: string): ParsedTable[] {
  const lines = text.split(/\r?\n/);
  const tables: ParsedTable[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = lines[index] ?? '';
    if (!headerLine.trimStart().startsWith('|')) continue;
    const next = lines[index + 1] ?? '';
    if (!next.trimStart().startsWith('|')) continue;

    const headerCells = splitTableRow(headerLine);
    const separatorCells = splitTableRow(next);
    if (!isSeparatorRow(separatorCells)) continue;
    if (headerCells.length !== separatorCells.length) continue;

    const rows: TableRow[] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const rowLine = lines[cursor] ?? '';
      if (!rowLine.trimStart().startsWith('|')) break;
      const cells = splitTableRow(rowLine);
      if (cells.length === headerCells.length) {
        rows.push({ line: cursor + 1, text: rowLine, cells });
      }
      cursor += 1;
    }

    tables.push({ headerLine: index + 1, headers: headerCells, rows });
    index = cursor - 1;
  }

  return tables;
}

function stripBackticks(value: string): string {
  return value.replace(/^`+/, '').replace(/`+$/, '');
}

function stripLineRange(value: string): string {
  // Drop a trailing `:LINE` or `:START-END` from a path reference.
  return value.replace(/:\d+(?:-\d+)?$/, '');
}

function stripFragment(value: string): string {
  const hashIndex = value.indexOf('#');
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
}

export function extractSourcePaths(cell: string): string[] {
  const paths: string[] = [];

  // Markdown links: prefer the URL portion. Multiple per cell are allowed.
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let foundLink = false;
  for (const match of cell.matchAll(linkPattern)) {
    foundLink = true;
    const url = match[1]?.trim();
    if (!url) continue;
    if (/^https?:\/\//i.test(url)) continue;
    const cleaned = stripFragment(url);
    if (cleaned) paths.push(cleaned);
  }
  if (foundLink) return paths;

  // No markdown link → look for backticked paths.
  const tickPattern = /`([^`]+)`/g;
  for (const match of cell.matchAll(tickPattern)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    // Heuristic: treat as path only if it looks like one (has /, ., or matches
    // a known top-level file). Avoid backticked code like `GET /api/lines`.
    if (/\s/.test(raw)) continue;
    if (!/[./]/.test(raw)) continue;
    paths.push(raw);
  }

  return paths;
}

function resolveAgainstRegistry(
  registryDir: string,
  cwd: string,
  candidate: string,
): string {
  const trimmed = candidate.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  // Registry uses `../foo` to reference repo-root siblings of `docs/`, and bare
  // `foo/bar.md` to reference siblings inside `docs/`. Anchor relative paths to
  // the directory containing the registry so both forms resolve correctly.
  if (trimmed.startsWith('../') || trimmed.startsWith('./')) {
    return path.resolve(registryDir, trimmed);
  }
  // Bare `package.json`, `src/...`, `deploy/...` etc. — anchor at repo root.
  // (These are paths that read naturally as "from the repo root".) The trailing
  // character must be `/` or end-of-string so that names like `console-guide.md`
  // (a doc-relative sibling) don't match the `console` directory.
  if (/^(?:src|deploy|scripts|tests|console|docs)(?:\/|$)/.test(trimmed)) {
    return path.resolve(cwd, trimmed);
  }
  if (/^(?:package\.json|\.mcp\.json)$/.test(trimmed)) {
    return path.resolve(cwd, trimmed);
  }
  // Default: treat as relative to the registry directory.
  return path.resolve(registryDir, trimmed);
}

function identifierFromRow(row: TableRow): string {
  const raw = row.cells[0] ?? '';
  return stripBackticks(raw).trim();
}

function loadPackageScripts(cwd: string): Set<string> {
  const pkgPath = path.resolve(cwd, 'package.json');
  if (!existsSync(pkgPath)) return new Set();
  const text = readFileSync(pkgPath, 'utf8');
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

function findSourceColumnIndex(headers: string[]): number {
  return headers.findIndex((header) => header.trim().toLowerCase() === 'source');
}

function findIdentifierColumnIndex(headers: string[]): number {
  return headers.findIndex((header) => header.trim().toLowerCase() === 'identifier');
}

function findScriptColumnIndex(headers: string[]): number {
  return headers.findIndex((header) => header.trim().toLowerCase() === 'script');
}

function findToolsColumnIndex(headers: string[]): number {
  return headers.findIndex((header) => header.trim().toLowerCase() === 'tools');
}

function parseIntegerCell(value: string): number | null {
  const normalized = stripBackticks(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  return Number.parseInt(normalized, 10);
}

function parseMarkdownLinkLabel(value: string): string | null {
  const match = value.match(/\[([^\]]+)\]\([^)]+\)/);
  return match?.[1]?.trim() ?? null;
}

function loadDocumentedMcpModules(cwd: string): Map<string, DocumentedMcpModule> {
  const docsToolsPath = path.resolve(cwd, 'docs/tools.md');
  if (!existsSync(docsToolsPath)) return new Map();

  const text = readFileSync(docsToolsPath, 'utf8');
  const modules = new Map<string, DocumentedMcpModule>();
  for (const table of parseTables(text)) {
    const moduleIdx = table.headers.findIndex((header) => header.trim().toLowerCase() === 'module');
    const toolsIdx = findToolsColumnIndex(table.headers);
    if (moduleIdx < 0 || toolsIdx < 0) continue;

    for (const row of table.rows) {
      const rawModule = row.cells[moduleIdx] ?? '';
      const label = parseMarkdownLinkLabel(rawModule) ?? stripBackticks(rawModule).trim();
      if (!label.endsWith('.ts')) continue;
      const tools = parseIntegerCell(row.cells[toolsIdx] ?? '');
      if (tools === null) continue;
      modules.set(label, {
        moduleName: label,
        tools,
        line: row.line,
        text: row.text,
      });
    }
  }
  return modules;
}

function registryMcpModules(tables: ParsedTable[]): Map<string, RegistryMcpModule> {
  const modules = new Map<string, RegistryMcpModule>();

  for (const table of tables) {
    const sourceIdx = findSourceColumnIndex(table.headers);
    const idIdx = findIdentifierColumnIndex(table.headers);
    const toolsIdx = findToolsColumnIndex(table.headers);
    if (sourceIdx < 0 || idIdx < 0 || toolsIdx < 0) continue;

    for (const row of table.rows) {
      const identifier = identifierFromRow(row);
      if (!identifier.startsWith(mcpIdentifierPrefix)) continue;

      const sourcePaths = extractSourcePaths(row.cells[sourceIdx] ?? '');
      const toolModule = sourcePaths
        .map((sourcePath) => path.basename(stripLineRange(stripFragment(sourcePath))))
        .find((sourcePath) => sourcePath.endsWith('.ts'));
      if (!toolModule) continue;

      modules.set(toolModule, {
        identifier,
        moduleName: toolModule,
        tools: parseIntegerCell(row.cells[toolsIdx] ?? ''),
        line: row.line,
        text: row.text,
      });
    }
  }

  return modules;
}

export function findPublicSurfaceDrift(
  options: PublicSurfaceDriftOptions = {},
): PublicSurfaceDriftIssue[] {
  const cwd = options.cwd ?? process.cwd();
  const registryRel = options.registryPath ?? defaultRegistryPath;
  const registryAbs = path.isAbsolute(registryRel)
    ? registryRel
    : path.resolve(cwd, registryRel);
  const registryDir = path.dirname(registryAbs);
  const filePath = normalizeRepoPath(path.relative(cwd, registryAbs)) || registryRel;

  const text = readFileSync(registryAbs, 'utf8');
  const tables = parseTables(text);
  const packageScripts = loadPackageScripts(cwd);
  const documentedMcpModules = loadDocumentedMcpModules(cwd);
  const registeredMcpModules = registryMcpModules(tables);
  const issues: PublicSurfaceDriftIssue[] = [];

  for (const table of tables) {
    const sourceIdx = findSourceColumnIndex(table.headers);
    const idIdx = findIdentifierColumnIndex(table.headers);
    const scriptIdx = findScriptColumnIndex(table.headers);
    if (sourceIdx < 0 || idIdx < 0) continue;

    for (const row of table.rows) {
      const identifier = identifierFromRow(row);
      const sourceCell = row.cells[sourceIdx] ?? '';
      const sourcePaths = extractSourcePaths(sourceCell);

      for (const candidate of sourcePaths) {
        const cleanedForResolution = stripLineRange(stripFragment(candidate));
        if (!cleanedForResolution) continue;
        const absolute = resolveAgainstRegistry(registryDir, cwd, cleanedForResolution);
        if (existsSync(absolute)) continue;
        const reportedPath = stripLineRange(stripFragment(candidate));
        issues.push({
          filePath,
          line: row.line,
          kind: 'missing-source',
          identifier,
          sourcePath: reportedPath,
          text: row.text,
        });
      }

      if (identifier.startsWith(cliNpmIdentifierPrefix) && scriptIdx >= 0) {
        const scriptCell = row.cells[scriptIdx] ?? '';
        const scriptName = extractNpmScriptName(scriptCell);
        if (scriptName && !packageScripts.has(scriptName)) {
          issues.push({
            filePath,
            line: row.line,
            kind: 'missing-npm-script',
            identifier,
            scriptName,
            text: row.text,
          });
        }
      }
    }
  }

  for (const documented of [...documentedMcpModules.values()].sort((a, b) => a.moduleName.localeCompare(b.moduleName))) {
    const registered = registeredMcpModules.get(documented.moduleName);
    if (!registered) {
      issues.push({
        filePath: 'docs/tools.md',
        line: documented.line,
        kind: 'missing-registry-entry',
        identifier: `${mcpIdentifierPrefix}${documented.moduleName.replace(/\.ts$/, '')}`,
        sourcePath: `src/mcp/tools/${documented.moduleName}`,
        expected: documented.tools,
        text: documented.text,
      });
      continue;
    }

    const expectedIdentifier = `${mcpIdentifierPrefix}${documented.moduleName.replace(/\.ts$/, '')}`;
    if (registered.identifier !== expectedIdentifier) {
      issues.push({
        filePath,
        line: registered.line,
        kind: 'registry-doc-mismatch',
        identifier: registered.identifier,
        sourcePath: `src/mcp/tools/${documented.moduleName}`,
        expected: expectedIdentifier,
        actual: registered.identifier,
        text: registered.text,
      });
    }

    if (registered.tools !== documented.tools) {
      issues.push({
        filePath,
        line: registered.line,
        kind: 'registry-doc-mismatch',
        identifier: registered.identifier,
        sourcePath: `src/mcp/tools/${documented.moduleName}`,
        expected: documented.tools,
        actual: registered.tools ?? 'unparseable',
        text: registered.text,
      });
    }
  }

  for (const registered of [...registeredMcpModules.values()].sort((a, b) => a.moduleName.localeCompare(b.moduleName))) {
    if (documentedMcpModules.has(registered.moduleName)) continue;
    issues.push({
      filePath,
      line: registered.line,
      kind: 'registry-doc-mismatch',
      identifier: registered.identifier,
      sourcePath: `src/mcp/tools/${registered.moduleName}`,
      actual: registered.tools ?? 'unparseable',
      text: registered.text,
    });
  }

  return issues;
}

export function extractNpmScriptName(cell: string): string | null {
  // Script column shape: `` `npm run <name>` ``
  const ticked = cell.match(/`([^`]+)`/);
  const body = ticked ? ticked[1] : cell.trim();
  if (!body) return null;
  const match = body.match(/^npm\s+run\s+([^\s]+)/);
  return match ? match[1] ?? null : null;
}

function parseArgs(argv: string[]): { registryPath?: string; help: boolean } {
  const args: { registryPath?: string; help: boolean } = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--registry') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--registry requires a file path');
      args.registryPath = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run guard:public-surface-drift
       npm run guard:public-surface-drift -- --registry <file>

Verifies that every row in docs/public-surface.md points at a Source path that
resolves on disk, every cli:npm.* row names a script that exists in
package.json#scripts, and every docs/tools.md MCP module appears in the
public-surface registry with the same tool count.

Options:
  --registry <file>  Check an alternate registry file.
  --help             Show this help.`);
}

function printIssues(issues: PublicSurfaceDriftIssue[]): void {
  for (const issue of issues) {
    const details: string[] = [];
    if (issue.sourcePath) details.push(`source="${issue.sourcePath}"`);
    if (issue.scriptName) details.push(`script="${issue.scriptName}"`);
    if (issue.expected !== undefined) details.push(`expected="${issue.expected}"`);
    if (issue.actual !== undefined) details.push(`actual="${issue.actual}"`);
    console.error(
      `${issue.filePath}:${issue.line} ${issue.kind} drift: identifier=${issue.identifier} ${details.join(' ')} row="${issue.text}"`,
    );
  }
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): PublicSurfaceDriftIssue[] {
  if (env.WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT === '1') {
    console.warn(
      'public surface drift check skipped via WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT=1',
    );
    return [];
  }

  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  const issues = findPublicSurfaceDrift({ cwd, registryPath: args.registryPath });
  if (issues.length > 0) {
    printIssues(issues);
    process.exitCode = 1;
  } else {
    console.log('public surface drift check passed');
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
