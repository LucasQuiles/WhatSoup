# Microsoft 365 Capability Admission Integrity Design

Date: 2026-07-12

Status: approved direction; implementation and deployment remain evidence-gated

## Objective

Make the Microsoft 365 capability fail closed from settings load through tool execution. Every runtime start must enforce the connector mutation-deny floor, preserve malformed operator settings for recovery, pin the exact read-tool artifact, and derive each mail operation identity from the admitted human turn and current readiness generation.

This design is independent of the root-owned release builder. The builder protects deployed bytes; this design protects the meaning of the configuration and operation admitted by those bytes.

## Current gaps

Four gaps prevent capability rollout:

1. required mutation denies are applied only when `enabledPlugins` is present, so a legacy settings file can retain broad plugin access without the current connector deny floor;
2. malformed or non-object settings can be replaced with defaults, destroying custom settings and hooks instead of blocking startup;
3. the mail tool accepts a caller-supplied operation key, while the durable identity omits readiness manager identity/generation and a stable inbound message identity;
4. the approved read inventory has no standalone digest bound through the descriptor, launcher proof, readiness receipt, and sealed plugin artifact.

## Approaches considered

### A. Every-load normalization plus server-owned operation identity (selected)

Parse settings without mutation, enforce a code-owned deny floor on every valid load, fail closed while preserving malformed bytes, and inject a server-derived mail operation identity that includes the admitted turn and current capability generation.

This keeps legacy configuration compatible while making safety properties independent of optional fields or model-supplied input.

### B. Require operators to regenerate settings

This is operationally simple but leaves existing instances unsafe until a manual rewrite and risks discarding custom settings.

Rejected.

### C. Trust the model to select a unique operation key

This preserves the current API shape but lets an untrusted caller choose replay identity and cannot prove freshness across same-account generation rollover.

Rejected.

## Settings load contract

Settings handling separates read, validate, normalize, and write:

1. read the existing file through the private-file policy;
2. parse JSON and require an object;
3. validate all recognized settings;
4. merge the code-owned required deny floor into `permissions.deny`, regardless of `enabledPlugins`;
5. preserve operator entries and order-insensitive semantics while deduplicating exact denies;
6. write only when the fully validated normalized representation differs.

Missing `enabledPlugins` means no explicit plugin selection; it never disables safety normalization. The required floor contains all canonical Microsoft 365 mutation aliases plus the existing Google mutation floor.

Malformed JSON, a non-object root, invalid permission shapes, unsafe symlinks, or write failure block startup. The original bytes remain unchanged. The runtime emits only a bounded reason code and file identity metadata; it never logs settings content.

The same function owns first-run creation and existing-file normalization so safety behavior cannot drift between paths.

## Canonical mutation floor

The logical mutation inventory is code-owned and aliases are derived deterministically. A canonical digest binds:

- logical operation names;
- both supported connector namespace aliases;
- the Google mutation inventory;
- normalization version.

Startup health reports only the digest and cardinalities. A selected Microsoft 365 capability is unready unless the on-disk settings file contains the exact required floor after normalization.

Wildcard plugin permissions do not override a deny. Any connector alias absent from the floor is a release-blocking inventory drift, not a warning.

## Server-derived mail operation identity

The public MCP tool does not accept `operation_key`. The runtime injects an opaque operation identity after resolving the executing admitted turn.

The canonical digest includes:

- instance identity;
- Agent365 account identity;
- canonical conversation key;
- durable inbound message identity and sequence;
- admitted raw and canonical actor binding;
- readiness manager identity;
- readiness generation;
- authorization/descriptor hashes;
- canonical payload hash.

No plaintext actor, address, subject, body, recipient, or token enters the operation key or routine logs.

The tool revalidates immediately before reservation that:

1. the admitted turn is still the queue head;
2. actor and conversation match the captured provenance;
3. the readiness permit belongs to the same manager and generation;
4. no prior terminal record exists for the inbound turn;
5. the payload hash matches the approved confirmation.

A caller-provided operation identity is rejected at schema validation. A stale generation cannot reserve or reuse an operation created under another generation. Replaying the same admitted turn and payload resolves to the same durable identity and returns the existing receipt without another transport dispatch.

## Read inventory and plugin provenance

The canonical approved-read inventory receives a standalone digest derived from sorted logical tool names and inventory schema version. The following artifacts must agree:

- source inventory and its tests;
- capability descriptor;
- pinned launcher source identity;
- plugin artifact manifest;
- launcher `tools/list` proof;
- readiness receipt;
- WhatSoup release manifest.

Counts are diagnostic only. A matching count with a different name set fails. Documentation cannot serve as the pin.

The pinned plugin artifact is built from a clean committed object and included by digest in the root-owned composite release. Environment-gated conformance tests are run with that exact artifact during candidate build and again on the target canary.

## Failure behavior

Before a capability starts, any settings, deny-floor, inventory, plugin, or descriptor mismatch makes startup fail closed without rewriting the invalid source.

During operation, stale or missing turn/generation evidence returns a bounded denial before durable reservation or Graph transport. Once reservation exists, existing send-once semantics remain authoritative: pre-dispatch failure is terminal; ambiguous post-dispatch state is `unknown` and never automatically retried.

Capability degradation does not trigger a blind service restart. It blocks new Microsoft 365 turns, preserves durable state, and enters the existing incident path.

## Verification

Tests must prove:

- the full mutation deny floor is added when `enabledPlugins` is absent, empty, or populated;
- wildcard allow plus missing deny cannot survive startup;
- malformed JSON, non-object JSON, invalid permissions, symlink targets, and write faults preserve original bytes and block startup;
- normalization is idempotent and preserves unrelated settings/hooks;
- every logical mutation and alias appears exactly once in the canonical floor;
- inventory and deny digests change for add/remove/rename drift;
- the mail schema rejects caller-supplied operation keys;
- the runtime injects identity from the admitted turn rather than model input;
- account, conversation, inbound identity, actor, manager, generation, descriptor, authorization, or payload change produces a different identity or a denial as specified;
- same-turn replay returns the existing receipt with zero additional transport calls;
- same-account generation rollover invalidates the old permit and operation admission;
- the exact pinned plugin artifact passes `tools/list` equality and mutation absence without an environment-gated skip;
- private literals and message content are absent from settings errors, operation keys, receipts, and logs;
- complete suite, typecheck, lint, test-integrity, public-surface, and publication guards pass from the committed candidate.

Live acceptance then proves the generated private MCP settings, exact read tool list, absence of general mutation tools, one admitted human mail operation, and restart/no-resend behavior.

## Rollout

Settings are first evaluated in report-only mode against a protected copy. The candidate release refuses activation if normalization would lose or invalidate operator configuration. The root-owned installer then installs the verified normalized settings and pinned plugin artifact atomically with the signed plan.

The capability is enabled only in a fresh per-chat session after the new generation is observable. Rollback restores the prior sealed settings/release pair; it never weakens or removes the code-owned mutation floor.
