import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import failClosedScanner from '../../eslint-rules/fail-closed-scanner.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('fail-closed-scanner', failClosedScanner, {
  valid: [
    // Rethrows — fail closed.
    {
      code: `function scan() { try { return parse(); } catch (e) { throw e; } }`,
    },
    // Sets process.exitCode — fail closed.
    {
      code: `function scan() { try { return parse(); } catch (e) { process.exitCode = 1; return []; } }`,
    },
    // Emits an issue (push) then returns empty — author surfaced it.
    {
      code: `function scan(issues) { try { return parse(); } catch (e) { issues.push(e); return []; } }`,
    },
    // console.error before empty return — surfaced.
    {
      code: `function scan() { try { return parse(); } catch (e) { console.error(e); return []; } }`,
    },
    // Structured logger error before empty return — surfaced in runtime health/logs.
    {
      code: `const log = { error() {} }; function scan() { try { return parse(); } catch (e) { log.error(e); return []; } }`,
    },
    // Returns a NON-empty fallback — deliberate, not the fail-open shape.
    {
      code: `function scan() { try { return parse(); } catch (e) { return [{ code: 'parse-error' }]; } }`,
    },
    // Catch with no return at all.
    {
      code: `function scan() { try { doThing(); } catch (e) { /* ignore tick */ } }`,
    },
  ],
  invalid: [
    // Silent empty array — fail open.
    {
      code: `function scan() { try { return parse(); } catch (e) { return []; } }`,
      errors: [{ messageId: 'failOpen' }],
    },
    // Silent empty object — fail open.
    {
      code: `function scan() { try { return parse(); } catch (e) { return {}; } }`,
      errors: [{ messageId: 'failOpen' }],
    },
    // Silent empty Map — fail open.
    {
      code: `function scan() { try { return load(); } catch (e) { return new Map(); } }`,
      errors: [{ messageId: 'failOpen' }],
    },
  ],
});
