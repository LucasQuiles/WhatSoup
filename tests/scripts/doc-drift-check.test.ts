import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findDocDrift,
  findRawFormControlInventory,
  findToolRegistrations,
  run,
} from '../../scripts/doc-drift-check.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const currentToolCount = findToolRegistrations(repoRoot).length;
const currentRawFormControlInventory = findRawFormControlInventory(repoRoot);

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
        .replace('| [substrate.ts](#substratets) | 19 |', '| [substrate.ts](#substratets) | 18 |')
        .replace('| **Total** | **162** |', '| **Total** | **160** |'),
      'utf8',
    );

    const staleLines = readFileSync(staleDoc, 'utf8').split(/\r?\n/);
    const substrateLine =
      staleLines.findIndex((line) => line === '| [substrate.ts](#substratets) | 18 |') + 1;
    const totalLine =
      staleLines.findIndex((line) => line === '| **Total** | **160** |') + 1;

    expect(findDocDrift({ cwd: repoRoot, docPaths: [staleDoc] })).toEqual([
      {
        actual: 19,
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
        actual: currentRawFormControlInventory.consumerMigrations,
        claimed: 28,
        filePath: staleDoc,
        kind: 'raw-form-control-inventory',
        line: 3,
        expected: 'raw form-control consumer migrations from console/design-raw-form-control-inventory.json',
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
