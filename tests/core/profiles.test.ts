import { describe, expect, it } from 'vitest';
import { applyProfile } from '../../src/core/profiles.ts';

describe('applyProfile', () => {
  it('leaves text unchanged when the profile is empty', () => {
    expect(applyProfile('hi', {})).toBe('hi');
  });

  it('prepends a configured prefix', () => {
    expect(applyProfile('hi', { prefix: '[BES] ' })).toBe('[BES] hi');
  });

  it('appends a configured tag', () => {
    expect(applyProfile('hi', { tag: ' #notify' })).toBe('hi #notify');
  });
});
