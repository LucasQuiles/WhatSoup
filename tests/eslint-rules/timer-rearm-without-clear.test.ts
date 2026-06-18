import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import timerRearmWithoutClear from '../../eslint-rules/timer-rearm-without-clear.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('timer-rearm-without-clear', timerRearmWithoutClear, {
  valid: [
    // Guarded: retrieves + clears the existing entry before re-arming.
    {
      code: `function onStart(map, key) {
        const prev = map.get(key);
        if (prev) clearTimeout(prev.timer);
        map.set(key, { timer: setTimeout(() => {}, 5) });
      }`,
    },
    // Guarded via a clear* helper call.
    {
      code: `function arm(map, key) {
        this.clearOperationTimers(map.get(key));
        map.set(key, { slowTimer: setInterval(() => {}, 5) });
      }`,
    },
    // Value object holds no timer — not the target pattern.
    {
      code: `function f(map, key) { map.set(key, { name: 'x', count: 1 }); }`,
    },
    // Plain set of a non-object value.
    {
      code: `function f(map, key, value) { map.set(key, value); }`,
    },
    // Field-assigned timer (out of scope — proxy-flag guards like isTyping are fine).
    {
      code: `function startTyping() { if (this.isTyping) return; this.isTyping = true; this.refresh = setInterval(() => {}, 8000); }`,
    },
  ],
  invalid: [
    // The bug shape: stores a timer in the map value, no clear/get guard in the function.
    {
      code: `function onToolStart(map, key) {
        map.set(key, { progressTimer: setInterval(() => {}, 30000), slowTimer: setTimeout(() => {}, 9000) });
      }`,
      errors: [{ messageId: 'unguarded' }],
    },
    // Single setTimeout in the value object, no guard.
    {
      code: `function arm(map, key) { map.set(key, { t: setTimeout(() => {}, 5) }); }`,
      errors: [{ messageId: 'unguarded' }],
    },
  ],
});
