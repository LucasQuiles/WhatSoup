# Boundary Exit Parser CodeQL Hardening Design

**Date:** 2026-07-17
**Status:** active
**Approval:** Approved for implementation

## Context

PR #1899 is blocked by three GitHub Advanced Security findings. Two findings identify
ambiguous regular expressions used to validate comma-separated expected child exit
statuses. The third identifies a test fixture that converts only the first line ending
when constructing noncanonical JSON bytes.

The remediation must preserve the existing accepted language and fail-closed behavior:
`nonzero`, or a strictly increasing comma-separated list of unique decimal integers in
`0..255` with no leading zeroes. It must not weaken the boundary-run manifest, generic
reproduction-attempt contract, or canonical-JSON checks.

## Design

Create one exported boundary-status parser in
`scripts/lib/verification/boundary-run-manifest.ts`. The parser splits the declaration on
commas, validates each non-empty token with an unambiguous bounded decimal-token check,
converts tokens to numbers, and rejects values above 255, duplicates, and non-increasing
order. It returns the existing `Set<number> | 'nonzero' | null` contract.

Both manifest validation and the generic reproduction command path in
`scripts/verify-boundary-run.ts` use this parser. This removes the duplicated ambiguous
regular expressions and keeps one source of truth for normalized expected-exit syntax.

The canonical-JSON negative fixture constructs CRLF bytes with an all-occurrences
transformation rather than a single-occurrence `replace`. This remains a negative test;
no runtime canonicalization behavior changes.

## Error Handling and Compatibility

The parser remains total and synchronous. Empty input, empty tokens, whitespace, signs,
decimals, leading zeroes, values above 255, duplicates, descending values, and malformed
text return `null`. Callers retain their existing issue codes and exit behavior. No CLI
flags, manifest fields, schemas, or evidence layouts change.

## Test Strategy

Implementation follows red-green-refactor:

1. Add direct parser tests covering accepted declarations, the invalid-neighbor matrix,
   and a long adversarial repeated-token input. The first run must fail because the new
   shared export does not yet exist.
2. Add or retain integration assertions proving manifest validation and generic
   reproduction attempts reject malformed expected-exit declarations with their current
   issue codes.
3. Assert the CRLF fixture transforms every canonical newline and is still rejected as
   `invalid-json-byte`.
4. Implement the minimal shared parser and caller replacement, then run the focused test
   file, TypeScript checks, the repository validator, `git diff --check`, and the full
   pre-push gate.
5. Push without bypassing hooks and require a fresh CodeQL analysis plus every required PR
   check to pass before merge.

## Non-Goals

- Dismissing, suppressing, or reclassifying the CodeQL alerts.
- Changing accepted exit-status syntax or CLI behavior.
- Refactoring unrelated boundary-run verification code.
- Mining additional swarm-consistency rules before PR #1899 is merged and verified on
  `origin/main`.
