/**
 * Custom-endpoint argv routing for opencode-cli sessions.
 *
 * When `providerConfig.baseUrl` is configured, the opencode config writer
 * merges a custom provider block into opencode.json and sets its top-level
 * `model` to `<providerId>/<model>`. For that block to actually route, the
 * session must NOT pass `-m <model>` — an explicit `-m` overrides the config
 * file and re-routes the turn to opencode's own catalog, leaving the custom
 * endpoint inert. So: baseUrl present → omit `-m` (opencode resolves the model
 * from opencode.json); baseUrl absent → `-m` behavior unchanged (regression
 * pin); non-opencode providers ignore baseUrl in argv entirely.
 *
 * Covers both argv construction paths:
 *  - resolveProviderArgs (via the __provider_switch_for_test handle), and
 *  - the live spawn-per-turn path (SessionManager.sendTurn → spawn argv).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 7),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
  backfillSessionProvider: vi.fn(),
}));

// Deterministic credentials — the spawn-per-turn path builds a child env that
// would otherwise consult the host keychain.
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: vi.fn(() => null),
  };
});

import { spawn } from 'node:child_process';
import {
  SessionManager,
  __provider_switch_for_test,
} from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

function makeMockChild(pid = 4242) {
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdin.write = vi.fn(
    (_data: unknown, enc?: unknown, cb?: (err?: Error | null) => void) => {
      if (typeof enc === 'function') (enc as (err?: Error | null) => void)();
      else if (typeof cb === 'function') cb();
    },
  );
  stdin.end = vi.fn();
  return {
    pid,
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    on: vi.fn(),
  };
}

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

const CHAT_JID = 'custom-endpoint@s.whatsapp.net';
const BASE_URL_CONFIG = { baseUrl: 'https://api.cloud.example/v1' };

describe('resolveProviderArgs — opencode-cli custom endpoint omits -m', () => {
  const getArgs = (providerConfig?: Record<string, unknown>, model: string | undefined = 'MiniMax-M2') =>
    __provider_switch_for_test.getProviderArgs(
      'opencode-cli',
      'sys',
      '/cwd',
      undefined,
      model,
      [],
      providerConfig,
    );

  it('omits -m when providerConfig.baseUrl is set and a model is configured', () => {
    const args = getArgs(BASE_URL_CONFIG);
    expect(args).not.toContain('-m');
    expect(args).not.toContain('MiniMax-M2');
    // The rest of the argv contract is unchanged.
    expect(args).toEqual(['run', '--format', 'json', '--pure']);
  });

  it('keeps -m when no baseUrl is configured (regression pin)', () => {
    expect(getArgs(undefined)).toEqual(['run', '--format', 'json', '--pure', '-m', 'MiniMax-M2']);
    expect(getArgs({})).toEqual(['run', '--format', 'json', '--pure', '-m', 'MiniMax-M2']);
  });

  it('ignores a blank baseUrl (no silent -m drop on a value the validator rejects)', () => {
    expect(getArgs({ baseUrl: '   ' })).toEqual(['run', '--format', 'json', '--pure', '-m', 'MiniMax-M2']);
  });

  it('leaves non-opencode provider argv unchanged when a baseUrl is present', () => {
    const args = __provider_switch_for_test.getProviderArgs(
      'claude-cli',
      'sys',
      '/cwd',
      undefined,
      'opus',
      [],
      BASE_URL_CONFIG,
    );
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });
});

describe('SessionManager spawn-per-turn — opencode-cli custom endpoint omits -m', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(makeMockChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function spawnTurnArgs(providerConfig?: Record<string, unknown>): Promise<string[]> {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'MiniMax-M2',
      providerConfig,
    });
    await sm.spawnSession();
    await sm.sendTurn('hello there');
    const call = (spawn as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[0]).toBe('opencode');
    return call?.[1] as string[];
  }

  it('omits -m from the per-turn argv when providerConfig.baseUrl is set', async () => {
    const args = await spawnTurnArgs(BASE_URL_CONFIG);
    expect(args).not.toContain('-m');
    expect(args).not.toContain('MiniMax-M2');
    // The prompt and run flags still ship.
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--pure']);
    expect(args.at(-1)).toContain('hello there');
  });

  it('keeps -m in the per-turn argv without a baseUrl (regression pin)', async () => {
    const args = await spawnTurnArgs(undefined);
    const mIdx = args.indexOf('-m');
    expect(mIdx).toBeGreaterThan(-1);
    expect(args[mIdx + 1]).toBe('MiniMax-M2');
  });
});
