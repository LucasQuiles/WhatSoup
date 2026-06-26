import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findDocDrift,
  findDesignBurndownSummary,
  findDesignGuardTestInventory,
  findDesignRegressionBlockingChecks,
  findDesignRegressionCheckCount,
  findRawFormControlInventory,
  findShadowBaselineInventory,
  findSoupKitchenLabelCount,
  findTestFileTestCount,
  findThemeParityTokenCount,
  findToolRegistrations,
  run,
} from '../../scripts/doc-drift-check.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const currentToolCount = findToolRegistrations(repoRoot).length;
const currentSubstrateToolCount = findToolRegistrations(repoRoot).filter((r) => r.filePath.endsWith('substrate.ts')).length;
const currentRawFormControlInventory = findRawFormControlInventory(repoRoot);
const currentShadowBaselineInventory = findShadowBaselineInventory(repoRoot);
const currentDesignRegressionCheckCount = findDesignRegressionCheckCount(repoRoot);
const currentDesignGuardTestInventory = findDesignGuardTestInventory(repoRoot);
const currentThemeParityTokenCount = findThemeParityTokenCount(repoRoot);
const currentDesignBurndownSummary = findDesignBurndownSummary(repoRoot);
const currentDesignRegressionBlockingChecks = findDesignRegressionBlockingChecks(repoRoot);
const currentSoupKitchenLabelCount = findSoupKitchenLabelCount(repoRoot);
const currentUseThemeTestCount = findTestFileTestCount(repoRoot, 'tests/console/use-theme.test.tsx');

describe('doc drift check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('passes for current MCP tool, module count, and design inventory docs', () => {
    expect(findDocDrift({ cwd: repoRoot })).toEqual([]);
  });

  it('flags stale explicit MCP tool count claims with file and line details', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'stale.md');
    writeFileSync(staleDoc, 'WhatSoup currently exposes 127 MCP tools.\n', 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentToolCount,
        claimed: 127,
        filePath: staleDoc,
        kind: 'tool-count',
        line: 1,
        text: 'WhatSoup currently exposes 127 MCP tools.',
      },
    ]);
  });

  it('sets a failing CLI status and prints claimed versus actual count drift', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'stale.md');
    writeFileSync(staleDoc, 'WhatSoup currently exposes 127 MCP tools.\n', 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const issues = run(['--doc', staleDoc], repoRoot, {});

    expect(issues).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      `${staleDoc}:1 tool-count drift: claimed=127 actual=${currentToolCount} text="WhatSoup currently exposes 127 MCP tools."`,
    );
  });

  it('flags stale MCP tool reference table rows and totals', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'tools.md');
    const currentToolsDoc = readFileSync(path.join(repoRoot, 'docs/tools.md'), 'utf8');
    writeFileSync(
      staleDoc,
      currentToolsDoc
        .replace('| [substrate.ts](#substratets) | 20 |', '| [substrate.ts](#substratets) | 18 |')
        .replace('| **Total** | **164** |', '| **Total** | **160** |'),
      'utf8',
    );

    const staleLines = readFileSync(staleDoc, 'utf8').split(/\r?\n/);
    const substrateLine =
      staleLines.findIndex((line) => line === '| [substrate.ts](#substratets) | 18 |') + 1;
    const totalLine =
      staleLines.findIndex((line) => line === '| **Total** | **160** |') + 1;

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentSubstrateToolCount,
        claimed: 18,
        filePath: staleDoc,
        kind: 'tool-count',
        line: substrateLine,
        text: '| [substrate.ts](#substratets) | 18 |',
      },
      {
        actual: currentToolCount,
        claimed: 160,
        filePath: staleDoc,
        kind: 'tool-count',
        line: totalLine,
        text: '| **Total** | **160** |',
      },
    ]);
  });

  it('flags stale database migration history rows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'configuration.md');
    const currentConfigDoc = readFileSync(path.join(repoRoot, 'docs/configuration.md'), 'utf8');
    writeFileSync(
      staleDoc,
      currentConfigDoc
        .replace('`contacts`', 'contacts')
        .replace(
          '`inbound_events`, `outbound_ops`, `tool_calls`, `session_checkpoints`, `recovery_runs`',
          '`durability_queue`, `recovery_log`',
        ),
      'utf8',
    );

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toMatchObject([
      {
        filePath: staleDoc,
        kind: 'migration-history',
        claimed: 1,
        actual: 1,
        expected: 'migration 1 row to mention `contacts`',
      },
      {
        filePath: staleDoc,
        kind: 'migration-history',
        claimed: 2,
        actual: 2,
        expected: 'migration 2 row to mention `inbound_events`',
      },
      {
        filePath: staleDoc,
        kind: 'migration-history',
        claimed: 2,
        actual: 2,
        expected: 'migration 2 row to mention `outbound_ops`',
      },
      {
        filePath: staleDoc,
        kind: 'migration-history',
        claimed: 2,
        actual: 2,
        expected: 'migration 2 row to mention `tool_calls`',
      },
      {
        filePath: staleDoc,
        kind: 'migration-history',
        claimed: 2,
        actual: 2,
        expected: 'migration 2 row to mention `session_checkpoints`',
      },
      {
        filePath: staleDoc,
        kind: 'migration-history',
        claimed: 2,
        actual: 2,
        expected: 'migration 2 row to mention `recovery_runs`',
      },
    ]);
  });

  it('flags stale current raw form-control inventory claims', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'design.md');
    writeFileSync(
      staleDoc,
      [
        'The current enforced inventory is 28 total findings: 28 consumer migrations and 0 primitive',
        'self-hits, with an element split of 19 inputs, 2 selects, and 7 textareas.',
        'Current generated manifest',
        'manifest is exactly 28 consumer hits.',
      ].join('\n'),
      'utf8',
    );

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toMatchObject([
      {
        actual: currentRawFormControlInventory.total,
        claimed: 28,
        filePath: staleDoc,
        kind: 'raw-form-control-inventory',
        line: 1,
        expected: 'raw form-control total from console/design-raw-form-control-inventory.json',
      },
      {
        actual: currentRawFormControlInventory.consumerMigrations,
        claimed: 28,
        filePath: staleDoc,
        kind: 'raw-form-control-inventory',
        line: 1,
        expected: 'raw form-control consumer migrations from console/design-raw-form-control-inventory.json',
      },
      {
        actual: currentRawFormControlInventory.input,
        claimed: 19,
        filePath: staleDoc,
        kind: 'raw-form-control-inventory',
        line: 1,
        expected: 'raw form-control input count from console/design-raw-form-control-inventory.json',
      },
      {
        actual: currentRawFormControlInventory.select,
        claimed: 2,
        filePath: staleDoc,
        kind: 'raw-form-control-inventory',
        line: 1,
        expected: 'raw form-control select count from console/design-raw-form-control-inventory.json',
      },
      {
        actual: currentRawFormControlInventory.textarea,
        claimed: 7,
        filePath: staleDoc,
        kind: 'raw-form-control-inventory',
        line: 1,
        expected: 'raw form-control textarea count from console/design-raw-form-control-inventory.json',
      },
      {
        actual: currentRawFormControlInventory.consumerMigrations,
        claimed: 28,
        filePath: staleDoc,
        kind: 'raw-form-control-inventory',
        line: 3,
        expected: 'raw form-control consumer migrations from console/design-raw-form-control-inventory.json',
      },
    ]);
  });

  it('flags stale current shadow-baseline totals in live design enforcement docs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'conformance-manifest.md');
    writeFileSync(
      staleDoc,
      '| Token enforcement | `console/lint-shadow-baseline.json` — 602, rule×file buckets | current design-enforcement row |\n',
      'utf8',
    );

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentShadowBaselineInventory.total,
        claimed: 602,
        filePath: staleDoc,
        kind: 'shadow-baseline-total',
        line: 1,
        text: '| Token enforcement | `console/lint-shadow-baseline.json` — 602, rule×file buckets | current design-enforcement row |',
        expected: 'shadow lint total from console/lint-shadow-baseline.json',
      },
    ]);
  });

  it('flags stale current brand-regression lint counts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'conformance-manifest.md');
    const staleCount = (currentShadowBaselineInventory.byRule['soup/no-brand-regression'] ?? 0) + 1;
    const text = `Brand scope evidence: brand-regression lint (${staleCount} hits = split wordmark + UpdateModal ternary).`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentShadowBaselineInventory.byRule['soup/no-brand-regression'] ?? 0,
        claimed: staleCount,
        filePath: staleDoc,
        kind: 'brand-regression-lint-count',
        line: 1,
        text,
        expected: 'soup/no-brand-regression count from console/lint-shadow-baseline.json',
      },
    ]);
  });

  it('flags stale current Soup Kitchen label counters', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'conformance-manifest.md');
    const staleCount = currentSoupKitchenLabelCount + 1;
    const text = `Brand scope evidence: "Soup Kitchen" ×${staleCount} counter.`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentSoupKitchenLabelCount,
        claimed: staleCount,
        filePath: staleDoc,
        kind: 'soup-kitchen-label-count',
        line: 1,
        text,
        expected: 'Soup Kitchen label count from console/src and docs/console-guide.md',
      },
    ]);
  });

  it('flags stale backticked test-file count claims in current docs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'conformance-manifest.md');
    const staleCount = currentUseThemeTestCount + 1;
    const text = `Dark theme evidence: \`tests/console/use-theme.test.tsx\` (${staleCount} tests).`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentUseThemeTestCount,
        claimed: staleCount,
        filePath: staleDoc,
        kind: 'test-file-test-count',
        line: 1,
        text,
        expected: 'Vitest collected test count for tests/console/use-theme.test.tsx',
      },
    ]);
  });

  it('flags stale current design-regression check counts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'current-design.md');
    writeFileSync(staleDoc, 'The current design-enforcement run has design-regression 16 checks.\n', 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentDesignRegressionCheckCount,
        claimed: 16,
        filePath: staleDoc,
        kind: 'design-regression-check-count',
        line: 1,
        text: 'The current design-enforcement run has design-regression 16 checks.',
        expected: 'design-regression check count from console/scripts/design-regression.sh',
      },
    ]);
  });

  it('flags stale current design-regression blocking sets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'current-design.md');
    const missingCheck = currentDesignRegressionBlockingChecks[0] ?? 1;
    const extraCheck = Math.max(currentDesignRegressionCheckCount, ...currentDesignRegressionBlockingChecks) + 1;
    const staleBlockingSet = currentDesignRegressionBlockingChecks
      .map((check) => (check === missingCheck ? extraCheck : check))
      .join(' ');
    const text = `The current design-enforcement run has design-regression ${currentDesignRegressionCheckCount} checks with blocking set \`${staleBlockingSet}\` PASS.`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: missingCheck,
        claimed: 0,
        filePath: staleDoc,
        kind: 'design-regression-blocking-check',
        line: 1,
        text,
        expected: 'design-regression blocking check from console/scripts/design-regression.sh EXIT_ON_FAIL',
      },
      {
        actual: 0,
        claimed: extraCheck,
        filePath: staleDoc,
        kind: 'design-regression-blocking-check',
        line: 1,
        text,
        expected: 'no undocumented design-regression blocking check',
      },
    ]);
  });

  it('flags stale named blocking design-regression check counts and wrapped sets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'current-design.md');
    const firstCheck = currentDesignRegressionBlockingChecks[0] ?? 1;
    const extraCheck = Math.max(currentDesignRegressionCheckCount, ...currentDesignRegressionBlockingChecks) + 1;
    const firstLine = `The current design-enforcement run has all one blocking design-regression checks (${firstCheck},`;
    const secondLine = `${extraCheck}) PASS.`;
    const text = `${firstLine} ${secondLine}`;
    writeFileSync(staleDoc, `${firstLine}\n${secondLine}\n`, 'utf8');

    const issues = findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] });

    expect(issues).toContainEqual({
      actual: currentDesignRegressionBlockingChecks.length,
      claimed: 1,
      filePath: staleDoc,
      kind: 'design-regression-blocking-check-count',
      line: 1,
      text,
      expected: 'design-regression blocking check count from console/scripts/design-regression.sh EXIT_ON_FAIL',
    });
    for (const missingCheck of currentDesignRegressionBlockingChecks.filter((check) => check !== firstCheck)) {
      expect(issues).toContainEqual({
        actual: missingCheck,
        claimed: 0,
        filePath: staleDoc,
        kind: 'design-regression-blocking-check',
        line: 1,
        text,
        expected: 'design-regression blocking check from console/scripts/design-regression.sh EXIT_ON_FAIL',
      });
    }
    expect(issues).toContainEqual({
      actual: 0,
      claimed: extraCheck,
      filePath: staleDoc,
      kind: 'design-regression-blocking-check',
      line: 1,
      text,
      expected: 'no undocumented design-regression blocking check',
    });
    expect(issues).toHaveLength(currentDesignRegressionBlockingChecks.length + 1);
  });

  it('flags stale documented EXIT_ON_FAIL design-regression blocking sets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'lint-plan.md');
    const missingCheck = currentDesignRegressionBlockingChecks[0] ?? 1;
    const staleBlockingSet = currentDesignRegressionBlockingChecks
      .filter((check) => check !== missingCheck)
      .join(' ');
    const text = `Blocking set live in \`design-regression.sh\`: \`EXIT_ON_FAIL=(${staleBlockingSet})\`.`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: missingCheck,
        claimed: 0,
        filePath: staleDoc,
        kind: 'design-regression-blocking-check',
        line: 1,
        text,
        expected: 'design-regression blocking check from console/scripts/design-regression.sh EXIT_ON_FAIL',
      },
    ]);
  });

  it('flags stale current theme-parity token counts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'current-design.md');
    const staleThemeParityCount = currentThemeParityTokenCount - 1;
    const text = `The current design-enforcement run has theme parity ${staleThemeParityCount}.`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentThemeParityTokenCount,
        claimed: staleThemeParityCount,
        filePath: staleDoc,
        kind: 'theme-parity-token-count',
        line: 1,
        text,
        expected: 'theme parity token count from console/src/styles/tokens.semantic.css',
      },
    ]);
  });

  it('flags stale check-theme-parity.mjs token-count claims in current conformance docs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'conformance-manifest.md');
    const staleThemeParityCount = currentThemeParityTokenCount - 1;
    const text = `Dark theme evidence: \`console/scripts/check-theme-parity.mjs\` (${staleThemeParityCount} tokens both scopes).`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentThemeParityTokenCount,
        claimed: staleThemeParityCount,
        filePath: staleDoc,
        kind: 'theme-parity-token-count',
        line: 1,
        text,
        expected: 'theme parity token count from console/src/styles/tokens.semantic.css',
      },
    ]);
  });

  it('flags stale current design burndown summary counts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'current-design.md');
    const staleTotal = currentDesignBurndownSummary.total - 1;
    // +1 (not -1) so the stale fixture stays a parseable non-negative integer even
    // when the live blocking count is 0; the detector's count regex is \d+, so a
    // "-1 blocking" fixture would be unmatchable and the test would self-defeat.
    const staleBlocking = currentDesignBurndownSummary.blocking + 1;
    const text = `The current design-enforcement run has burndown ${staleTotal} total / ${staleBlocking} blocking.`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentDesignBurndownSummary.total,
        claimed: staleTotal,
        filePath: staleDoc,
        kind: 'design-burndown-total',
        line: 1,
        text,
        expected: 'design burndown total from console/design-burndown-queue.json',
      },
      {
        actual: currentDesignBurndownSummary.blocking,
        claimed: staleBlocking,
        filePath: staleDoc,
        kind: 'design-burndown-blocking-count',
        line: 1,
        text,
        expected: 'design burndown blocking count from console/design-burndown-queue.json',
      },
    ]);
  });

  it('flags stale current design guard test inventory counts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'current-design.md');
    const staleFileCount = currentDesignGuardTestInventory.fileCount - 1;
    const staleTestCount = currentDesignGuardTestInventory.testCount - 1;
    const text = `The current design-enforcement run has test:design-guards ${staleFileCount} files / ${staleTestCount} tests.`;
    writeFileSync(staleDoc, `${text}\n`, 'utf8');

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: currentDesignGuardTestInventory.fileCount,
        claimed: staleFileCount,
        filePath: staleDoc,
        kind: 'design-guard-test-file-count',
        line: 1,
        text,
        expected: 'test:design-guards file count from package.json',
      },
      {
        actual: currentDesignGuardTestInventory.testCount,
        claimed: staleTestCount,
        filePath: staleDoc,
        kind: 'design-guard-test-count',
        line: 1,
        text,
        expected: 'test:design-guards test count from Vitest list',
      },
    ]);
  });

  it('allows an explicit environment bypass for emergency pushes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-doc-drift-'));
    const staleDoc = path.join(dir, 'stale.md');
    writeFileSync(staleDoc, 'WhatSoup currently exposes 127 MCP tools.\n', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(run(['--doc', staleDoc], repoRoot, { WHATSOUP_SKIP_DOC_DRIFT: '1' })).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('doc drift check skipped via WHATSOUP_SKIP_DOC_DRIFT=1');
  });
});
