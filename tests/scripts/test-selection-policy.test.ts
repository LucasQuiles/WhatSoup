import { describe, expect, it } from 'vitest';

import { classifyTestChanges } from '../../scripts/lib/test-selection-policy.ts';

const everyLane = {
  root: true,
  console: true,
  browser: true,
  python: true,
  guard: true,
  docker: true,
  compatibility: true,
};

describe('classifyTestChanges', () => {
  it('marks approved prose-only changes as docs and schedules no application lane', () => {
    const result = classifyTestChanges(['README.md', 'docs/getting-started.md']);

    expect(result).toEqual({
      profile: 'docs',
      changedFiles: ['README.md', 'docs/getting-started.md'],
      reasons: ['documentation-only change; no application lane selected; static validation remains required'],
      lanes: {
        root: false,
        console: false,
        browser: false,
        python: false,
        guard: false,
        docker: false,
        compatibility: false,
      },
    });
  });

  it('does not classify instruction or operational documentation as docs-only', () => {
    for (const changedPath of [
      'AGENTS.md',
      'docs/runbooks/recovery.md',
      'docs/configuration.md',
      'docs/quality-policy.md',
    ]) {
      const result = classifyTestChanges([changedPath]);

      expect(result.profile).toBe('full');
      expect(result.lanes).toEqual(everyLane);
    }
  });

  it('selects console, browser, root, and compatibility lanes for console source', () => {
    const result = classifyTestChanges(['console/src/components/App.tsx']);

    expect(result.profile).toBe('affected');
    expect(result.lanes).toEqual({
      root: true,
      console: true,
      browser: true,
      python: false,
      guard: false,
      docker: false,
      compatibility: true,
    });
  });

  it('selects only root and compatibility lanes for ordinary src/lib and src/memory source', () => {
    const result = classifyTestChanges(['src/lib/format-duration.ts', 'src/memory/cache.ts']);

    expect(result.profile).toBe('affected');
    expect(result.lanes).toEqual({
      root: true,
      console: false,
      browser: false,
      python: false,
      guard: false,
      docker: false,
      compatibility: true,
    });
  });

  it('ignores approved documentation when it accompanies an ordinary library change', () => {
    const result = classifyTestChanges(['docs/getting-started.md', 'src/lib/format-duration.ts']);

    expect(result.profile).toBe('affected');
    expect(result.lanes).toEqual({
      root: true,
      console: false,
      browser: false,
      python: false,
      guard: false,
      docker: false,
      compatibility: true,
    });
  });

  it('uses the standalone guard lane for the Whatsoup guard tool matrix', () => {
    const result = classifyTestChanges(['tools/whatsoup_guard/check_policy.ts']);

    expect(result.profile).toBe('affected');
    expect(result.lanes).toEqual({
      root: false,
      console: false,
      browser: false,
      python: false,
      guard: true,
      docker: false,
      compatibility: false,
    });
  });

  it('fails broad for non-Node files in the guard tool and guard configuration inputs', () => {
    for (const changedPath of [
      'tools/whatsoup_guard/check_policy.py',
      'tools/whatsoup_guard/check_config.ts',
      'tools/whatsoup_guard/dependency-policy.ts',
      'tools/whatsoup_guard/check_policy.test.ts',
    ]) {
      const result = classifyTestChanges([changedPath]);

      expect(result.profile).toBe('full');
      expect(result.lanes).toEqual(everyLane);
    }
  });

  it('selects full validation for high-risk paths and names', () => {
    for (const changedPath of [
      'package-lock.json',
      '.github/workflows/quality.yml',
      'scripts/required-suites.ts',
      'deploy/scripts/release.sh',
      'src/runtimes/agent.ts',
      'src/lib/token-migration.ts',
      'src/lib/credential-store.ts',
      'src/lib/agent-capability.ts',
      'src/memory/journal.ts',
      'src/lib/private-fs.ts',
      'src/lib/request-ssrf.ts',
      'src/lib/sqlite-store.ts',
      'src/lib/process-lock.ts',
      'src/lib/transaction.ts',
      'src/lib/redact.ts',
      'tools/whatsoup_guard/src/hmac.ts',
      'src/lib/crypto.ts',
      'src/lib/bot-errors-outbox.ts',
      'src/lib/alert-evidence.ts',
    ]) {
      const result = classifyTestChanges([changedPath]);

      expect(result.profile).toBe('full');
      expect(result.lanes).toEqual(everyLane);
    }
  });

  it('fails broad for empty, unsafe, fixture, and unknown inputs', () => {
    for (const changedPath of ['', '../src/lib/format-duration.ts', '/tmp/change.ts', 'src/fixture/input.ts', 'assets/logo.svg']) {
      const result = classifyTestChanges(changedPath ? [changedPath] : []);

      expect(result.profile).toBe('full');
      expect(result.lanes).toEqual(everyLane);
    }
  });
});
