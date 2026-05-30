import { describe, expect, it } from 'vitest';

import { mergeNpmrcText } from '../../scripts/npmrc-merge.ts';

const hardened = [
  'registry=https://registry.npmjs.org/',
  'min-release-age=10080',
  'audit=true',
  'fund=false',
].join('\n');

describe('npmrc merge', () => {
  it('preserves local auth tokens and unmanaged settings', () => {
    const current = [
      '//registry.npmjs.org/:_authToken=KEEP_ME',
      'save-prefix=~',
      'fund=true',
    ].join('\n');

    expect(mergeNpmrcText(hardened, current)).toBe(
      [
        '//registry.npmjs.org/:_authToken=KEEP_ME',
        'save-prefix=~',
        'fund=false',
        'registry=https://registry.npmjs.org/',
        'min-release-age=10080',
        'audit=true',
        '',
      ].join('\n'),
    );
  });

  it('replaces only managed keys and keeps comments', () => {
    const current = [
      '# local registry auth',
      'registry=https://example.invalid/',
      'audit=false',
      '; local comment',
    ].join('\n');

    expect(mergeNpmrcText(hardened, current)).toBe(
      [
        '# local registry auth',
        'registry=https://registry.npmjs.org/',
        'audit=true',
        '; local comment',
        'min-release-age=10080',
        'fund=false',
        '',
      ].join('\n'),
    );
  });
});
