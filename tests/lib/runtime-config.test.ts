// tests/lib/runtime-config.test.ts
// Tests for the typed env accessors (#2192).
// Verifies envStr/envBool/envInt/envStrOpt handle set, unset, empty, and
// malformed values with the documented semantics.
import { afterEach, describe, expect, it } from 'vitest';

import { envStr, envBool, envInt, envStrOpt } from '../../src/lib/runtime-config.ts';

const TEST_KEY = 'WHATSOUP_TEST_RUNTIME_CONFIG_KEY';

afterEach(() => {
  delete process.env[TEST_KEY];
});

describe('runtime-config accessors (#2192)', () => {
  describe('envStr', () => {
    it('returns the env value when set and non-empty', () => {
      process.env[TEST_KEY] = '0.0.0.0';
      expect(envStr(TEST_KEY, '127.0.0.1')).toBe('0.0.0.0');
    });

    it('returns the fallback when the env var is unset', () => {
      delete process.env[TEST_KEY];
      expect(envStr(TEST_KEY, '127.0.0.1')).toBe('127.0.0.1');
    });

    it('returns the fallback when the env var is an empty string', () => {
      process.env[TEST_KEY] = '';
      expect(envStr(TEST_KEY, '127.0.0.1')).toBe('127.0.0.1');
    });
  });

  describe('envBool', () => {
    it('returns true for "1"', () => {
      process.env[TEST_KEY] = '1';
      expect(envBool(TEST_KEY, false)).toBe(true);
    });

    it('returns true for "true" (case-insensitive)', () => {
      process.env[TEST_KEY] = 'TRUE';
      expect(envBool(TEST_KEY, false)).toBe(true);
    });

    it('returns false for "0"', () => {
      process.env[TEST_KEY] = '0';
      expect(envBool(TEST_KEY, true)).toBe(false);
    });

    it('returns false for "false"', () => {
      process.env[TEST_KEY] = 'false';
      expect(envBool(TEST_KEY, true)).toBe(false);
    });

    it('returns the fallback for a non-boolean string', () => {
      process.env[TEST_KEY] = 'maybe';
      expect(envBool(TEST_KEY, true)).toBe(true);
    });

    it('returns the fallback when unset', () => {
      delete process.env[TEST_KEY];
      expect(envBool(TEST_KEY, false)).toBe(false);
    });
  });

  describe('envInt', () => {
    it('parses a valid integer', () => {
      process.env[TEST_KEY] = '8080';
      expect(envInt(TEST_KEY, 3000)).toBe(8080);
    });

    it('returns the fallback for NaN', () => {
      process.env[TEST_KEY] = 'not-a-number';
      expect(envInt(TEST_KEY, 3000)).toBe(3000);
    });

    it('returns the fallback when unset', () => {
      delete process.env[TEST_KEY];
      expect(envInt(TEST_KEY, 3000)).toBe(3000);
    });
  });

  describe('envStrOpt', () => {
    it('returns the value when set and non-empty', () => {
      process.env[TEST_KEY] = 'abc123';
      expect(envStrOpt(TEST_KEY)).toBe('abc123');
    });

    it('returns undefined when unset', () => {
      delete process.env[TEST_KEY];
      expect(envStrOpt(TEST_KEY)).toBeUndefined();
    });

    it('returns undefined when set to empty string', () => {
      process.env[TEST_KEY] = '';
      expect(envStrOpt(TEST_KEY)).toBeUndefined();
    });
  });
});
