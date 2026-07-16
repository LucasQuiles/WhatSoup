/**
 * Static policy coverage for critical structured log fields.
 *
 * These tests intentionally read production source to pin logging keys and
 * lifecycle messages that would otherwise regress silently without invasive
 * runtime harnesses for every failure path.
 *
 * test-integrity: source-string-ok
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('critical path logging coverage', () => {
  it('runtime critical paths emit structured lifecycle logs', async () => {
    const source = await readFile(new URL('../../../src/runtimes/agent/runtime.ts', import.meta.url), 'utf8');

    expect(source).toContain("'AgentRuntime started'");
    expect(source).toContain('instanceName: this.instanceName');
    expect(source).toContain("'control session crashed'");
    expect(source).toContain('reportId: crashedReportId');
    expect(source).toContain("'resetting session and queue for /new'");
    expect(source).toContain("'created outbound queue'");
    expect(source).toContain("'provider event rejected before runtime effects'");
    expect(source).toContain("'workspace resources stopped in shutdown'");
    expect(source).toContain('workspaceSocketServersStopped');
    expect(source).toContain("'context recovery turn failed after resume failure'");
    expect(source).toContain('delayMs');
    expect(source).toContain("'scheduling auto-respawn'");
    expect(source).toContain('sessionId: status.sessionId');
    expect(source).toContain('pid: status.pid');
  });

  it('session critical paths emit structured logs for spawn-per-turn and stderr', async () => {
    const source = await readFile(new URL('../../../src/runtimes/agent/session.ts', import.meta.url), 'utf8');

    expect(source).toContain("'spawn-per-turn session armed'");
    expect(source).toContain("'claude stderr'");
    expect(source).toContain("'provider stderr'");
    expect(source).toContain('provider: this.provider');
    expect(source).toContain('chatJid: this.chatJid');
    expect(source).toContain('pid: child.pid ?? null');
  });

  it('session-db backfill emits summary logging', async () => {
    const source = await readFile(new URL('../../../src/runtimes/agent/session-db.ts', import.meta.url), 'utf8');

    expect(source).toContain("'backfilled workspace keys'");
    expect(source).toContain('processed: rows.length');
    expect(source).toContain('ended:');
    expect(source).toContain('updated:');
  });
});
