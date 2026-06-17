import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import unsafeTypeEscape from '../../eslint-rules/unsafe-type-escape.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('unsafe-type-escape', unsafeTypeEscape, {
  valid: [
    {
      code: `function parse(input: unknown): string | null { return typeof input === 'string' ? input : null; }`,
    },
    {
      code: `interface Payload { id: string }\nconst value = input as Payload;`,
    },
    {
      code: `type Handler = (input: unknown) => Promise<void>;`,
    },
  ],
  invalid: [
    {
      code: `function parse(input: any): string { return String(input); }`,
      errors: [{ messageId: 'anyType' }],
    },
    {
      code: `const value = input as any;`,
      errors: [{ messageId: 'anyType' }],
    },
    {
      code: `// @ts-ignore -- fixture suppression should still be reported; expires 2026-12-31\nrunLegacyThing();`,
      errors: [{ messageId: 'suppression' }],
    },
    {
      code: `// @ts-nocheck -- fixture suppression should still be reported; expires 2026-12-31\nexport const unchecked = true;`,
      errors: [{ messageId: 'suppression' }],
    },
  ],
});
