# Provider data-policy boundary handoff

**Status:** Task 3 classification/admission candidate ready for verification; restricted-provider enforcement remains open.

## Candidate scope

The Task 3 candidate adds a versioned `trusted` / `restricted` classification to
primary and fallback provider routes. In `shadow` mode a missing classification
is observable but non-blocking. In `enforce` mode configuration and route
admission fail closed when a route lacks a supported explicit policy.

Route policy is bound to session checkpoints. Resume or cleanup operations reject
missing, changed, foreign, or otherwise inconclusive provider/model/policy
metadata instead of mutating a different lifecycle row.

This candidate does not claim that classifying a route as `restricted` sanitizes
or isolates its payload. It permits `restricted` only for the managed
`openai-api` and `anthropic-api` routes so the later mechanical boundary has a
bounded implementation surface; CLI routes remain unsupported.

## Open work

- Implement and independently verify the managed-provider payload boundary before
  enabling `providerBoundaryMode: "enforce"` with a `restricted` route.
- Produce the real WhatSoup schema/migration and content-private fixture consumed
  by the SoupOps provider-boundary integration gate.
- Run the combined WhatSoup, SoupOps, and private analytics validation on final
  merge candidates. Existing hermetic consumer evidence is not producer proof.
- Keep live deployment, fallback activation, and provider calls separately
  owner-gated.

## Verification contract

The Task 3 PR must pass the affected route-policy/lifecycle tests, typecheck,
test-integrity and repository publication guards on its exact rebased head. Any
masked, skipped, timed-out, or environment-refused check is inconclusive.

The later restricted-provider implementation requires its own tests, review and
handoff update. Do not close this handoff from Task 3 alone.
