import { describe, expect, it } from 'vitest';
import { isPathWithinAllowedRoot } from '../../src/lib/path-boundary.ts';

describe('isPathWithinAllowedRoot', () => {
  it('returns true when path equals allowed root exactly', () => {
    const root = '/tmp/allowed';
    expect(isPathWithinAllowedRoot('/tmp/allowed', root)).toBe(true);
  });

  it('returns true when path is a child of allowed root', () => {
    const root = '/tmp/allowed';
    expect(isPathWithinAllowedRoot('/tmp/allowed/subdir', root)).toBe(true);
  });

  it('returns true when path is deeply nested under allowed root', () => {
    const root = '/tmp/allowed';
    expect(isPathWithinAllowedRoot('/tmp/allowed/a/b/c/d', root)).toBe(true);
  });

  it('returns false when path is not under allowed root', () => {
    const root = '/tmp/allowed';
    expect(isPathWithinAllowedRoot('/tmp/other', root)).toBe(false);
  });

  it('returns false when path is a sibling of allowed root', () => {
    const root = '/tmp/allowed';
    expect(isPathWithinAllowedRoot('/tmp/allowed_other', root)).toBe(false);
  });

  it('returns false when allowed root is undefined', () => {
    expect(isPathWithinAllowedRoot('/tmp/path', undefined)).toBe(false);
  });

  it('returns false when allowed root is empty string', () => {
    expect(isPathWithinAllowedRoot('/tmp/path', '')).toBe(false);
  });

  it('returns false when path is parent of allowed root', () => {
    const root = '/tmp/allowed/subdir';
    expect(isPathWithinAllowedRoot('/tmp/allowed', root)).toBe(false);
  });

  it('handles absolute paths correctly', () => {
    const root = '/tmp/test-project';
    expect(isPathWithinAllowedRoot('/tmp/test-project/src', root)).toBe(true);
    expect(isPathWithinAllowedRoot('/tmp/test', root)).toBe(false);
  });

  it('distinguishes between similar path prefixes', () => {
    const root = '/tmp/test';
    expect(isPathWithinAllowedRoot('/tmp/test_other', root)).toBe(false);
    expect(isPathWithinAllowedRoot('/tmp/test/file', root)).toBe(true);
  });
});
