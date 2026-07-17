import { rmSync } from 'node:fs';
import { afterEach, describe } from 'vitest';

import { registerAttemptCases } from './verify-boundary-run/attempt-cases.ts';
import { registerCloseoutCases } from './verify-boundary-run/closeout-cases.ts';
import { registerJoinCases } from './verify-boundary-run/join-cases.ts';
import { registerSchemaCases } from './verify-boundary-run/schema-cases.ts';
import { fixtureRoots } from './verify-boundary-run/support.ts';
import { registerTransitionCases } from './verify-boundary-run/transition-cases.ts';

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('boundary run validator', () => {
  registerSchemaCases();
  registerAttemptCases();
  registerJoinCases();
  registerTransitionCases();
  registerCloseoutCases();
});
