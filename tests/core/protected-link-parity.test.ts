/**
 * TypeScript side of the protected-link parity corpus. The Python port in
 * deploy/scripts/lib/bot_errors_redaction.py runs the same rows in
 * deploy/scripts/tests/test_bot_errors_protected_link_parity.py.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeProtectedMessageText } from '../../src/core/protected-message.ts';
import {
  TEST_DELIVERY_HOST,
  TEST_LINK_HOST,
  TEST_PROTECTED_DELIVERY_PINS,
} from '../helpers/protected-delivery-pins.ts';

interface ParityCorpus {
  linkHosts: string[];
  cases: Array<{ id: string; input: string; expected: string }>;
}

const corpus = JSON.parse(
  readFileSync(new URL('../fixtures/protected-link-parity-corpus.json', import.meta.url), 'utf8'),
) as ParityCorpus;

describe('protected-link parity corpus (TypeScript scanner)', () => {
  it('pins the same neutral hosts as the test pins', () => {
    expect(corpus.linkHosts).toEqual([TEST_LINK_HOST, TEST_DELIVERY_HOST]);
  });

  it.each(corpus.cases)('$id', ({ input, expected }) => {
    expect(sanitizeProtectedMessageText(input, TEST_PROTECTED_DELIVERY_PINS)).toBe(expected);
  });
});
