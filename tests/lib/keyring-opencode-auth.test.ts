// BE-G3 gap 1: credential PRESENCE pre-flight must consult opencode's own
// auth.json. opencode-backed fallback providers (minimax/deepseek/glm/…) store
// their key in ~/.local/share/opencode/auth.json, NOT in WhatSoup's keyring/env.
// Without reading it, pre-flight emits a false `fallback_credential_missing`
// even though the opencode session would authenticate fine.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock the platform keyring before importing the module. The shared helper's
// execFileSync returns an empty buffer (keyring miss), so lookupCredential
// deterministically reaches its terminal opencode fallback.
import { vi } from 'vitest';
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../helpers/child-process.ts');
  return childProcessMock();
});

import {
  readOpenCodeAuthKey,
  lookupCredential,
  _setOpenCodeAuthDirForTests,
  _setFileStoreDirForTests,
  _resetBackendCache,
} from '../../src/lib/keyring.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const originalPlatform = process.platform;
let openCodeDir: string;
let storeDir: string;

function writeAuth(json: unknown): void {
  fs.writeFileSync(path.join(openCodeDir, 'auth.json'), JSON.stringify(json), { mode: 0o600 });
}

describe('opencode auth.json credential fallback (BE-G3)', () => {
  beforeEach(() => {
    _resetBackendCache();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    openCodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auth-'));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fs-'));
    _setOpenCodeAuthDirForTests(openCodeDir);
    _setFileStoreDirForTests(storeDir);
    delete process.env.MINIMAX_API_KEY;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    _setOpenCodeAuthDirForTests(null);
    _setFileStoreDirForTests(null);
    fs.rmSync(openCodeDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  describe('readOpenCodeAuthKey', () => {
    it('returns the trimmed key for a present provider', () => {
      writeAuth({ minimax: { type: 'api', key: '  mm-secret-123  ' }, glm: { type: 'api', key: 'glm-k' } });
      expect(readOpenCodeAuthKey('minimax')).toBe('mm-secret-123');
      expect(readOpenCodeAuthKey('glm')).toBe('glm-k');
    });

    it('returns null for a provider absent from auth.json', () => {
      writeAuth({ minimax: { type: 'api', key: 'mm' } });
      expect(readOpenCodeAuthKey('deepseek')).toBeNull();
    });

    it('returns null when the file is missing', () => {
      expect(readOpenCodeAuthKey('minimax')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      fs.writeFileSync(path.join(openCodeDir, 'auth.json'), '{ not valid json', { mode: 0o600 });
      expect(readOpenCodeAuthKey('minimax')).toBeNull();
    });

    it('returns null when the entry has no usable key', () => {
      writeAuth({ minimax: { type: 'api' }, glm: { type: 'api', key: '   ' }, deepseek: 'not-an-object' });
      expect(readOpenCodeAuthKey('minimax')).toBeNull();
      expect(readOpenCodeAuthKey('glm')).toBeNull();
      expect(readOpenCodeAuthKey('deepseek')).toBeNull();
    });
  });

  describe('lookupCredential terminal fallback', () => {
    it('resolves an opencode provider key when env/keyring/file-store all miss', () => {
      writeAuth({ minimax: { type: 'api', key: 'mm-from-opencode' } });
      expect(lookupCredential('minimax')).toBe('mm-from-opencode');
    });

    it('returns null when neither WhatSoup stores nor opencode have the key', () => {
      writeAuth({ glm: { type: 'api', key: 'glm-k' } });
      expect(lookupCredential('minimax')).toBeNull();
    });

    it('prefers the WhatSoup file store over opencode auth.json (precedence)', () => {
      fs.writeFileSync(path.join(storeDir, 'minimax.key'), 'mm-from-filestore', { mode: 0o600 });
      writeAuth({ minimax: { type: 'api', key: 'mm-from-opencode' } });
      expect(lookupCredential('minimax')).toBe('mm-from-filestore');
    });

    it('excludes the unscoped file for a user-scoped lookup and reaches opencode auth.json', () => {
      fs.writeFileSync(path.join(storeDir, 'minimax.key'), 'mm-from-unscoped-file', { mode: 0o600 });
      writeAuth({ minimax: { type: 'api', key: 'mm-from-opencode' } });

      expect(lookupCredential('minimax', { user: 'bot', skipEnv: true })).toBe('mm-from-opencode');
    });

    it('does not leak opencode keys for an unrelated service not in auth.json', () => {
      writeAuth({ minimax: { type: 'api', key: 'mm' } });
      expect(lookupCredential('some-unrelated-service')).toBeNull();
    });
  });
});
