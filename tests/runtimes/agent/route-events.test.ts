/**
 * Fail-closed route-event + delegation-receipt sidecar tests (slice-2 B3
 * minimal shape; slice-4 full taxonomy, validation, retention, receipts):
 * append-only NDJSON, dir auto-creation, degrade-to-warn on an unwritable
 * sink, invalid events NOT written (UH-018), size-bounded rotation, and a
 * schema guard that events carry no message bodies or sender identities.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import {
  deriveChatScope,
  emitDelegationReceipt,
  emitRouteEvent,
  type DelegationReceipt,
  type ModelRouteEvent,
  type RouteEventType,
} from '../../../src/runtimes/agent/route-events.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';

function ev(overrides: Partial<ModelRouteEvent> = {}): ModelRouteEvent {
  return {
    ts: 1_700_000_000_000,
    event: 'runtime_selected',
    instance: 'test',
    conversationKey: '15550000001',
    chatScope: 'dm',
    provider: 'claude-cli',
    modelRef: null,
    source: 'user',
    authority: 'advisory_only',
    userVisible: false,
    reasonCode: 'user_pin',
    ...overrides,
  };
}

function receipt(overrides: Partial<DelegationReceipt> = {}): DelegationReceipt {
  return {
    ts: 1_700_000_000_000,
    instance: 'test',
    conversationKey: '15550000001',
    delegationUsed: true,
    reason: 'user-requested-review',
    workers: ['reviewer'],
    modelsOrHarnesses: ['opencode-cli'],
    authority: 'advisory_only',
    leadVerified: true,
    userVisibleSummary: 'I double-checked the risky part with a reviewer model.',
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

  it('accepts every event type in the slice-4 taxonomy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    const types: RouteEventType[] = [
      'runtime_selected', 'runtime_switched', 'model_preference_set',
      'model_preference_cleared', 'auto_fallback_started', 'auto_fallback_cleared',
      'user_pin_unreachable', 'delegation_started', 'delegation_finished',
      'approval_required',
    ];
    for (const t of types) emitRouteEvent(dir, ev({ event: t }), warn);
    const lines = readFileSync(join(dir, 'route-events.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(types.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects an out-of-taxonomy event WITHOUT writing it (UH-018)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitRouteEvent(dir, ev({ event: 'root_granted' as RouteEventType }), warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('rejected');
    expect(existsSync(join(dir, 'route-events.ndjson'))).toBe(false);
  });

  it('rejects an empty provider and a non-advisory authority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitRouteEvent(dir, ev({ provider: '' }), warn);
    emitRouteEvent(dir, ev({ authority: 'owner' as 'advisory_only' }), warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, 'route-events.ndjson'))).toBe(false);
  });

  it('rejects an unknown source, an empty instance, and an empty reasonCode — none written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitRouteEvent(dir, ev({ source: 'root' as ModelRouteEvent['source'] }), warn);
    emitRouteEvent(dir, ev({ instance: '' }), warn);
    emitRouteEvent(dir, ev({ reasonCode: '' }), warn);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(existsSync(join(dir, 'route-events.ndjson'))).toBe(false);
  });

  it('rotates the sink to a single .1 generation past the byte cap (bounded retention)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    const line = JSON.stringify(ev()).length + 1;
    emitRouteEvent(dir, ev(), warn, line * 2);
    emitRouteEvent(dir, ev(), warn, line * 2);
    emitRouteEvent(dir, ev(), warn, line * 2); // pre-append size 2*line < cap? no: 2*line == cap, not > cap
    emitRouteEvent(dir, ev(), warn, line * 2); // pre-append size 3*line > cap -> rotate
    const main = readFileSync(join(dir, 'route-events.ndjson'), 'utf8').trim().split('\n');
    const rotated = readFileSync(join(dir, 'route-events.ndjson.1'), 'utf8').trim().split('\n');
    expect(rotated).toHaveLength(3);
    expect(main).toHaveLength(1);
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

  it('the WRITTEN event carries route metadata only — no bodies, no sender identities', () => {
    // Assert on the serialized sidecar line (what actually persists), not the
    // in-test factory: the emit path must never widen the on-disk shape nor
    // carry an identity/body field, whatever the interface later gains.
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitRouteEvent(dir, ev(), warn);
    const written = JSON.parse(
      readFileSync(join(dir, 'route-events.ndjson'), 'utf8').trim(),
    ) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([
      'authority', 'chatScope', 'conversationKey', 'event', 'instance',
      'modelRef', 'provider', 'reasonCode', 'source', 'ts', 'userVisible',
    ]);
    for (const forbidden of ['senderJid', 'sender', 'body', 'text', 'message', 'phone']) {
      expect(written).not.toHaveProperty(forbidden);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('deriveChatScope', () => {
  it('maps null to instance, a REAL group conversationKey to group, everything else to dm (R9)', () => {
    expect(deriveChatScope(null)).toBe('instance');
    // Feed the value the runtime actually produces — toConversationKey
    // serializes a group as "<local>_at_g.us" (never "@g.us"). The prior test
    // fed a raw "@g.us" JID the runtime never passes, masking the suffix bug.
    expect(toConversationKey('111222333@g.us')).toBe('111222333_at_g.us');
    expect(deriveChatScope(toConversationKey('111222333@g.us'))).toBe('group');
    expect(deriveChatScope('111222333_at_g.us')).toBe('group');
    expect(deriveChatScope(toConversationKey('15550000001@s.whatsapp.net'))).toBe('dm');
    expect(deriveChatScope('15550000001')).toBe('dm');
  });
});

describe('emitDelegationReceipt', () => {
  it('writes a valid receipt to its own sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitDelegationReceipt(dir, receipt(), warn);
    const lines = readFileSync(join(dir, 'delegation-receipts.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).authority).toBe('advisory_only');
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a receipt without a user-visible summary (observability-incomplete, UH-017)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitDelegationReceipt(dir, receipt({ userVisibleSummary: '  ' }), warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, 'delegation-receipts.ndjson'))).toBe(false);
  });

  it('rejects empty workers, unknown reasons, and non-advisory authority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitDelegationReceipt(dir, receipt({ workers: [] }), warn);
    emitDelegationReceipt(dir, receipt({ reason: 'because' as DelegationReceipt['reason'] }), warn);
    emitDelegationReceipt(dir, receipt({ authority: 'executor' as 'advisory_only' }), warn);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(existsSync(join(dir, 'delegation-receipts.ndjson'))).toBe(false);
  });

  it('rejects a receipt with an empty instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-ev-'));
    const warn = vi.fn();
    emitDelegationReceipt(dir, receipt({ instance: '' }), warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, 'delegation-receipts.ndjson'))).toBe(false);
  });
});
