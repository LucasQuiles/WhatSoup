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
