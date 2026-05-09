import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/connection.ts';
import { BaselineIntegrityError, BaselineStore, type BaselineStoreLogger } from '../../src/store/baseline.ts';

const KEY = Buffer.from('baseline-store-key');
const OTHER_KEY = Buffer.from('other-baseline-store-key');

const dbs: ReturnType<typeof openDatabase>[] = [];
interface CapturedLog {
  level: 'info' | 'error';
  payload: Record<string, string | number>;
  message: string | undefined;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function store(key = KEY): BaselineStore {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return new BaselineStore(db, key);
}

function storeWithLogger(logs: CapturedLog[], key = KEY): BaselineStore {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return new BaselineStore(db, key, { logger: captureLogger(logs) });
}

function captureLogger(out: CapturedLog[]): BaselineStoreLogger {
  return {
    info(payload, message) {
      out.push({ level: 'info', payload, message });
    },
    error(payload, message) {
      out.push({ level: 'error', payload, message });
    },
  };
}

function rowCount(store: BaselineStore): number {
  return (store.db.prepare('SELECT COUNT(*) AS count FROM baseline').get() as { count: number }).count;
}

function tamper(store: BaselineStore, sql: string, ...params: unknown[]): void {
  store.db.prepare(sql).run(...params);
}

describe('BaselineStore', () => {
  it('round-trips set/get with a valid HMAC', () => {
    const baselines = store();

    baselines.set({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"status":"ok"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
    });

    expect(baselines.get('probe.doc', 'scope-a')).toEqual({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"status":"ok"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
      hmac: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('refuses a tampered row distinctly from a missing row', () => {
    const baselines = store();
    baselines.set({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"status":"ok"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
    });
    tamper(baselines, 'UPDATE baseline SET expected_doc = ? WHERE probe_id = ? AND scope_id = ?', '{"status":"bad"}', 'probe.doc', 'scope-a');

    expect(baselines.get('missing.probe', 'scope-a')).toBeUndefined();
    expect(() => baselines.get('probe.doc', 'scope-a')).toThrow(BaselineIntegrityError);
    expect(() => baselines.get('probe.doc', 'scope-a')).toThrow(/baseline integrity failed/);
  });

  it('lists deterministic integrity failures for tampered content and malformed signatures', () => {
    const baselines = store();
    const entries = [
      ['probe.expected_doc', 'scope-a'],
      ['probe.captured_at', 'scope-a'],
      ['probe.short_hmac', 'scope-a'],
      ['probe.bad_hmac', 'scope-a'],
      ['probe.wrong_key', 'scope-a'],
    ] as const;

    for (const [probe_id, scope_id] of entries) {
      baselines.set({
        probe_id,
        scope_id,
        expected_doc: '{"status":"ok"}',
        captured_at: '2026-05-08T10:00:00.000Z',
        captured_by: 'fixture',
      });
    }

    const wrongKeyStore = new BaselineStore(baselines.db, OTHER_KEY);
    wrongKeyStore.set({
      probe_id: 'probe.wrong_key',
      scope_id: 'scope-a',
      expected_doc: '{"status":"ok"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
    });

    tamper(baselines, 'UPDATE baseline SET expected_doc = ? WHERE probe_id = ?', '{"status":"bad"}', 'probe.expected_doc');
    tamper(baselines, 'UPDATE baseline SET captured_at = ? WHERE probe_id = ?', '2026-05-08T10:00:01.000Z', 'probe.captured_at');
    tamper(baselines, 'UPDATE baseline SET hmac = ? WHERE probe_id = ?', 'abc123', 'probe.short_hmac');
    tamper(baselines, 'UPDATE baseline SET hmac = ? WHERE probe_id = ?', 'z'.repeat(64), 'probe.bad_hmac');

    expect(baselines.listIntegrityFailures()).toEqual([
      { probe_id: 'probe.bad_hmac', scope_id: 'scope-a' },
      { probe_id: 'probe.captured_at', scope_id: 'scope-a' },
      { probe_id: 'probe.expected_doc', scope_id: 'scope-a' },
      { probe_id: 'probe.short_hmac', scope_id: 'scope-a' },
      { probe_id: 'probe.wrong_key', scope_id: 'scope-a' },
    ]);
  });

  it('overwrites the same probe and scope including the HMAC', () => {
    const baselines = store();
    baselines.set({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"version":1}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture-a',
    });
    const first = baselines.db.prepare('SELECT hmac FROM baseline WHERE probe_id = ? AND scope_id = ?').get('probe.doc', 'scope-a') as {
      hmac: string;
    };

    baselines.set({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"version":2}',
      captured_at: '2026-05-08T11:00:00.000Z',
      captured_by: 'fixture-b',
    });

    const second = baselines.db.prepare('SELECT hmac FROM baseline WHERE probe_id = ? AND scope_id = ?').get('probe.doc', 'scope-a') as {
      hmac: string;
    };
    expect(rowCount(baselines)).toBe(1);
    expect(second.hmac).not.toBe(first.hmac);
    expect(baselines.get('probe.doc', 'scope-a')).toEqual({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"version":2}',
      captured_at: '2026-05-08T11:00:00.000Z',
      captured_by: 'fixture-b',
      hmac: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('emits safe store-boundary logs for set, integrity failure, and clear', () => {
    const logs: CapturedLog[] = [];
    const baselines = storeWithLogger(logs);

    baselines.set({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"status":"ok"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
    });
    tamper(baselines, 'UPDATE baseline SET expected_doc = ? WHERE probe_id = ? AND scope_id = ?', '{"status":"bad"}', 'probe.doc', 'scope-a');
    expect(() => baselines.get('probe.doc', 'scope-a')).toThrow(BaselineIntegrityError);
    baselines.clear('scope-a');

    expect(logs.map((log) => log.payload.event)).toEqual([
      'baseline_row_set',
      'baseline_integrity_fail',
      'baseline_clear',
    ]);
    expect(logs.every((log) => log.payload.component === 'store.baseline')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('baseline-store-key');
  });

  it('keeps the same probe isolated across scopes and reports only the tampered scope', () => {
    const baselines = store();
    for (const scope_id of ['scope-a', 'scope-b']) {
      baselines.set({
        probe_id: 'probe.doc',
        scope_id,
        expected_doc: `{"scope":"${scope_id}"}`,
        captured_at: '2026-05-08T10:00:00.000Z',
        captured_by: 'fixture',
      });
    }

    tamper(baselines, 'UPDATE baseline SET expected_doc = ? WHERE probe_id = ? AND scope_id = ?', '{"scope":"tampered"}', 'probe.doc', 'scope-b');

    expect(baselines.get('probe.doc', 'scope-a')?.expected_doc).toBe('{"scope":"scope-a"}');
    expect(baselines.listIntegrityFailures()).toEqual([{ probe_id: 'probe.doc', scope_id: 'scope-b' }]);
  });

  it('keeps probes isolated within the same scope', () => {
    const baselines = store();
    baselines.set({
      probe_id: 'probe.a',
      scope_id: 'scope-a',
      expected_doc: '{"probe":"a"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
    });
    baselines.set({
      probe_id: 'probe.b',
      scope_id: 'scope-a',
      expected_doc: '{"probe":"b"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
    });

    expect(baselines.get('probe.a', 'scope-a')?.expected_doc).toBe('{"probe":"a"}');
    expect(baselines.get('probe.b', 'scope-a')?.expected_doc).toBe('{"probe":"b"}');
  });

  it('returns undefined for a missing row without creating a baseline', () => {
    const baselines = store();

    expect(baselines.get('missing.probe', 'scope-a')).toBeUndefined();
    expect(rowCount(baselines)).toBe(0);
  });

  it('clears only rows for the requested scope', () => {
    const baselines = store();
    for (const scope_id of ['scope-a', 'scope-b']) {
      baselines.set({
        probe_id: 'probe.doc',
        scope_id,
        expected_doc: `{"scope":"${scope_id}"}`,
        captured_at: '2026-05-08T10:00:00.000Z',
        captured_by: 'fixture',
      });
    }

    baselines.clear('scope-a');

    expect(baselines.get('probe.doc', 'scope-a')).toBeUndefined();
    expect(baselines.get('probe.doc', 'scope-b')?.expected_doc).toBe('{"scope":"scope-b"}');
  });

  it('fails closed for empty or whitespace HMAC keys', () => {
    const baselines = store();
    baselines.set({
      probe_id: 'probe.doc',
      scope_id: 'scope-a',
      expected_doc: '{"status":"ok"}',
      captured_at: '2026-05-08T10:00:00.000Z',
      captured_by: 'fixture',
    });

    expect(() =>
      new BaselineStore(baselines.db, Buffer.from('   \n\t')).set({
        probe_id: 'probe.whitespace-key',
        scope_id: 'scope-a',
        expected_doc: '{"status":"ok"}',
        captured_at: '2026-05-08T10:00:00.000Z',
        captured_by: 'fixture',
      }),
    ).toThrow(/HMAC key/);
    expect(new BaselineStore(baselines.db, Buffer.alloc(0)).listIntegrityFailures()).toEqual([
      { probe_id: 'probe.doc', scope_id: 'scope-a' },
    ]);
  });
});
