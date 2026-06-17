import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import approvedApiClient from '../../eslint-rules/approved-api-client.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run('approved-api-client', approvedApiClient, {
  valid: [
    // The typed API client owns raw fetch.
    {
      filename: '/repo/console/src/lib/api.ts',
      code: `export async function request(path: string) { return fetch(path); }`,
    },
    // Components are fine when they call an imported client method instead.
    {
      filename: '/repo/console/src/components/UpdateModal.tsx',
      code: `import { api } from '../lib/api.ts';\nexport function UpdateModal() { void api.getVersion(); return <div />; }`,
    },
    // Backend fetches are governed by separate runtime/client rules.
    {
      filename: '/repo/src/fleet/http-proxy.ts',
      code: `export async function proxy(path: string) { return fetch(path); }`,
    },
  ],
  invalid: [
    {
      filename: '/repo/console/src/components/UpdateModal.tsx',
      code: `export async function runUpdate() { return fetch('/api/update', { method: 'POST' }); }`,
      errors: [{ messageId: 'directFetch' }],
    },
    {
      filename: '/repo/console/src/pages/Operator.tsx',
      code: `export const load = () => fetch('/api/lines');`,
      errors: [{ messageId: 'directFetch' }],
    },
  ],
});
