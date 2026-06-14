# Provider ErrPreview Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure provider HTTP error previews and malformed SSE data previews are redacted before they enter structured logs.

**Architecture:** Reuse the existing provider crash redaction contract for all provider preview strings by extracting or renaming it into a generic provider-preview helper, then route `errPreview` and `dataPreview` fields through a sanitize-then-truncate helper at each provider logging site. Keep user-facing provider errors unchanged and avoid broad logger-level behavior changes in this slice.

**Tech Stack:** TypeScript, Vitest, existing provider API test harnesses, existing `src/runtimes/agent/provider-crash-diagnostics.ts` sanitizer logic.

**Status:** active — implemented in local compose branch `integration/provider-hardening-compose-refresh-20260613T194657Z`, not yet pushed or landed on `main`. The approval boundary now applies to publishing/merging the compose branch, not to reimplementing this plan.

---

## Current Evidence

- Current verified base: `origin/main` `f65c3990f8c2` (`feat(agent): surface turn capability in health`).
- `src/runtimes/agent/provider-crash-diagnostics.ts` already redacts provider CLI crash stderr for bearer strings, keyed secrets, common token prefixes, and email addresses.
- `src/runtimes/agent/providers/claude.ts` and `src/runtimes/agent/session.ts` already consume that crash-preview sanitizer for stderr paths.
- Current `origin/main` still lacks this fix until the compose branch lands.
- The local compose branch routes `anthropic-api.ts` and `openai-api.ts` HTTP error previews and malformed SSE previews through `providerPreview(...)`.
- The local compose branch adds `src/runtimes/agent/provider-preview-sanitizer.ts` and focused provider preview redaction tests.

## Risk Statement

Provider API errors and malformed SSE chunks can echo request fragments, authorization headers, account identifiers, or upstream diagnostic JSON. Current logs truncate those strings but do not redact them first, so truncation only limits blast radius; it does not prevent leaking secrets inside the retained prefix.

## Local Compose Outcome

- Shared helper: `src/runtimes/agent/provider-preview-sanitizer.ts`.
- Provider call sites: `src/runtimes/agent/providers/anthropic-api.ts` and `src/runtimes/agent/providers/openai-api.ts`.
- Tests: `tests/runtimes/agent/providers/api-preview-redaction.test.ts` covers HTTP error `errPreview`, malformed SSE `dataPreview`, and sanitize-before-truncate behavior with runtime-built secret fixtures.
- Compatibility: user-facing provider failure messages and existing crash-diagnostics metadata names are preserved.

## Decision Record

| Option | Verdict | Reason |
|---|---|---|
| Reuse provider crash sanitizer for API previews | Recommended | Same provider boundary, same preview purpose, already tested against common credential shapes. |
| Rename/extract to `provider-preview-sanitizer.ts` | Recommended if import churn stays small | Makes the contract accurate for crash stderr, HTTP error bodies, and SSE data. |
| Keep `provider-crash-diagnostics.ts` name and add preview helper there | Acceptable fallback | Minimizes file churn but leaves a misleading module name. |
| Add global logger redaction | Defer | Broader blast radius; harder to prove every call site keeps intended non-secret metadata. |
| Redact only `errPreview`, not `dataPreview` | Reject | Malformed SSE data can also carry provider diagnostics or echoed request text. |
| Show raw preview to operators in private logs | Reject | The operator benefit is weak; sanitized preview keeps error-class context without leaking credentials. |

## File Structure

- Modify or split: `src/runtimes/agent/provider-crash-diagnostics.ts`
  - Keep `classifyProviderCrash`, `appendProviderCrashPreview`, and `buildProviderCrashMetadata` behavior unchanged.
  - Add or move a generic helper named `sanitizeProviderPreviewText(text: string): string`.
  - Add `providerPreview(text: string, maxLength: number): string` or equivalent, with sanitize-before-slice semantics.
- Optional create: `src/runtimes/agent/provider-preview-sanitizer.ts`
  - Owns `sanitizeProviderPreviewText` and `providerPreview`.
  - `provider-crash-diagnostics.ts` imports from this module instead of owning generic redaction patterns.
- Modify: `src/runtimes/agent/providers/anthropic-api.ts`
  - Replace every `errText.slice(...)` preview with the shared preview helper.
  - Replace malformed SSE `data.slice(...)` preview with the shared preview helper.
- Modify: `src/runtimes/agent/providers/openai-api.ts`
  - Replace every `errText.slice(...)` preview with the shared preview helper.
  - Replace malformed SSE `data.slice(...)` preview with the shared preview helper.
- Modify: `tests/runtimes/agent/provider-crash-diagnostics.test.ts` or add `tests/runtimes/agent/provider-preview-sanitizer.test.ts`
  - Prove shared preview redaction and bounded length.
- Modify or add provider tests under `tests/runtimes/agent/providers/`
  - Prefer focused tests beside `api-mcp-bridge.test.ts` patterns using mocked `fetch` and mocked logger calls.

## Compatibility Contract

- Do not change provider user-facing terminal result messages.
- Do not change retry, self-heal, or SSE parsing behavior.
- Do not remove the existing crash metadata field name `stderrPreview`.
- Preserve existing redaction markers where already asserted:
  - `Bearer [REDACTED]`
  - `[REDACTED]`
  - `[REDACTED_TOKEN]`
  - `[REDACTED_EMAIL]`
- Ensure previews are sanitized before truncation so a secret spanning the truncation boundary cannot be partly retained.
- Keep preview bounds unchanged at call sites unless a test proves a different bound is required.

## Task 1: Add Shared Preview Contract Tests

**Files:**
- Modify: `tests/runtimes/agent/provider-crash-diagnostics.test.ts`
- Optional add: `tests/runtimes/agent/provider-preview-sanitizer.test.ts`

- [ ] **Step 1:** Add a failing test for `sanitizeProviderPreviewText` or the existing sanitizer renamed/exported under that contract.
- [ ] **Step 2:** Build secret fixtures at runtime so the source tree does not contain real-shaped tokens as contiguous literals.
- [ ] **Step 3:** Include bearer, keyed secret, token-prefix, and email-shaped values in the same preview text.
- [ ] **Step 4:** Assert raw fixture values are absent from the sanitized preview.
- [ ] **Step 5:** Assert non-secret provider context remains present, such as `invalid_request_error`, `surrogate`, `line`, or `status`.
- [ ] **Step 6:** Add a helper-level bounded preview test proving redaction happens before truncation.
- [ ] **Step 7:** Run the new helper test before implementation and capture the expected failure.

**Test command:**

```bash
npm test -- --pool=forks --fileParallelism=false tests/runtimes/agent/provider-crash-diagnostics.test.ts > /tmp/errpreview-helper-red.log 2>&1; echo "helper-red exit=$?"
```

## Task 2: Implement Shared Provider Preview Helper

**Files:**
- Modify: `src/runtimes/agent/provider-crash-diagnostics.ts`
- Optional add: `src/runtimes/agent/provider-preview-sanitizer.ts`

- [ ] **Step 1:** Extract the redaction regex chain into `sanitizeProviderPreviewText`.
- [ ] **Step 2:** Keep `sanitizeProviderCrashText` as a compatibility export that delegates to `sanitizeProviderPreviewText`, or rename only if all imports migrate in the same commit.
- [ ] **Step 3:** Add `providerPreview(text, maxLength)` that returns `sanitizeProviderPreviewText(text).slice(0, maxLength)` unless the caller needs tail semantics.
- [ ] **Step 4:** Leave `appendProviderCrashPreview` tail retention unchanged for crash stderr.
- [ ] **Step 5:** Run the helper tests and existing crash diagnostics tests green.

**Test command:**

```bash
npm test -- --pool=forks --fileParallelism=false tests/runtimes/agent/provider-crash-diagnostics.test.ts > /tmp/errpreview-helper-green.log 2>&1; echo "helper-green exit=$?"
```

## Task 3: Add Provider Red-First HTTP Error Preview Tests

**Files:**
- Modify or add: `tests/runtimes/agent/providers/api-preview-redaction.test.ts`
- Or modify: `tests/runtimes/agent/providers/api-mcp-bridge.test.ts` if the existing harness is simpler and stays readable.

- [ ] **Step 1:** Mock `src/logger.ts` with hoisted `warn` and `error` spies so structured log payloads are inspectable.
- [ ] **Step 2:** For `OpenAIApiProvider`, mock `fetch` to return HTTP 400 with a body containing runtime-built bearer/key/email fixtures.
- [ ] **Step 3:** Drive one turn and assert the terminal user result remains the friendly 400 message.
- [ ] **Step 4:** Assert the `API 400 error` log has an `errPreview` field.
- [ ] **Step 5:** Assert `errPreview` contains redaction markers and non-secret error context.
- [ ] **Step 6:** Assert `errPreview` does not contain any raw fixture value.
- [ ] **Step 7:** Repeat for `AnthropicApiProvider`.
- [ ] **Step 8:** Run this test before implementation and capture the expected failure.

**Test command:**

```bash
npm test -- --pool=forks --fileParallelism=false tests/runtimes/agent/providers/api-preview-redaction.test.ts > /tmp/errpreview-http-red.log 2>&1; echo "http-red exit=$?"
```

## Task 4: Add Provider Red-First Malformed SSE Preview Tests

**Files:**
- Modify or add: `tests/runtimes/agent/providers/api-preview-redaction.test.ts`

- [ ] **Step 1:** Mock a successful event-stream response with one malformed `data:` line containing runtime-built bearer/key/email fixtures.
- [ ] **Step 2:** Include a later valid SSE completion line so the provider completes the turn rather than failing for unrelated reasons.
- [ ] **Step 3:** Assert the malformed-SSE warning log has a `dataPreview` field.
- [ ] **Step 4:** Assert `dataPreview` contains redaction markers and non-secret parse context.
- [ ] **Step 5:** Assert `dataPreview` does not contain any raw fixture value.
- [ ] **Step 6:** Repeat for `OpenAIApiProvider` and `AnthropicApiProvider`.
- [ ] **Step 7:** Run this test before implementation and capture the expected failure.

**Test command:**

```bash
npm test -- --pool=forks --fileParallelism=false tests/runtimes/agent/providers/api-preview-redaction.test.ts > /tmp/errpreview-sse-red.log 2>&1; echo "sse-red exit=$?"
```

## Task 5: Route HTTP Provider Preview Logs Through The Helper

**Files:**
- Modify: `src/runtimes/agent/providers/anthropic-api.ts`
- Modify: `src/runtimes/agent/providers/openai-api.ts`

- [ ] **Step 1:** Import the shared provider preview helper.
- [ ] **Step 2:** Replace Anthropic surrogate self-heal `errPreview: errText.slice(0, 200)`.
- [ ] **Step 3:** Replace Anthropic 400 `errPreview: errText.slice(0, 500)`.
- [ ] **Step 4:** Replace Anthropic generic API error `errPreview: errText.slice(0, 300)`.
- [ ] **Step 5:** Replace Anthropic malformed SSE `dataPreview: data.slice(0, 200)`.
- [ ] **Step 6:** Replace OpenAI surrogate self-heal `errPreview: errText.slice(0, 200)`.
- [ ] **Step 7:** Replace OpenAI 400 `errPreview: errText.slice(0, 500)`.
- [ ] **Step 8:** Replace OpenAI malformed SSE `dataPreview: data.slice(0, 200)`.
- [ ] **Step 9:** Run helper and provider preview tests green.
- [ ] **Step 10:** Run adjacent provider API bridge tests green.

**Test commands:**

```bash
npm test -- --pool=forks --fileParallelism=false tests/runtimes/agent/provider-crash-diagnostics.test.ts tests/runtimes/agent/providers/api-preview-redaction.test.ts > /tmp/errpreview-target-green.log 2>&1; echo "target-green exit=$?"
npm test -- --pool=forks --fileParallelism=false tests/runtimes/agent/providers/api-mcp-bridge.test.ts tests/runtimes/agent/providers/api-key-service-wiring.test.ts > /tmp/errpreview-adjacent.log 2>&1; echo "adjacent exit=$?"
```

## Task 6: Regression Guards And Review

**Files:**
- Tests from prior tasks.

- [ ] **Step 1:** Run Test Integrity on changed tests.
- [ ] **Step 2:** Run `npm run typecheck:all`.
- [ ] **Step 3:** Run `npm run verify:push:branch`.
- [ ] **Step 4:** Review `rg -n "\b(?:errPreview|dataPreview): .*slice" src/runtimes/agent -g '*.ts'` and require zero provider API hits unless justified in the PR body.
- [ ] **Step 5:** Request adversarial review focused on false confidence: redaction-before-truncation, test fixture realism without committed secret literals, and provider behavior invariance.

**Commands:**

```bash
test-integrity scan --ci tests/runtimes/agent/provider-crash-diagnostics.test.ts tests/runtimes/agent/providers/api-preview-redaction.test.ts > /tmp/errpreview-ti.log 2>&1; echo "test-integrity exit=$?"
npm run typecheck:all > /tmp/errpreview-typecheck.log 2>&1; echo "typecheck exit=$?"
npm run verify:push:branch > /tmp/errpreview-verify.log 2>&1; echo "verify exit=$?"
rg -n "\b(?:errPreview|dataPreview): .*slice" src/runtimes/agent -g '*.ts' > /tmp/errpreview-slice-scan.log 2>&1; echo "slice-scan exit=$?"
```

## Acceptance Checklist

- [ ] Raw provider HTTP error bodies are never logged directly in `errPreview`.
- [ ] Raw malformed SSE data is never logged directly in `dataPreview`.
- [ ] Provider previews redact bearer strings, keyed secrets, common token prefixes, and email-shaped identifiers.
- [ ] Preview truncation happens after redaction.
- [ ] Existing crash stderr redaction behavior remains unchanged.
- [ ] User-facing provider error messages remain friendly and do not expose raw upstream JSON.
- [ ] OpenAI-compatible provider HTTP error preview tests pass.
- [ ] Anthropic provider HTTP error preview tests pass.
- [ ] OpenAI-compatible malformed SSE preview tests pass.
- [ ] Anthropic malformed SSE preview tests pass.
- [ ] Test Integrity passes for every changed test file.
- [ ] `typecheck:all` passes.
- [ ] `verify:push:branch` passes with a true exit marker.
- [ ] PR body lists residual preview surfaces, if any, and explains why they are out of scope.

## Rollback Plan

- Revert the provider preview helper and call-site substitutions as one commit.
- Existing provider behavior returns to prior log previews and does not change provider turn semantics.
- If only one provider regresses, revert that provider's call-site substitutions while keeping the shared helper and tests for the other provider until a follow-up fix lands.

## Out Of Scope

- Python BOT ERRORS redaction SSOT; use `docs/superpowers/plans/2026-06-13-python-deploy-redaction-ssot.md`.
- Global logger-level redaction.
- Provider request-body redaction.
- Redaction for WhatsApp transport diagnostics.
- Changing provider retry, rate-limit, self-heal, or MCP bridge behavior.
