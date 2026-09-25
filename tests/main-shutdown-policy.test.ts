import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shutdownExitCode } from '../src/main-shutdown-policy.ts';

describe('main shutdown exit policy', () => {
  it('returns zero only for operator-requested shutdown signals', () => {
    expect(shutdownExitCode('SIGINT')).toBe(0);
    expect(shutdownExitCode('SIGTERM')).toBe(0);
    expect(shutdownExitCode('uncaughtException')).toBe(1);
    expect(shutdownExitCode('unhandledRejection')).toBe(1);
    expect(shutdownExitCode('startupError')).toBe(1);
  });

  it('uses the shutdown signal to choose the actual process exit code', () => {
    const source = readFileSync('src/main.ts', 'utf8');

    expect(source).toContain("import { runShutdownSequence, shutdownExitCode, type ShutdownSequenceOutcome } from './main-shutdown-policy.ts';");
    expect(source).toContain('process.exit(shutdownExitCode(signal, outcome));');
    expect(source).not.toContain('process.exit(0);');
  });
});
