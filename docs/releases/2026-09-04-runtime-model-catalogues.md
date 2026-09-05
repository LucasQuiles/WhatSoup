# 2026-09-04 Runtime Model Catalogues

## Public surface additions

- `GET /api/providers/:name/models` returns the selected execution adapter's
  provider-native model-catalogue receipt. Successful responses carry exact
  IDs, source provenance, and capture age; unavailable sources carry a typed
  reason. Unknown execution providers return `404` before any probe runs.

## Behavioral changes

- Console model fields now use runtime catalogue results as editable
  suggestions. Empty fields retain the runtime default, manual provider-native
  IDs remain valid, and request or provider failures are shown rather than
  replaced with a compiled fallback list.
- Console execution-provider selectors now render the fleet server's registry.
  A configured value that is not reported is preserved and identified instead
  of being silently replaced.
- Managed API and CLI-session catalogue requests preserve their distinct
  credential identities so one account's visible models are not presented as
  another account's catalogue.

## Release-readiness limitation

The published candidate `d3764288` has a successful hosted job status, but its
sentinel coverage step printed 97.78% against a 98% requirement and continued
to a success marker. The exact Node 24 job log confirms the discrepancy tracked
in [issue #3481](https://github.com/LucasQuiles/WhatSoup/issues/3481).
Hosted green therefore does not prove that coverage requirement. The gate
semantics and missing coverage must be resolved without lowering the threshold
merely to permit landing; this candidate is not merge-ready.

Local integration `c1be835a` includes canonical `3fc43aed` and passed 838 tests
across 30 affected/adjacent files on pinned Node 24.15.0, with three existing
scheduled-isolation expected failures retained explicitly. Source/test type
checking passed. These scoped results do not replace full release validation,
updated-revision CI, required review, or evidence-backed Git-estate disposition.

The next integration, `a2962ba6`, includes canonical `79536789` without conflicts.
All 551 tests in the 16 changed test files passed on pinned Node 24.15.0;
source and test type checking passed. This selected run did not include the
three scheduled-isolation probes above. Two missing-keychain-item diagnostics
were emitted: credential-store isolation of the selected run remains unproven,
even though its test assertions passed. Existing randomized missing-service
fixtures are a source-inspected candidate, not a proven attribution.

The sentinel gap was also reproduced locally: 170 tests passed at 97.78%
coverage with exit zero. Explicit precision made that same suite exit one;
a valid 57-test pin suite still exited zero at 99.61%. A 2,001-case comparator
sweep demonstrated that precision alone still accepts some unrounded totals
below 98%. No coverage threshold, validation logic, or test exclusion was
changed, and issue #3481 remains required before meaningful release green.
