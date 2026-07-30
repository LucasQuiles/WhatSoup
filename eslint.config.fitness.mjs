/**
 * ESLint flat config for the architectural-fitness ring.
 *
 * This config enforces ONLY the registry rules whose `rings` include `eslint`.
 * It is intentionally separate from any general lint config: it is the
 * `eslint` ring of the fitness program, not a style adoption. It is consumed by
 * `scripts/eslint-fitness-check.ts` (the `guard:lint:src` wrapper), which runs
 * under `node --experimental-strip-types` so the `.ts` registry import resolves.
 *
 * Single source of truth: rule selection + thresholds derive from
 * `scripts/lib/fitness/registry.ts`. A drift test
 * (`tests/scripts/eslint-fitness-check.test.ts`) asserts this config enforces
 * exactly the registry's eslint-ring rule set, all at `warn` severity.
 *
 * Severity is `warn` for every rule (see the design doc): it makes
 * the known violations (e.g. the AgentRuntime god-class) visible without
 * breaking CI, and keeps `arch.file-size`'s blocking authority in the guard/ci
 * ring (meta.no-redundant-gates).
 */

import tseslint from 'typescript-eslint';

import fitnessPlugin from './eslint-rules/index.mjs';
import { fitnessRules } from './scripts/lib/fitness/registry.ts';

const ESLINT_RING = fitnessRules.filter((rule) => rule.rings.includes('eslint'));

// Map each registry rule id → the ESLint rule entry that enforces it. Built-in
// rules for the mechanical one; the local `fitness/*` plugin for the AST ones.
// Every entry is 'warn'.
function ruleEntriesFor(id) {
  const rule = ESLINT_RING.find((r) => r.id === id);
  if (!rule) return {};
  switch (id) {
    case 'arch.file-size':
      return { 'max-lines': ['warn', { max: rule.params?.maxLines ?? 2000, skipBlankLines: false, skipComments: false }] };
    case 'arch.god-class':
      return {
        'fitness/god-class': [
          'warn',
          { maxClassLines: rule.params?.maxClassLines ?? 1200, maxMethods: rule.params?.maxMethods ?? 80 },
        ],
      };
    case 'invariant.fail-closed-scanner':
      return { 'fitness/fail-closed-scanner': 'warn' };
    case 'invariant.outbox-env-gated':
      return { 'fitness/outbox-direct-write': 'warn' };
    case 'invariant.timer-rearm-without-clear':
      return { 'fitness/timer-rearm-without-clear': 'warn' };
    case 'test.skip-categorization':
      return { 'fitness/categorized-skips': 'warn' };
    case 'arch.approved-api-client':
      return { 'fitness/approved-api-client': 'warn' };
    case 'arch.ring-boundaries':
      return { 'fitness/ring-boundaries': 'warn' };
    case 'arch.sqlite-busy-timeout-ssot':
      return { 'fitness/no-magic-sqlite-pragma': 'warn' };
    case 'hygiene.catch-justification':
      return {
        'fitness/require-catch-justification': [
          'warn',
          { baselinePath: rule.params?.baselinePath ?? 'eslint-rules/catch-ratchet-baseline.json' },
        ],
      };
    case 'invariant.no-unsafe-type-escapes':
      return { 'fitness/unsafe-type-escape': 'warn' };
    default:
      return {};
  }
}

// Exported so the drift test can assert coverage without re-running ESLint.
export const eslintRingRuleIds = ESLINT_RING.map((r) => r.id).sort();

// Register typescript-eslint under its `@typescript-eslint/` namespace so that
// pre-existing inline rule-disable directives for `@typescript-eslint/...` rules
// in src/ resolve to a known rule (otherwise ESLint errors "Definition for rule
// not found"). We register the plugin WITHOUT enabling any of its rules — the
// fitness ring only enforces the registry rules below.
const plugins = {
  fitness: fitnessPlugin,
  '@typescript-eslint': tseslint.plugin,
};

// This config defines ONLY the fitness-ring rules. Source/test files carry
// pre-existing inline rule-disable directives for rules that belong to a
// different (general/console) config — `@typescript-eslint/no-explicit-any`,
// `prefer-arrow-callback`, etc. Under this narrow config those directives
// suppress nothing, so unused-directive reporting would add unrelated noise.
// The standalone catch-ratchet scanner disables inline config and is the
// authoritative suppression-resistant gate for that rule.
const linterOptions = { reportUnusedDisableDirectives: 'off' };

const config = [
  {
    // src + scripts: file-size, god-class, fail-closed-scanner, outbox-direct-write,
    // ring-boundaries, unsafe-type-escape, timer-rearm-without-clear.
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    linterOptions,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    plugins,
    rules: {
      ...ruleEntriesFor('arch.file-size'),
      ...ruleEntriesFor('arch.god-class'),
      ...ruleEntriesFor('invariant.fail-closed-scanner'),
      ...ruleEntriesFor('invariant.outbox-env-gated'),
      ...ruleEntriesFor('arch.ring-boundaries'),
      ...ruleEntriesFor('arch.sqlite-busy-timeout-ssot'),
      ...ruleEntriesFor('invariant.no-unsafe-type-escapes'),
      ...ruleEntriesFor('invariant.timer-rearm-without-clear'),
    },
  },
  {
    // The catch ratchet's semantic baseline and generator both scan src/.
    // Keep the configured rule on that exact scope so scripts/ cannot produce
    // untracked warnings outside the shrink-only multiset.
    files: ['src/**/*.ts'],
    // The standalone shrink-only scanner is the authoritative suppression-
    // resistant gate. Keep the broad fitness pass quiet for unrelated inline
    // directives that belong to the repo's general ESLint configuration.
    linterOptions,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    plugins,
    rules: {
      ...ruleEntriesFor('hygiene.catch-justification'),
    },
  },
  {
    // tests: file-size + skip categorization.
    files: ['tests/**/*.ts'],
    linterOptions,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    plugins,
    rules: {
      ...ruleEntriesFor('arch.file-size'),
      ...ruleEntriesFor('test.skip-categorization'),
    },
  },
  {
    // console/src: approved-api-client (direct fetch bypass guard).
    files: ['console/src/**/*.{ts,tsx}'],
    linterOptions,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins,
    rules: {
      ...ruleEntriesFor('arch.approved-api-client'),
    },
  },
  {
    // Fleet routes: no raw exception prose in responses (#2517).
    files: ['src/fleet/routes/**/*.ts'],
    linterOptions,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    plugins,
    rules: {
      'fitness/no-raw-fleet-error': 'warn',
    },
  },
];

export default config;

// Plugin/builtin rule names actually ENABLED across all blocks of this config. The
// drift test asserts every eslint-ring rule's mapped name appears here — catching the
// gap where a rule is added to ruleEntriesFor/the registry but never spread into a
// `files` block (so it silently never runs). The id-list export alone could not.
export const enabledFitnessRuleNames = [
  ...new Set(config.flatMap((block) => Object.keys(block.rules ?? {}))),
].sort();

// The rule names the eslint ring is SUPPOSED to enforce (registry eslint-ring rules
// mapped through ruleEntriesFor). Compared against enabledFitnessRuleNames in the test.
export const eslintRingRuleNames = [
  ...new Set(ESLINT_RING.flatMap((r) => Object.keys(ruleEntriesFor(r.id)))),
].sort();
