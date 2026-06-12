import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import categorizedSkips from '../../eslint-rules/categorized-skips.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('categorized-skips', categorizedSkips, {
  valid: [
    // Categorized with @skip-env on the line above.
    {
      code: `// @skip-env requires ffmpeg binary\nit.skip('transcodes', () => {});`,
    },
    // Categorized with @skip-timing trailing on the same line.
    {
      code: `it.skip('flaky sampler', () => {}); // @skip-timing sampler interval race`,
    },
    // skipIf categorized.
    {
      code: `// @skip-env CI only\nit.skipIf(!process.env.CI)('integration', () => {});`,
    },
    // A non-skip test is untouched.
    {
      code: `it('normal test', () => {});`,
    },
    // describe.skip categorized.
    {
      code: `// @skip-timing whole suite is load-dependent\ndescribe.skip('load suite', () => {});`,
    },
  ],
  invalid: [
    // Bare skip, no category comment.
    {
      code: `it.skip('no reason', () => {});`,
      errors: [{ messageId: 'uncategorized' }],
    },
    // Comment present but wrong tag (not a recognized category).
    {
      code: `// TODO fix later\ntest.skip('vague', () => {});`,
      errors: [{ messageId: 'uncategorized' }],
    },
    // skipIf without a category.
    {
      code: `it.skipIf(process.platform === 'win32')('posix only', () => {});`,
      errors: [{ messageId: 'uncategorized' }],
    },
  ],
});
