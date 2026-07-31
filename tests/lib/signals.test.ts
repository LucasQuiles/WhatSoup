import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SIGNAL } from '../../src/lib/signals.ts';

describe('SIGNAL constants', () => {
  it('pins the POSIX signal-name values (#2643)', () => {
    expect(SIGNAL.TERM).toBe('SIGTERM');
    expect(SIGNAL.KILL).toBe('SIGKILL');
  });

  // Regression guard for #2643: the whole point of the abstraction is that
  // callers reference SIGNAL.TERM/SIGNAL.KILL instead of bare string
  // literals, so a future edit can't silently reintroduce a literal at one
  // of the known call sites without this test catching it.
  it('is the only source of SIGTERM/SIGKILL literals at the known call sites', () => {
    const bareLiteral = /(['"])SIG(TERM|KILL)\1/;

    const platform = readFileSync('src/fleet/platform.ts', 'utf8');
    expect(platform).toContain("import { SIGNAL } from '../lib/signals.ts';");
    expect(platform).toContain('child.kill(SIGNAL.TERM);');
    expect(platform).toContain('child.kill(SIGNAL.KILL);');
    expect(bareLiteral.test(platform)).toBe(false);

    const ops = readFileSync('src/fleet/routes/ops.ts', 'utf8');
    expect(ops).toContain("import { SIGNAL } from '../../lib/signals.ts';");
    expect(ops).toContain("existing.kill(SIGNAL.TERM);");
    expect(ops).toContain('child.kill(SIGNAL.TERM);');
    expect(ops).toContain('child.kill(SIGNAL.KILL);');
    expect(bareLiteral.test(ops)).toBe(false);

    const binaryPreflight = readFileSync('src/runtimes/agent/providers/binary-preflight.ts', 'utf8');
    expect(binaryPreflight).toContain("import { SIGNAL } from '../../../lib/signals.ts';");
    expect(binaryPreflight).toContain('child.kill(SIGNAL.KILL);');
    expect(bareLiteral.test(binaryPreflight)).toBe(false);

    const processTree = readFileSync('src/runtimes/agent/process-tree.ts', 'utf8');
    expect(processTree).toContain("import { SIGNAL } from '../../lib/signals.ts';");
    expect(processTree).toContain('signal === SIGNAL.TERM');
    expect(processTree).toContain("signalOwned(target, rootPid, kill.rows, kill.survivors, SIGNAL.KILL,");
    expect(bareLiteral.test(processTree)).toBe(false);
  });
});
