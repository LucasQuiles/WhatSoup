/**
 * Fail-closed route-event sidecar tests (slice-2 B3): append-only NDJSON,
 * dir auto-creation, degrade-to-warn on an unwritable sink, and a schema
 * guard that the event shape carries no message bodies or raw sender JIDs.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { emitRouteEvent, type ModelRouteEvent } from '../../../src/runtimes/agent/route-events.ts';

function ev(overrides: Partial<ModelRouteEvent> = {}): ModelRouteEvent {
  return {
    ts: 1_700_000_000_000,
    event: 'runtime_selected',
    instance: 'test',
    conversationKey: '15550000001',
    provider: 'claude-cli',
    modelRef: null,
    source: 'user',
    reasonCode: 'user_pin',
    ...overrides,
  };
}

describe('emitRouteEvent', () => {
  it('appends one NDJSON line per event and creates the sink dir', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'route-ev-')), 'nested');
    const warn = vi.fn();
    emitRouteEvent(dir, ev(), warn);
    emitRouteEvent(dir, ev({ event: 'model_preference_cleared', source: 'default', reasonCode: 'user_reset' }), warn);
    const lines = readFileSync(join(dir, 'route-events.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].event).toBe('runtime_selected');
    expect(parsed[1].reasonCode).toBe('user_reset');
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws and degrades to warn when the sink is unwritable (fail-closed for the turn)', () => {
    const base = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const fileAsDir = join(base, 'blocker');
    writeFileSync(fileAsDir, 'x');
    const warn = vi.fn();
    expect(() => emitRouteEvent(join(fileAsDir, 'sub'), ev(), warn)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('the event schema carries route metadata only — no bodies, no sender JIDs', () => {
    expect(Object.keys(ev()).sort()).toEqual([
      'conversationKey', 'event', 'instance', 'modelRef', 'provider', 'reasonCode', 'source', 'ts',
    ]);
  });
});
