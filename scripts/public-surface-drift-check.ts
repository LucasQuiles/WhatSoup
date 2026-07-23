import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeRepoPath } from './lib/guard-core.ts';

export type PublicSurfaceDriftKind =
  | 'missing-source'
  | 'missing-npm-script'
  | 'package-json-unreadable'
  | 'missing-registry-entry'
  | 'missing-registry-row'
  | 'registry-doc-mismatch'
  | 'stale-line-anchor'
  | 'missing-route';

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

/**
 * Parsed entry from a ROUTES-table style declaration of the form
 * `{ method: 'GET', path: /^\/api\/x$/, handler: 'getX' }`. We track the
 * source-line of the entry so we can compare to a registry's claimed line.
 */
interface ParsedRouteEntry {
  method: string;
  pattern: RegExp;
  handler: string;
  line: number;
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

interface PackageScriptsReadResult {
  scripts: Set<string>;
  error?: {
    message: string;
    sourcePath: string;
  };
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

function loadPackageScripts(cwd: string): PackageScriptsReadResult {
  const pkgPath = path.resolve(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      scripts: new Set(),
      error: {
        message: 'package.json is missing; public npm surface cannot be verified',
        sourcePath: 'package.json',
      },
    };
  }
  const text = readFileSync(pkgPath, 'utf8');
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return { scripts: new Set(Object.keys(pkg.scripts ?? {})) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      scripts: new Set(),
      error: {
        message: `package.json could not be parsed: ${message}`,
        sourcePath: 'package.json',
      },
    };
  }
}

/**
 * Patterns identifying scripts that are internal (dev/test/build/lint hooks,
 * underscore-prefixed). These are exempt from the reverse coverage check.
 * The list is intentionally conservative: when in doubt, a script is treated
 * as operator-facing and must appear in the registry.
 */
const NON_OPERATOR_SCRIPT_PATTERNS: RegExp[] = [
  /^_/,
  /^test(?:$|[:-])/,
  /^coverage(?:$|[:-])/,
  /^lint(?:$|[:-])/,
  /^typecheck(?:$|[:-])/,
  /^format(?:$|[:-])/,
  /^build(?:$|[:-])/,
  /^dev(?:$|[:-])/,
  /^start:dev$/,
  // npm lifecycle hooks
  /^(?:pre|post)(?:install|test|publish|pack|version|start)$/,
  /^strip-types-compat$/,
];

export function isOperatorFacingScript(scriptName: string): boolean {
  return !NON_OPERATOR_SCRIPT_PATTERNS.some((pattern) => pattern.test(scriptName));
}

function scriptNameToIdentifier(scriptName: string): string {
  // Registry convention: colons in script names are rewritten as hyphens in
  // the cli:npm.* identifier (e.g. `guard:doc-drift` -> `cli:npm.guard-doc-drift`).
  return `${cliNpmIdentifierPrefix}${scriptName.replace(/:/g, '-')}`;
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

function findMethodPathColumnIndex(headers: string[]): number {
  return headers.findIndex((header) => {
    const normalized = header.trim().toLowerCase();
    return normalized === 'method + path' || normalized === 'method+path';
  });
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

/**
 * Extract ROUTES entries from a source file shaped like `src/fleet/index.ts`.
 *
 * Recognises rows of the form
 *   `{ method: 'GET', path: /<regex-body>/, handler: 'handlerName' }`
 * inside the file's text. Returns one parsed entry per matched line; if a row
 * spans multiple lines or contains characters the regex can't tolerate it is
 * skipped silently (route cross-check is best-effort: when no rows are parsed
 * we degrade to existing existence-only checks rather than emit false drift).
 */
export function extractRouteEntries(source: string): ParsedRouteEntry[] {
  const lines = source.split(/\r?\n/);
  // The handler value may use single or double quotes; the regex body uses
  // backslash-escaped slashes so we have to consume everything up to the
  // closing `/` that immediately precedes the next comma.
  const rowPattern =
    /method:\s*['"]([A-Z]+)['"]\s*,\s*path:\s*\/(.*?)\/\s*,\s*handler:\s*['"]([A-Za-z0-9_$]+)['"]/;
  const entries: ParsedRouteEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = line.match(rowPattern);
    if (!match) continue;
    const [, method, body, handler] = match;
    if (!method || !body || !handler) continue;
    let pattern: RegExp;
    try {
      pattern = new RegExp(body);
    } catch {
      continue;
    }
    entries.push({ method, pattern, handler, line: index + 1 });
  }
  return entries;
}

/**
 * Substitutes `:param` segments in a registry-style path (`GET /api/lines/:name`)
 * with a non-slash placeholder so it can be tested against a runtime route regex.
 * Uses an all-digit value so digit-constrained named groups (e.g. `(?<id>\d+)`)
 * still match alongside the generic `[^/]+` pattern. Strips a trailing query
 * string (`?path=...`) before substitution.
 */
function pathTemplateToProbe(template: string): string {
  const noQuery = template.split('?', 1)[0] ?? template;
  return noQuery.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '42');
}

/** Parses a registry "Method + Path" cell into `{ method, path }`. */
function parseMethodPathCell(cell: string): { method: string; path: string } | null {
  const stripped = stripBackticks(cell.trim());
  const match = stripped.match(/^([A-Z]+)\s+(\/\S*)/);
  if (!match) return null;
  return { method: match[1] ?? '', path: match[2] ?? '' };
}

/** Parses `path/to/file.ts:LINE` (or `:START-END`) → `{ path, line }`. */
function parseSourceWithLine(value: string): { path: string; line: number | null } {
  const match = value.match(/^(.*?):(\d+)(?:-\d+)?$/);
  if (!match) return { path: value, line: null };
  const path = match[1] ?? '';
  const lineNum = Number.parseInt(match[2] ?? '', 10);
  return { path, line: Number.isFinite(lineNum) ? lineNum : null };
}

/**
 * Tail symbol-name candidates derived from a registry identifier. Used by the
 * non-HTTP line-anchor sanity check to fuzzy-match the cited source line.
 */
function identifierSymbolCandidates(identifier: string): string[] {
  // Drop the type prefix (`lib:`, `cli:npm.`, etc.) and split on `.` / `-`.
  const tail = identifier.replace(/^[a-z]+(?::[a-z0-9-]+)*\./i, (m) => {
    // keep only the last dotted segment
    const parts = identifier.split('.');
    return parts.slice(-1).join('.') === m.replace(/\.$/, '') ? m : '';
  });
  const parts = identifier.split(/[:.]/).filter(Boolean);
  const candidates = new Set<string>();
  if (parts.length > 0) {
    candidates.add(parts[parts.length - 1] ?? '');
  }
  if (tail) candidates.add(tail);
  return [...candidates].filter((value) => value.length >= 3);
}

function readSourceLines(absPath: string): string[] | null {
  if (!existsSync(absPath)) return null;
  try {
    return readFileSync(absPath, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Verifies the line ±N window around an anchored source path contains a hint
 * of either the registry's identifier symbol (non-HTTP) or the HTTP path
 * template (HTTP rows whose source isn't a ROUTES table file). */
function lineAnchorWindowContains(
  lines: string[],
  centerLine: number,
  needles: string[],
  window = 5,
): boolean {
  const start = Math.max(0, centerLine - 1 - window);
  const end = Math.min(lines.length, centerLine + window);
  for (let index = start; index < end; index += 1) {
    const text = lines[index] ?? '';
    for (const needle of needles) {
      if (!needle) continue;
      if (text.includes(needle)) return true;
    }
  }
  return false;
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
  const packageScriptsRead = loadPackageScripts(cwd);
  const packageScripts = packageScriptsRead.scripts;
  const documentedMcpModules = loadDocumentedMcpModules(cwd);
  const registeredMcpModules = registryMcpModules(tables);
  const registeredNpmScripts = new Set<string>();
  const hasNpmRegistrySection = /^##\s+NPM scripts\b/m.test(text);
  const issues: PublicSurfaceDriftIssue[] = [];

  if (packageScriptsRead.error) {
    issues.push({
      filePath: packageScriptsRead.error.sourcePath,
      line: 1,
      kind: 'package-json-unreadable',
      identifier: 'package.json#scripts',
      sourcePath: packageScriptsRead.error.sourcePath,
      text: packageScriptsRead.error.message,
    });
  }

  // Per-file caches so we don't re-parse `src/fleet/index.ts` for every HTTP row.
  const routeCache = new Map<string, ParsedRouteEntry[]>();
  const sourceLinesCache = new Map<string, string[] | null>();

  const getRoutes = (absPath: string): ParsedRouteEntry[] => {
    const cached = routeCache.get(absPath);
    if (cached) return cached;
    const lines = sourceLinesCache.get(absPath) ?? readSourceLines(absPath);
    sourceLinesCache.set(absPath, lines);
    if (!lines) {
      routeCache.set(absPath, []);
      return [];
    }
    const parsed = extractRouteEntries(lines.join('\n'));
    routeCache.set(absPath, parsed);
    return parsed;
  };

  const getSourceLines = (absPath: string): string[] | null => {
    if (sourceLinesCache.has(absPath)) return sourceLinesCache.get(absPath) ?? null;
    const lines = readSourceLines(absPath);
    sourceLinesCache.set(absPath, lines);
    return lines;
  };

  for (const table of tables) {
    const sourceIdx = findSourceColumnIndex(table.headers);
    const idIdx = findIdentifierColumnIndex(table.headers);
    const scriptIdx = findScriptColumnIndex(table.headers);
    const methodPathIdx = findMethodPathColumnIndex(table.headers);
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

      // --- Line-anchor + route cross-check ----------------------------------
      // Triggered only for rows that explicitly cite `path:LINE` in the Source
      // cell. Two flavours:
      //   1. HTTP rows whose source resolves to a file that parses as a ROUTES
      //      table -> cross-check (method, path) → ROUTES entry line.
      //   2. Other rows -> read the source at LINE ±5 and assert it contains
      //      a needle derived from the identifier / Method+Path cell.
      const httpMethodPath =
        methodPathIdx >= 0
          ? parseMethodPathCell(row.cells[methodPathIdx] ?? '')
          : null;

      for (const candidate of sourcePaths) {
        const cleanedFragment = stripFragment(candidate);
        const { path: rawPath, line: cited } = parseSourceWithLine(cleanedFragment);
        const absolute = resolveAgainstRegistry(registryDir, cwd, rawPath);
        if (!existsSync(absolute)) continue; // missing-source already emitted above

        const routes = getRoutes(absolute);
        if (httpMethodPath && routes.length > 0) {
          const probe = pathTemplateToProbe(httpMethodPath.path);
          const match = routes.find(
            (route) =>
              route.method === httpMethodPath.method && route.pattern.test(probe),
          );
          if (match) {
            if (cited == null) continue;
            if (match.line !== cited) {
              issues.push({
                filePath,
                line: row.line,
                kind: 'stale-line-anchor',
                identifier,
                sourcePath: `${rawPath}:${cited}`,
                expected: `${rawPath}:${match.line} (handler ${match.handler})`,
                actual: `${rawPath}:${cited}`,
                text: row.text,
              });
            }
            continue;
          }
          if (cited == null) {
            issues.push({
              filePath,
              line: row.line,
              kind: 'missing-route',
              identifier,
              sourcePath: rawPath,
              expected: `${httpMethodPath.method} ${httpMethodPath.path}`,
              text: row.text,
            });
            continue;
          }
          // No match in the parsed ROUTES table. The route may be inline (a
          // hand-written `if (pathname === '/api/x')` outside ROUTES). Before
          // declaring `missing-route` drift, look for the path literal in the
          // ±N window around the cited line — that's strong evidence the
          // anchor is at least pointing at the correct handler region.
          const inlineLines = getSourceLines(absolute);
          if (inlineLines) {
            const noQuery = httpMethodPath.path.split('?', 1)[0] ?? httpMethodPath.path;
            const inlineNeedles = [noQuery];
            const tail = noQuery.replace(/^\/api\//, '/');
            if (tail !== noQuery) inlineNeedles.push(tail);
            if (lineAnchorWindowContains(inlineLines, cited, inlineNeedles)) {
              continue;
            }
          }
          issues.push({
            filePath,
            line: row.line,
            kind: 'missing-route',
            identifier,
            sourcePath: rawPath,
            expected: `${httpMethodPath.method} ${httpMethodPath.path}`,
            text: row.text,
          });
          continue;
        }

        if (cited == null) continue;

        // Fallback: line-anchor symbol sanity check. Use the HTTP path (without
        // query string) when available, otherwise derive symbol candidates
        // from the identifier tail.
        const lines = getSourceLines(absolute);
        if (!lines) continue;
        const needles: string[] = [];
        if (httpMethodPath) {
          const noQuery = httpMethodPath.path.split('?', 1)[0] ?? httpMethodPath.path;
          // Path with concrete value already in source code, plus the
          // template-without-prefix segment for handlers that match on a
          // basename (`'/send'`, `'/access'`).
          needles.push(noQuery);
          const tail = noQuery.replace(/^\/api\//, '/');
          if (tail !== noQuery) needles.push(tail);
        } else {
          needles.push(...identifierSymbolCandidates(identifier));
        }
        if (needles.length === 0) continue;
        if (!lineAnchorWindowContains(lines, cited, needles)) {
          issues.push({
            filePath,
            line: row.line,
            kind: 'stale-line-anchor',
            identifier,
            sourcePath: `${rawPath}:${cited}`,
            expected: needles.join(' | '),
            text: row.text,
          });
        }
      }

      if (!packageScriptsRead.error && identifier.startsWith(cliNpmIdentifierPrefix) && scriptIdx >= 0) {
        const scriptCell = row.cells[scriptIdx] ?? '';
        const scriptName = extractNpmScriptName(scriptCell);
        if (scriptName) {
          registeredNpmScripts.add(scriptName);
          if (!packageScripts.has(scriptName)) {
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
  }

  // Reverse coverage check: every operator-facing script declared in
  // package.json must appear as a `cli:npm.*` row in the registry. The forward
  // direction (registry -> package.json) is handled inside the table loop
  // above; this pass closes the asymmetry called out in #497.
  //
  // Gate on either an NPM section or existing script rows so partial registries
  // (e.g. fixtures that exercise only HTTP/MCP rows) don't trigger drift for
  // npm scripts they intentionally omit, while an emptied NPM table still
  // fails closed.
  if (!packageScriptsRead.error && (hasNpmRegistrySection || registeredNpmScripts.size > 0)) {
    for (const scriptName of [...packageScripts].sort()) {
      if (!isOperatorFacingScript(scriptName)) continue;
      if (registeredNpmScripts.has(scriptName)) continue;
      issues.push({
        filePath,
        line: 0,
        kind: 'missing-registry-row',
        identifier: scriptNameToIdentifier(scriptName),
        scriptName,
        text: `npm run ${scriptName}`,
      });
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
  // Script column shape: `` `npm [--silent] run <name>` ``
  const ticked = cell.match(/`([^`]+)`/);
  const body = ticked ? ticked[1] : cell.trim();
  if (!body) return null;
  const match = body.match(/^npm\s+(?:--silent\s+)?run\s+([^\s]+)/);
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
package.json#scripts, every operator-facing script in package.json#scripts has
a matching cli:npm.* registry row, and every docs/tools.md MCP module appears
in the public-surface registry with the same tool count.

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
    const inCi = env.CI === 'true' || Boolean(env.GITHUB_ACTIONS);
    if (inCi) {
      console.warn(
        'WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT=1 ignored: CI/GITHUB_ACTIONS detected; public surface drift check will run (this skip is for local dev only)',
      );
    } else {
      console.warn(
        'public surface drift check skipped via WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT=1',
      );
      return [];
    }
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
