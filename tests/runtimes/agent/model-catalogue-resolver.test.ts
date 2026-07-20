/**
 * Tests for the per-harness catalogue resolver (CONFIG-MODEL-RENDER-SPEC.md).
 * Both underlying probes are injected; the module-level opencode cache is reset
 * between cases. nowMs is injected so the cache + as-of are deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveModelCatalogue,
  formatCaptureAsOf,
  __resetModelCatalogueCacheForTest,
} from '../../../src/runtimes/agent/model-catalogue-resolver.ts';

beforeEach(() => {
  __resetModelCatalogueCacheForTest();
});

const T0 = 1_000_000; // arbitrary fixed clock base

describe('formatCaptureAsOf', () => {
  it('renders "just now" under a minute, "Nm ago" under an hour, "Nh ago (stale)" beyond', () => {
    expect(formatCaptureAsOf(T0, T0 + 30_000)).toBe('just now');
    expect(formatCaptureAsOf(T0, T0 + 4 * 60_000)).toBe('4m ago');
    expect(formatCaptureAsOf(T0, T0 + 3 * 60 * 60_000)).toBe('3h ago (stale)');
  });
});

describe('resolveModelCatalogue — opencode-cli', () => {
  const okList = (ids: string[]) => vi.fn().mockResolvedValue({ status: 'ok', ids });

  it('returns ok with the opencode source label on a fresh probe and caches it', async () => {
    const listFn = okList(['minimax/MiniMax-M2', 'deepseek/deepseek-chat']);
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['minimax/MiniMax-M2', 'deepseek/deepseek-chat'],
      sourceLabel: 'opencode CLI',
      asOfLabel: 'just now',
    });
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  it('serves the cache within TTL without re-spawning', async () => {
    const listFn = okList(['a', 'b']);
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0 + 30_000, listFn });
    expect(out.status).toBe('ok');
    expect(listFn).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('re-probes after the TTL expires', async () => {
    const listFn = okList(['a']);
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0 + 61_000, listFn });
    expect(listFn).toHaveBeenCalledTimes(2);
  });

  it('maps a probe timeout (no cache) to the timeout reason', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'timeout' });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'timeout' }, asOfLabel: 'just now' });
  });

  it('maps a spawn-error (no cache) to probe-failed', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'spawn-error' });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'probe-failed' }, asOfLabel: 'just now' });
  });

  it('maps an empty probe (no cache) to empty', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'empty' });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'empty' }, asOfLabel: 'just now' });
  });

  it('flags output with a space as unparseable (no cache)', async () => {
    const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['| Model | ID |', 'Fable 5 claude-fable-5'] });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'unparseable' }, asOfLabel: 'just now' });
  });

  it('serves a stale cache (with disclosed age) when a later re-probe fails', async () => {
    const listFn = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', ids: ['a', 'b'] })              // T0: fresh
      .mockResolvedValueOnce({ status: 'unavailable', reason: 'timeout' });  // T0+5m: reprobe fails
    await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0, listFn });
    const out = await resolveModelCatalogue('opencode-cli', 'opencode', { nowMs: T0 + 5 * 60_000, listFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['a', 'b'],
      sourceLabel: 'opencode CLI',
      asOfLabel: '5m ago',
    });
  });
});

describe('resolveModelCatalogue — claude-cli', () => {
  it('returns no-key when the anthropic key is absent', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'no-key' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'no-key' }, asOfLabel: 'just now' });
  });

  it('labels the org catalogue as its source, not "what this harness runs"', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({
      status: 'ok',
      ids: ['claude-opus-4-8', 'claude-sonnet-5'],
      sourceLabel: 'anthropic /v1/models (org catalogue)',
      asOfLabel: 'just now',
    });
  });

  it('maps credential-expired → credential-expired (benign self-healing transient)', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'credential-expired' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'credential-expired' }, asOfLabel: 'just now' });
  });

  it('maps unauthorized → key-rejected', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'failed', category: 'unauthorized' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'key-rejected' }, asOfLabel: 'just now' });
  });

  it('maps timeout → timeout', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'failed', category: 'timeout' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'timeout' }, asOfLabel: 'just now' });
  });

  it('maps lookup-failed → lookup-failed', async () => {
    const anthropicFn = vi.fn().mockResolvedValue({ status: 'failed', category: 'lookup-failed' });
    const out = await resolveModelCatalogue('claude-cli', 'claude', { nowMs: T0, anthropicFn });
    expect(out).toStrictEqual({ status: 'unavailable', reason: { kind: 'lookup-failed' }, asOfLabel: 'just now' });
  });
});

describe('resolveModelCatalogue — unadapted harness', () => {
  it('names the harness in a no-adapter reason', async () => {
    const out = await resolveModelCatalogue('codex-cli', 'codex', { nowMs: T0 });
    expect(out).toStrictEqual({
      status: 'unavailable',
      reason: { kind: 'no-adapter', harness: 'codex-cli' },
      asOfLabel: 'just now',
    });
  });
});
