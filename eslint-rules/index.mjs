/**
 * Local ESLint plugin for WhatSoup architectural-fitness custom rules.
 *
 * These rules implement the AST-detectable registry rules whose `rings` include
 * `eslint` and which no built-in rule covers. They are wired by
 * `eslint.config.fitness.mjs`, which sets severities from the registry (all
 * `warn`). See docs/architecture/fitness-taxonomy.md.
 */

import godClass from './god-class.mjs';
import categorizedSkips from './categorized-skips.mjs';
import failClosedScanner from './fail-closed-scanner.mjs';
import outboxDirectWrite from './outbox-direct-write.mjs';
import approvedApiClient from './approved-api-client.mjs';
import ringBoundaries from './ring-boundaries.mjs';
import unsafeTypeEscape from './unsafe-type-escape.mjs';
import timerRearmWithoutClear from './timer-rearm-without-clear.mjs';
import noMagicSqlitePragma from './no-magic-sqlite-pragma.mjs';
import requireCatchJustification from './require-catch-justification.mjs';
import noRawFleetError from './no-raw-fleet-error.mjs';
import fetchTimeout from './fetch-timeout.mjs';
import syncExecTimeout from './sync-exec-timeout.mjs';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: 'eslint-plugin-fitness', version: '0.1.0' },
  rules: {
    'god-class': godClass,
    'categorized-skips': categorizedSkips,
    'fail-closed-scanner': failClosedScanner,
    'outbox-direct-write': outboxDirectWrite,
    'approved-api-client': approvedApiClient,
    'ring-boundaries': ringBoundaries,
    'unsafe-type-escape': unsafeTypeEscape,
    'timer-rearm-without-clear': timerRearmWithoutClear,
    'no-magic-sqlite-pragma': noMagicSqlitePragma,
    'require-catch-justification': requireCatchJustification,
    'no-raw-fleet-error': noRawFleetError,
    'fetch-timeout': fetchTimeout,
    'sync-exec-timeout': syncExecTimeout,
  },
};

export default plugin;
