import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type DocDriftKind = 'tool-count' | 'module-count';

export interface DocDriftIssue {
  filePath: string;
  line: number;
  kind: DocDriftKind;
  claimed: number;
  actual: number;
  text: string;
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

const defaultDocPaths = [
  'CLAUDE.md',
  'README.md',
  'docs/tools.md',
  'docs/configuration.md',
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

function normalizeRepoPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

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

  return registrations.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line);
}

export function findRegisterModuleImports(cwd: string = process.cwd()): ModuleImport[] {
  const registerAllPath = path.resolve(cwd, 'src/mcp/register-all.ts');
  const text = readFileSync(registerAllPath, 'utf8');
  const filePath = normalizeRepoPath(path.relative(cwd, registerAllPath));
  const imports: ModuleImport[] = [];
  const importPattern = /^import\s+\{[^}]*\}\s+from\s+['"](\.\/tools\/[^'"]+\.ts)['"];?$/gm;

  // Module count is derived from register-all.ts imports because that file is
  // the canonical runtime wiring point for tool modules, including conditional
  // modules such as knowledge search.
  for (const match of text.matchAll(importPattern)) {
    const modulePath = match[1];
    if (!modulePath) continue;
    imports.push({
      filePath,
      line: lineForOffset(text, match.index ?? 0),
      modulePath,
    });
  }

  return imports;
}

export function findDocDrift(options: DocDriftOptions = {}): DocDriftIssue[] {
  const cwd = options.cwd ?? process.cwd();
  const docPaths = options.docPaths ?? existingDefaultDocs(cwd);
  const registrations = findToolRegistrations(cwd);
  const toolCount = registrations.length;
  const moduleCount = findRegisterModuleImports(cwd).length;
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

Checks explicit MCP tool/module count claims in docs against source registrations.

Options:
  --doc <file>  Check a specific documentation file. May be repeated.
  --help        Show this help.`);
}

function printIssues(issues: DocDriftIssue[]): void {
  for (const issue of issues) {
    console.error(
      `${issue.filePath}:${issue.line} ${issue.kind} drift: claimed=${issue.claimed} actual=${issue.actual} text="${issue.text}"`,
    );
  }
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): DocDriftIssue[] {
  if (env.WHATSOUP_SKIP_DOC_DRIFT === '1') {
    console.warn('doc drift check skipped via WHATSOUP_SKIP_DOC_DRIFT=1');
    return [];
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
