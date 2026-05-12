import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { run as runDocDrift } from '../../scripts/doc-drift-check.ts';
import { run as runPublicSurfaceDrift } from '../../scripts/public-surface-drift-check.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function makeStaleDoc(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-drift-ci-gate-'));
  const staleDoc = path.join(dir, 'stale.md');
  writeFileSync(staleDoc, 'WhatSoup currently exposes 127 MCP tools.\n', 'utf8');
  return staleDoc;
}

function makeStalePublicSurfaceRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-pub-ci-gate-'));
  const docsDir = path.join(root, 'docs');
  mkdirSync(docsDir, { recursive: true });
  // Empty registry + no source — guaranteed to produce some issue or nothing,
  // but the key signal is whether `run` returned [] (skipped) or executed.
  // We only assert on console warn shape + run completion.
  writeFileSync(
    path.join(docsDir, 'public-surface.md'),
    '| Identifier | Source | Script |\n| --- | --- | --- |\n',
    'utf8',
  );
  return root;
}

describe('drift skip env flags — CI gating (issue #472)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  describe('doc-drift-check', () => {
    it('honors WHATSOUP_SKIP_DOC_DRIFT locally (no CI env)', () => {
      const staleDoc = makeStaleDoc();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const issues = runDocDrift(
        ['--doc', staleDoc],
        repoRoot,
        { WHATSOUP_SKIP_DOC_DRIFT: '1' },
      );

      expect(issues).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('doc drift check skipped'),
      );
    });

    it('IGNORES WHATSOUP_SKIP_DOC_DRIFT when CI=true and runs the check', () => {
      const staleDoc = makeStaleDoc();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const issues = runDocDrift(
        ['--doc', staleDoc],
        repoRoot,
        { WHATSOUP_SKIP_DOC_DRIFT: '1', CI: 'true' },
      );

      // The stale doc must produce a drift issue — proving the check ran.
      expect(issues.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
      // Loud warning that the skip was ignored.
      const warnMessages = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnMessages).toMatch(/ignor|refus|CI/i);
      expect(warnMessages).toMatch(/WHATSOUP_SKIP_DOC_DRIFT/);
    });

    it('IGNORES WHATSOUP_SKIP_DOC_DRIFT when GITHUB_ACTIONS is set and runs the check', () => {
      const staleDoc = makeStaleDoc();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const issues = runDocDrift(
        ['--doc', staleDoc],
        repoRoot,
        { WHATSOUP_SKIP_DOC_DRIFT: '1', GITHUB_ACTIONS: 'true' },
      );

      expect(issues.length).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
      const warnMessages = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnMessages).toMatch(/WHATSOUP_SKIP_DOC_DRIFT/);
    });
  });

  describe('public-surface-drift-check', () => {
    it('honors WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT locally (no CI env)', () => {
      const root = makeStalePublicSurfaceRoot();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const issues = runPublicSurfaceDrift(
        [],
        root,
        { WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT: '1' },
      );

      expect(issues).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('public surface drift check skipped'),
      );
    });

    it('IGNORES WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT when CI=true and runs the check', () => {
      const root = makeStalePublicSurfaceRoot();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      runPublicSurfaceDrift(
        [],
        root,
        { WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT: '1', CI: 'true' },
      );

      // Whether issues are produced depends on synthetic fixtures, but the
      // loud "ignored in CI" warning must fire — proving the gate works.
      const warnMessages = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnMessages).toMatch(/WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT/);
      expect(warnMessages).toMatch(/ignor|refus|CI/i);
      // And it must NOT short-circuit with the plain "skipped" message.
      expect(warnMessages).not.toMatch(
        /^public surface drift check skipped via WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT=1$/m,
      );
    });

    it('IGNORES WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT when GITHUB_ACTIONS is set', () => {
      const root = makeStalePublicSurfaceRoot();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      runPublicSurfaceDrift(
        [],
        root,
        { WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT: '1', GITHUB_ACTIONS: 'true' },
      );

      const warnMessages = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnMessages).toMatch(/WHATSOUP_SKIP_PUBLIC_SURFACE_DRIFT/);
      expect(warnMessages).toMatch(/ignor|refus|CI/i);
    });
  });
});
