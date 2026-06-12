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

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: 'eslint-plugin-fitness', version: '0.1.0' },
  rules: {
    'god-class': godClass,
    'categorized-skips': categorizedSkips,
    'fail-closed-scanner': failClosedScanner,
    'outbox-direct-write': outboxDirectWrite,
  },
};

export default plugin;
