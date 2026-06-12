import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import outboxDirectWrite from '../../eslint-rules/outbox-direct-write.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('outbox-direct-write', outboxDirectWrite, {
  valid: [
    // The dominant clean shape: path derived from the resolver in the same fn.
    {
      code: `function write() { const outbox = resolveBotErrorsOutbox().outbox; writeFileSync(join(outbox, 'bot-errors', name), payload); }`,
    },
    // Resolver referenced directly in the path argument.
    {
      code: `function write() { writeFileSync(join(botErrorsOutboxDir(), 'state', name), payload); }`,
    },
    // outboxResolution binding (the writeBotErrorsEvent shape).
    {
      code: `function write(outboxResolution) { const outbox = outboxResolution.outbox; appendFileSync(join(outbox, 'bot-errors'), x); }`,
    },
    // A write to some unrelated path — not the outbox sentinel.
    {
      code: `function log() { appendFileSync('/var/log/app.log', line); }`,
    },
    // A write to a config path that mentions neither outbox nor state.
    {
      code: `function save() { writeFileSync(join(homedir(), '.config', 'app.json'), data); }`,
    },
  ],
  invalid: [
    // Hardcoded slash-form outbox path, no resolver — fails open into PROD.
    {
      code: `function leak() { writeFileSync(join(homedir(), '.local/state/bot-errors/outbox', name), payload); }`,
      errors: [{ messageId: 'directWrite' }],
    },
    // Hardcoded joined-segment outbox path, no resolver.
    {
      code: `function leak() { appendFileSync(join(homedir(), '.local', 'state', 'bot-errors', 'outbox', name), x); }`,
      errors: [{ messageId: 'directWrite' }],
    },
    // createWriteStream to the outbox state dir, no resolver.
    {
      code: `function leak() { createWriteStream(join(base, '.local/state/bot-errors/outbox/e.json')); }`,
      errors: [{ messageId: 'directWrite' }],
    },
  ],
});
