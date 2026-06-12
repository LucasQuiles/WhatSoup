import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import godClass from '../../eslint-rules/god-class.mjs';

// Wire RuleTester to vitest's lifecycle (the adapter expects these globals).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

// Tiny thresholds so fixtures stay readable: a "god class" here is >3 lines AND
// >2 methods. The composite (AND) is what we are proving.
const options = [{ maxClassLines: 3, maxMethods: 2 }];

// Helper: a class body with `n` trivial methods, each on its own line.
function classWith(methodCount: number, name = 'C'): string {
  const methods = Array.from({ length: methodCount }, (_, i) => `  m${i}() {}`).join('\n');
  return `class ${name} {\n${methods}\n}`;
}

ruleTester.run('god-class', godClass, {
  valid: [
    // Under both thresholds: 2 methods (<=2), short.
    { code: classWith(2), options },
    // Long but few methods: many lines via blank padding, only 1 method.
    {
      code: `class Big {\n\n\n\n\n\n  only() {}\n}`,
      options,
    },
    // Many methods but short span is impossible to express without lines, so the
    // inverse single-threshold case: exactly at maxMethods (2) — not exceeded.
    { code: classWith(2, 'AtLimit'), options },
  ],
  invalid: [
    {
      // 5 methods (>2) AND ~7 lines (>3): both thresholds exceeded.
      code: classWith(5, 'GodClass'),
      options,
      errors: [{ messageId: 'godClass' }],
    },
  ],
});
