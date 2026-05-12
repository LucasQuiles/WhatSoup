import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findPublicSurfaceDrift,
  run,
} from '../../scripts/public-surface-drift-check.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function makeFakeRepo(): { root: string; registryPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-public-surface-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'src/fleet'), { recursive: true });
  mkdirSync(path.join(root, 'src/mcp/tools'), { recursive: true });
  // Stub `src/fleet/index.ts` with enough lines that line-anchor checks targeting
  // `:281` (referenced by the happy-path registry below) hit a recognizable
  // route declaration in the ±5 window.
  const fleetStub =
    Array.from({ length: 276 }, (_, i) => `// filler ${i + 1}`).join('\n') +
    `
const ROUTES = [
  { method: 'GET',   path: /^\\/api\\/typing$/, handler: 'getTyping' },
  { method: 'GET',   path: /^\\/api\\/feed$/, handler: 'getFeed' },
  { method: 'GET',   path: /^\\/api\\/directories\\/check$/, handler: 'checkDirectory' },
  { method: 'GET',   path: /^\\/api\\/lines$/, handler: 'getLines' },
] as const;
`;
  writeFileSync(path.join(root, 'src/fleet/index.ts'), fleetStub, 'utf8');
  writeFileSync(path.join(root, 'src/mcp/tools/messaging.ts'), '// stub\n', 'utf8');
  writeFileSync(
    path.join(root, 'docs/tools.md'),
    `# Tools

| Module | Tools |
|--------|------:|
| [messaging.ts](#messagingts) | 9 |
`,
    'utf8',
  );
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { start: 'node x', fleet: 'node y' } }, null, 2),
    'utf8',
  );
  return { root, registryPath: path.join(root, 'docs/public-surface.md') };
}

const happyRegistry = `# Public surface

## HTTP

| Identifier | Method + Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`http:fleet.lines.list\` | \`GET /api/lines\` | \`src/fleet/index.ts:281\` | stable | active | List |

## MCP

| Identifier | Tools | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`mcp:tools.messaging\` | 9 | [\`src/mcp/tools/messaging.ts\`](../src/mcp/tools/messaging.ts) | stable | active | x |

## NPM scripts (operator-facing)

| Identifier | Script | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`cli:npm.start\` | \`npm run start\` | \`package.json\` | stable | active | Start |
| \`cli:npm.fleet\` | \`npm run fleet\` | \`package.json\` | stable | active | Fleet |
`;

describe('public surface drift check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('passes when every row resolves on disk and every cli:npm.* script exists', () => {
    const { root, registryPath } = makeFakeRepo();
    writeFileSync(registryPath, happyRegistry, 'utf8');

    expect(findPublicSurfaceDrift({ cwd: root })).toEqual([]);
  });

  it('passes for the live repository registry', () => {
    expect(findPublicSurfaceDrift({ cwd: repoRoot })).toEqual([]);
  });

  it('flags a missing source path with row context', () => {
    const { root, registryPath } = makeFakeRepo();
    const registry = happyRegistry.replace(
      '`src/fleet/index.ts:281`',
      '`src/fleet/missing-route.ts:42`',
    );
    writeFileSync(registryPath, registry, 'utf8');

    const issues = findPublicSurfaceDrift({ cwd: root });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'missing-source',
      identifier: 'http:fleet.lines.list',
      sourcePath: 'src/fleet/missing-route.ts',
    });
    expect(issues[0].line).toBeGreaterThan(0);
  });

  it('flags a renamed cli:npm.* script that no longer exists in package.json', () => {
    const { root, registryPath } = makeFakeRepo();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { 'start-renamed': 'node x', fleet: 'node y' } }, null, 2),
      'utf8',
    );
    writeFileSync(registryPath, happyRegistry, 'utf8');

    const issues = findPublicSurfaceDrift({ cwd: root });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'missing-npm-script',
        identifier: 'cli:npm.start',
        scriptName: 'start',
      }),
    ]);
  });

  it('flags a docs/tools.md MCP module that is missing from the registry', () => {
    const { root, registryPath } = makeFakeRepo();
    writeFileSync(
      registryPath,
      `# Public surface

| Identifier | Source | Stability | Status | Notes |
|---|---|---|---|---|
`,
      'utf8',
    );

    expect(findPublicSurfaceDrift({ cwd: root })).toEqual([
      expect.objectContaining({
        filePath: 'docs/tools.md',
        kind: 'missing-registry-entry',
        identifier: 'mcp:tools.messaging',
        sourcePath: 'src/mcp/tools/messaging.ts',
        expected: 9,
      }),
    ]);
  });

  it('flags an MCP module tool-count mismatch against docs/tools.md', () => {
    const { root, registryPath } = makeFakeRepo();
    writeFileSync(registryPath, happyRegistry.replace('| `mcp:tools.messaging` | 9 |', '| `mcp:tools.messaging` | 8 |'), 'utf8');

    expect(findPublicSurfaceDrift({ cwd: root })).toEqual([
      expect.objectContaining({
        kind: 'registry-doc-mismatch',
        identifier: 'mcp:tools.messaging',
        expected: 9,
        actual: 8,
      }),
    ]);
  });

  it('flags an MCP module registry identifier mismatch against docs/tools.md', () => {
    const { root, registryPath } = makeFakeRepo();
    writeFileSync(
      registryPath,
      happyRegistry.replace('`mcp:tools.messaging`', '`mcp:tools.messaging-renamed`'),
      'utf8',
    );

    expect(findPublicSurfaceDrift({ cwd: root })).toEqual([
      expect.objectContaining({
        kind: 'registry-doc-mismatch',
        identifier: 'mcp:tools.messaging-renamed',
        sourcePath: 'src/mcp/tools/messaging.ts',
        expected: 'mcp:tools.messaging',
        actual: 'mcp:tools.messaging-renamed',
      }),
    ]);
  });

  it('flags an MCP module registry entry that is absent from docs/tools.md', () => {
    const { root, registryPath } = makeFakeRepo();
    writeFileSync(path.join(root, 'src/mcp/tools/ghost.ts'), '// stub\n', 'utf8');
    writeFileSync(
      registryPath,
      happyRegistry.replace(
        '| `mcp:tools.messaging` | 9 | [`src/mcp/tools/messaging.ts`](../src/mcp/tools/messaging.ts) | stable | active | x |',
        '| `mcp:tools.messaging` | 9 | [`src/mcp/tools/messaging.ts`](../src/mcp/tools/messaging.ts) | stable | active | x |\n| `mcp:tools.ghost` | 1 | [`src/mcp/tools/ghost.ts`](../src/mcp/tools/ghost.ts) | stable | active | x |',
      ),
      'utf8',
    );

    expect(findPublicSurfaceDrift({ cwd: root })).toEqual([
      expect.objectContaining({
        kind: 'registry-doc-mismatch',
        identifier: 'mcp:tools.ghost',
        sourcePath: 'src/mcp/tools/ghost.ts',
        actual: 1,
      }),
    ]);
  });

  it('sets a failing CLI status and prints structured drift output', () => {
    const { root, registryPath } = makeFakeRepo();
    const registry = happyRegistry.replace(
      '`src/fleet/index.ts:281`',
      '`src/fleet/missing-route.ts:42`',
    );
    writeFileSync(registryPath, registry, 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const issues = run([], root, {});

    expect(issues).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalled();
    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain('http:fleet.lines.list');
    expect(message).toContain('missing-source');
    expect(message).toContain('src/fleet/missing-route.ts');
  });

  it('flags an HTTP row whose line anchor points at a different handler in ROUTES', () => {
    const { root, registryPath } = makeFakeRepo();
    // Two routes on adjacent lines so swapping anchors is plausible.
    const routesSource = `// stub fleet routes
const ROUTES = [
  { method: 'GET',   path: /^\\/api\\/directories\\/check$/, handler: 'checkDirectory' },
  { method: 'GET',   path: /^\\/api\\/lines$/, handler: 'getLines' },
] as const;
`;
    writeFileSync(path.join(root, 'src/fleet/index.ts'), routesSource, 'utf8');
    // Line 3 is checkDirectory; the registry claims `GET /api/lines` resolves there
    // (the correct anchor is line 4, getLines).
    const registry = `# Public surface

## HTTP

| Identifier | Method + Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`http:fleet.lines.list\` | \`GET /api/lines\` | \`src/fleet/index.ts:3\` | stable | active | List |

## MCP

| Identifier | Tools | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`mcp:tools.messaging\` | 9 | [\`src/mcp/tools/messaging.ts\`](../src/mcp/tools/messaging.ts) | stable | active | x |
`;
    writeFileSync(registryPath, registry, 'utf8');

    const issues = findPublicSurfaceDrift({ cwd: root });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'stale-line-anchor',
        identifier: 'http:fleet.lines.list',
        sourcePath: 'src/fleet/index.ts:3',
      }),
    ]);
    // Issue should name the expected (correct) anchor so authors can fix in-place.
    expect(String(issues[0]?.expected ?? '')).toContain(':4');
    expect(String(issues[0]?.expected ?? '')).toContain('getLines');
  });

  it('flags an HTTP row whose Method+Path has no matching ROUTES entry', () => {
    const { root, registryPath } = makeFakeRepo();
    const routesSource = `// stub fleet routes
const ROUTES = [
  { method: 'GET',   path: /^\\/api\\/lines$/, handler: 'getLines' },
] as const;
`;
    writeFileSync(path.join(root, 'src/fleet/index.ts'), routesSource, 'utf8');
    const registry = `# Public surface

## HTTP

| Identifier | Method + Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`http:fleet.ghost\` | \`POST /api/ghost\` | \`src/fleet/index.ts:3\` | stable | active | Ghost |

## MCP

| Identifier | Tools | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`mcp:tools.messaging\` | 9 | [\`src/mcp/tools/messaging.ts\`](../src/mcp/tools/messaging.ts) | stable | active | x |
`;
    writeFileSync(registryPath, registry, 'utf8');

    const issues = findPublicSurfaceDrift({ cwd: root });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'missing-route',
        identifier: 'http:fleet.ghost',
        sourcePath: 'src/fleet/index.ts',
        expected: 'POST /api/ghost',
      }),
    ]);
  });

  it('flags a line anchor whose +-5 window does not contain the expected symbol', () => {
    const { root, registryPath } = makeFakeRepo();
    // 30-line filler file, the only meaningful symbol is far from line 2.
    const filler = Array.from({ length: 30 }, (_, i) => `// filler ${i + 1}`).join('\n');
    const sourceText = `${filler}\nexport function realSymbol() { return true; }\n`;
    writeFileSync(path.join(root, 'src/fleet/index.ts'), sourceText, 'utf8');
    const registry = `# Public surface

## Lib

| Identifier | Source | Stability | Status | Notes |
|---|---|---|---|---|
| \`lib:fleet.realSymbol\` | \`src/fleet/index.ts:2\` | stable | active | Misc |

## MCP

| Identifier | Tools | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`mcp:tools.messaging\` | 9 | [\`src/mcp/tools/messaging.ts\`](../src/mcp/tools/messaging.ts) | stable | active | x |
`;
    writeFileSync(registryPath, registry, 'utf8');

    const issues = findPublicSurfaceDrift({ cwd: root });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'stale-line-anchor',
        identifier: 'lib:fleet.realSymbol',
        sourcePath: 'src/fleet/index.ts:2',
      }),
    ]);
  });

  it('passes when the HTTP row anchor matches the ROUTES entry line exactly', () => {
    const { root, registryPath } = makeFakeRepo();
    const routesSource = `// stub fleet routes
const ROUTES = [
  { method: 'GET',   path: /^\\/api\\/directories\\/check$/, handler: 'checkDirectory' },
  { method: 'GET',   path: /^\\/api\\/lines$/, handler: 'getLines' },
] as const;
`;
    writeFileSync(path.join(root, 'src/fleet/index.ts'), routesSource, 'utf8');
    const registry = `# Public surface

## HTTP

| Identifier | Method + Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`http:fleet.lines.list\` | \`GET /api/lines\` | \`src/fleet/index.ts:4\` | stable | active | List |
| \`http:fleet.directories.check\` | \`GET /api/directories/check?path=...\` | \`src/fleet/index.ts:3\` | stable | active | Check |

## MCP

| Identifier | Tools | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| \`mcp:tools.messaging\` | 9 | [\`src/mcp/tools/messaging.ts\`](../src/mcp/tools/messaging.ts) | stable | active | x |
`;
    writeFileSync(registryPath, registry, 'utf8');

    expect(findPublicSurfaceDrift({ cwd: root })).toEqual([]);
  });

  it('allows an explicit environment bypass for emergency pushes', () => {
    const { root, registryPath } = makeFakeRepo();
    const registry = happyRegistry.replace(
      '`src/fleet/index.ts:281`',
      '`src/fleet/missing-route.ts:42`',
    );
    writeFileSync(registryPath, registry, 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(run([], root, { WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT: '1' })).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'public surface drift check skipped via WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT=1',
    );
  });
});
