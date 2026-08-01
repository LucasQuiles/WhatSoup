import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// @ts-expect-error -- local ESLint rule is a .mjs module with no type declarations; expires 2026-12-31
import ringBoundaries from '../../eslint-rules/ring-boundaries.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run('ring-boundaries', ringBoundaries, {
  valid: [
    // Composition can depend on lower rings.
    {
      filename: '/repo/src/fleet/index.ts',
      code: `import { toConversationKey } from '../core/conversation-key.ts';`,
    },
    // Runtime/adapters can depend on domain/shared contracts.
    {
      filename: '/repo/src/runtimes/chat/runtime.ts',
      code: `import type { IncomingMessage } from '../../core/types.ts';`,
    },
    // Domain can depend on shared primitives.
    {
      filename: '/repo/src/core/ingest.ts',
      code: `import { isAdminPhone } from '../lib/phone.ts';`,
    },
    // External packages are outside this project ring check.
    {
      filename: '/repo/src/core/database.ts',
      code: `import path from 'node:path';\nimport { z } from 'zod';`,
    },
  ],
  invalid: [
    {
      // Illustrative fixture — domain (core) may not reach up into
      // composition (fleet), regardless of which fleet module is targeted.
      filename: '/repo/src/core/message-parser.ts',
      code: `import { someFleetHelper } from '../fleet/some-fleet-module.ts';`,
      errors: [{ messageId: 'invalidRing' }],
    },
    {
      filename: '/repo/src/lib/http.ts',
      code: `import type { FleetDiscovery } from '../fleet/discovery.ts';`,
      errors: [{ messageId: 'invalidRing' }],
    },
    {
      // Illustrative fixture — adapter (transport) may not reach up into
      // composition (fleet), regardless of which fleet module is targeted.
      filename: '/repo/src/transport/connection.ts',
      code: `import { someFleetHelper } from '../fleet/some-fleet-module.ts';`,
      errors: [{ messageId: 'invalidRing' }],
    },
  ],
});
