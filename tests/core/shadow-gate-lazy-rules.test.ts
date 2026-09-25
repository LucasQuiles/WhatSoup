/**
 * The shadow-gate rules file is loaded lazily: importing ingest (mode off) never
 * reads it, a load failure is latched (read once, then every evaluation throws
 * without re-reading), and the rules hash is total (a sentinel when unreadable).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  const logger = singletonLoggerMock();
  return { createChildLogger: () => logger };
});

// Records every readFileSync path; the array survives vi.resetModules().
const reads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    reads.paths.push(String(path));
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  SHADOW_GATE_RULES_PATH,
  UNREADABLE_RULES_SHA256,
  getRulesSha256,
  shadowGate,
  warmShadowRules,
  __setShadowRulesPathForTests,
} from '../../src/core/shadow-gate.ts';
import type { ShadowGateInput } from '../../src/core/shadow-gate-features.ts';
import { getShadowGateRecorder, __resetShadowGateForTests } from '../../src/core/shadow-gate-adapter.ts';
import { Database } from '../../src/core/database.ts';

const tmp = trackTmpDirs('shadow-gate-lazy-');

afterEach(() => {
  __setShadowRulesPathForTests(null);
});

const GROUP_TEXT: ShadowGateInput = {
  chatKind: 'group', isOwner: false, isBotSender: false, mentionedSelf: false, isControlChat: false,
  contentType: 'text', quoted: false, text: 'ok', truncated: false, contextStatus: 'known',
  pendingObligation: false, featureVersion: 1,
};

describe('lazy shadow-gate rules', () => {
  it('importing ingest does not read the rules file; first use does', async () => {
    vi.resetModules();
    reads.paths.length = 0;
    await import('../../src/core/ingest.ts');
    expect(reads.paths).not.toContain(SHADOW_GATE_RULES_PATH);

    // Non-vacuity: the freshly imported module does read it on first use.
    const fresh = await import('../../src/core/shadow-gate.ts');
    expect(fresh.shadowGate(GROUP_TEXT)).toEqual({ verdict: 'SUPPRESS', ruleId: 'X02_STATUS_ONLY' });
    expect(reads.paths).toContain(SHADOW_GATE_RULES_PATH);
  });

  it('a corrupt rules file is read once, then every evaluation throws without re-reading', () => {
    const corrupt = join(tmp.make('corrupt'), 'rules.json');
    writeFileSync(corrupt, '{ not json');
    __setShadowRulesPathForTests(corrupt);
    reads.paths.length = 0;

    expect(warmShadowRules()).toBe(false);
    expect(() => shadowGate(GROUP_TEXT)).toThrow('shadow-gate rules unavailable');
    expect(() => shadowGate(GROUP_TEXT)).toThrow('shadow-gate rules unavailable');
    expect(reads.paths.filter((p) => p === corrupt)).toHaveLength(1);

    // The hash is independent of compilation: readable bytes still hash.
    expect(getRulesSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(getRulesSha256()).not.toBe(UNREADABLE_RULES_SHA256);
  });

  it('an unreadable rules file hashes to the 64-zero sentinel and never throws', () => {
    __setShadowRulesPathForTests(join(tmp.make('missing'), 'absent.json'));
    expect(getRulesSha256()).toBe(UNREADABLE_RULES_SHA256);
    expect(UNREADABLE_RULES_SHA256).toMatch(/^0{64}$/);
    expect(warmShadowRules()).toBe(false);
  });

  it('once loaded, the hash describes the compiled bytes, not the file as it is now', () => {
    const file = join(tmp.make('onceread'), 'rules.json');
    const shipped = readFileSync(SHADOW_GATE_RULES_PATH);
    writeFileSync(file, shipped);
    __setShadowRulesPathForTests(file);
    reads.paths.length = 0;
    expect(warmShadowRules()).toBe(true);
    // Rewrite the file after loading: the hash must not follow it.
    writeFileSync(file, `${shipped.toString('utf8')}\n`);
    expect(getRulesSha256()).toBe(createHash('sha256').update(shipped).digest('hex'));
    // One read serves both the compiled rules and the hash.
    expect(reads.paths.filter((p) => p === file)).toHaveLength(1);
  });

  it('the recorder takes its rules hash after warming, from that same single read', async () => {
    const file = join(tmp.make('recorder-hash'), 'rules.json');
    const shipped = readFileSync(SHADOW_GATE_RULES_PATH);
    writeFileSync(file, shipped);
    __setShadowRulesPathForTests(file);
    reads.paths.length = 0;
    const eventsDir = join(tmp.make('recorder-events'), 'events');
    const db = new Database(':memory:');
    db.open();
    try {
      expect(getShadowGateRecorder(db, {
        shadowGate: { mode: 'shadow', eventsDir },
        botName: 'q',
        adminPhones: new Set<string>(),
        siblingPhones: new Set<string>(),
        botErrorsJid: null,
      })).not.toBeNull();
      expect(reads.paths.filter((p) => p === file)).toHaveLength(1);
      await __resetShadowGateForTests();
      const armed = JSON.parse(readFileSync(join(eventsDir, 'shadow-gate-events.000001.ndjson'), 'utf8').split('\n')[0]!) as {
        marker: string; rulesSha256: string;
      };
      expect(armed.marker).toBe('armed');
      expect(armed.rulesSha256).toBe(createHash('sha256').update(shipped).digest('hex'));
    } finally {
      await __resetShadowGateForTests();
      db.close();
    }
  });

  it('before the first load the hash is read directly and not memoised', () => {
    const file = join(tmp.make('prehash'), 'rules.json');
    writeFileSync(file, 'one');
    __setShadowRulesPathForTests(file);
    expect(getRulesSha256()).toBe(createHash('sha256').update('one').digest('hex'));
    writeFileSync(file, 'two');
    expect(getRulesSha256()).toBe(createHash('sha256').update('two').digest('hex'));
  });

  it('restoring the shipped path recovers', () => {
    __setShadowRulesPathForTests(join(tmp.make('gone'), 'absent.json'));
    expect(warmShadowRules()).toBe(false);
    __setShadowRulesPathForTests(null);
    expect(warmShadowRules()).toBe(true);
    expect(shadowGate(GROUP_TEXT).ruleId).toBe('X02_STATUS_ONLY');
  });
});
