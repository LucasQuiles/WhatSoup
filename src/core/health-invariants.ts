/**
 * #2481 — health invariants this code implements, emitted verbatim on the
 * authenticated /health diagnostic body as `health_invariants: {schema, ids}`.
 *
 * A leaf module with no imports: the health producer and the release
 * activation tool (`scripts/lib/release-activation/`) both import it without
 * loading config or the runtime graph.
 *
 * The ids are compile-time constants, not runtime state. A generation that
 * predates this module emits no block, and the activating tool classifies that
 * silence as `missing`, never green. A declared id is a claim that the loaded
 * code carries the behaviour; the tests cited beside each id hold it.
 *
 * Rules:
 * - ids are append-only; an id is removed only together with its behaviour;
 * - the schema changes only for an incompatible change to the block's shape
 *   (an older tool classifies an unknown schema as `unknown`);
 * - `RELEASE_INVARIANT_FLOOR` is the subset the activating tool requires. It
 *   is separate so a new id on main does not become required of every older
 *   approved release; raise it only on purpose.
 */

export const HEALTH_INVARIANTS_SCHEMA = 'whatsoup.health-invariants.v1';

export const HEALTH_INVARIANTS: readonly string[] = Object.freeze([
  // #1920 S-04a / #2446: model-usability evidence that went stale while turns
  // relied on it degrades /health instead of reading healthy.
  // Code: src/core/health.ts `modelEvidenceStaleWhileRelied` (status and the
  // `turn_capability_evidence_stale` degradation cause).
  // Tests: tests/core/health-model-staleness.test.ts.
  'turn_capability.stale_evidence_degrades',
  // #3017 axis A: with a periodic readiness probe expected, stale evidence
  // degrades even on an idle bot.
  // Code: the `periodic_probe_expected === true` branch of
  // `modelEvidenceStaleWhileRelied` in src/core/health.ts.
  // Tests: tests/runtimes/agent/readiness-proof-3017.test.ts.
  'turn_capability.probe_expected_stale_degrades',
  // #2515: an unauthenticated GET /health gets only the public liveness
  // envelope; the diagnostic body requires the bearer token.
  // Code: src/core/health.ts `hasHealthAuth` and the public-envelope branch.
  // Tests: tests/core/health.test.ts "#2515 public/private liveness split".
  'health.diagnostic_requires_token',
]);

export const RELEASE_INVARIANT_FLOOR: readonly string[] = Object.freeze([
  'turn_capability.stale_evidence_degrades',
]);
