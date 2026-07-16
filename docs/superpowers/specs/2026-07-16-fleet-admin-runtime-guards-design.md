# Fleet Admin Runtime Guards Design

**Date:** 2026-07-16

**Status:** Proposed for owner review

**Scope:** WhatSoup agent instances, fleet configuration paths, restart tooling, and fleet verification

## Problem

The live fleet can be transport-healthy while still failing an administrator's WhatsApp turn. The July 16 audit found five distinct classes of failure:

1. A configured `instructionsPath` was syntactically valid but missing on disk, so the instance accepted configuration and failed only when it tried to build a turn prompt.
2. The transport authorized the personal line as an administrator, but several models denied or caveated that role because the model prompt received sender identity without a trusted access classification.
3. Some turns produced two outbound replies: streamed assistant text followed by a redundant terminal result, or two distinct result-path messages for one inbound event.
4. Several older deployments completed an inbound event as `response_sent` without durable terminal proof, or left it in `processing` after an echoed response.
5. A restart gate considered only recent outbound work. Restarting one instance resubmitted five historical replay-safe nonterminal operations, proving that age is not a valid safety boundary.

The audit also found a semantic false duplicate: a fresh post-upgrade token received one reply, but the model called the new token "already ACKed." Transport deduplication cannot solve that prompt/session-memory error, so verification must distinguish physical duplicate sends from false duplicate claims.

## Goals

- Reject unreadable instruction files before configuration is persisted or a service is restarted.
- Tell the model the current actor's trusted access class without exposing phone numbers, JIDs, admin lists, or unrelated capabilities.
- Ensure one inbound user turn cannot emit the same final assistant payload twice.
- Require durable terminal evidence before a replied turn is finalized.
- Block restarts whenever any replay-safe outbound operation is nonterminal, regardless of age.
- Make runtime-version drift and behavioral probe failures visible before fleet health is declared clean.

## Non-goals

- Replaying, clearing, or retiring existing `maybe_sent`, quarantined, or open-recovery rows.
- Deduplicating similar messages across different inbound turns.
- Granting model/tool permissions based only on prompt text.
- Provisioning bots on hosts intentionally configured without an instance.
- Forcing every fleet host onto one deployment mechanism in this change.

## Considered approaches

### Prompt-only remediation

Add fleet instructions telling every bot to trust the personal line and answer once. This is easy to deploy but is not authoritative: the prompt can drift, omit an instance, leak configured identifiers, or be contradicted by session history. It also cannot prevent duplicate sends or unsafe restarts.

### Transport-only suppression

Discard repeated WhatsApp payloads in the outbound queue. This would catch some exact duplicates but would hide upstream lifecycle defects, cannot handle two distinct replies, and risks suppressing intentional repetition across turns.

### Layered invariant enforcement (chosen)

Enforce each fact at the layer that owns it: filesystem checks in configuration and restart gates, actor classification in the runtime composition root, same-turn suppression at the provider-result choke point, terminal proof in durability finalization, and release/probe evidence in fleet verification. This produces narrow, testable boundaries and preserves fail-closed behavior.

## Design

### 1. Filesystem-aware `instructionsPath` validation

Add a shared validator that accepts the assembled agent configuration and resolves `agentOptions.instructionsPath` relative to the effective `agentOptions.cwd` (or the runtime's existing default working directory). When configured, the target must:

- resolve without path ambiguity;
- exist;
- be a readable regular file;
- remain within the same path policy already applied to agent working directories; and
- be checked as the intended service user, not merely as the fleet-console process when those users differ.

The validator runs at four boundaries:

1. fleet CREATE before the config directory becomes active;
2. fleet PATCH before the locked write commits;
3. `guard:instance-config` when given a live config root; and
4. restart preflight before systemd is invoked.

The existing session prompt read remains fail-closed as defense in depth. Errors include the instance and field, but not file contents.

Committed example configs cannot be validated against arbitrary live files. The guard therefore has two explicit modes: schema-only for examples and filesystem-aware for a supplied live config root. A live invocation that silently falls back to schema-only is a failure.

### 2. Trusted actor access envelope

For every user turn, resolve the actor using the existing LID-to-phone mapping and `isAdminPhone` path. Derive one enum:

- `administrator`
- `authorized_user`
- `untrusted_or_unknown`
- `system`

Pass only that enum into the session turn envelope. The provider-facing prelude states the classification as trusted transport metadata and explicitly says it is not user-authored content. It never includes the actor's phone number, JID, configured admin list, or tool inventory.

This signal informs conversational behavior only. MCP/tool authorization continues to use the existing actor-bound `SessionContext` and server-side admin checks. If identity resolution is ambiguous or unavailable, classification fails closed to `untrusted_or_unknown`.

Shared and per-chat sessions must compute the classification per executing turn. It must not be stored as mutable session-global state that can bleed from an administrator's turn into another sender's turn.

### 3. Same-turn final-payload suppression

Track normalized assistant payloads within the current inbound turn. When a provider `result` arrives after streamed assistant output:

- suppress the result payload only when its normalized visible text exactly matches text already queued for that turn;
- record a structured `duplicate_final_payload_suppressed` event with instance, turn identity, source paths, and hashes only;
- do not create a second outbound operation; and
- continue normal result accounting and terminalization.

Normalization is deliberately conservative: newline normalization and outer whitespace only. Two distinct messages, messages from different inbound turns, tool-status messages, polls, media, and fallback notices are never collapsed by this rule.

Two distinct replies for one turn remain a lifecycle error, not a dedupe success. The finalization contract records the extra output and the verification probe fails the instance so the upstream cause remains visible.

### 4. Durable terminal-proof invariant

Use the current turn-finalization contract as the single source of truth and close older `response_sent` escape paths:

- `finalized_replied` requires an echoed, terminal outbound operation linked to the inbound event;
- `response_sent` without terminal proof is not a successful terminal disposition;
- completion with no linked outbound operation is rejected;
- an echoed nonterminal response cannot leave the inbound row in `processing`; and
- finalization retry exhaustion is surfaced as degraded health with a recovery record, never converted to success.

Legacy compatibility code may read historical `response_sent` rows, but new writes must satisfy the stricter contract. Migration and recovery tests prove the old rows are not blindly replayed.

### 5. All-age restart safety gate

Introduce one reusable, fail-closed restart check used by deployment scripts and operator restart commands. It opens the live database read-only and blocks when any outbound operation has:

- `replay_policy = 'safe'`; and
- a status outside the terminal set (`echoed`, `failed_permanent`, `quarantined`).

There is no age filter. The check also reports, without payloads or destinations:

- active/recent inbound counts;
- safe and unsafe nonterminal counts;
- maximum outbound operation ID;
- database quick-check result; and
- service/runtime revision.

Unsafe `maybe_sent` rows do not automatically authorize or forbid a restart; they are reported as degraded debt and must remain non-replayed. Any database error, missing database, unknown status, or masked query failure blocks the restart.

After restart, a paired verifier requires a new PID, connected transport, usable model where applicable, current process revision, `outboundReplayed = 0`, and no unexpected outbound ID increase. Retention deletions are reported separately from sends.

### 6. Fleet release and behavior gate

Extend fleet verification output with requested revision, observed disk revision, observed process freshness, config-guard result, and canary result for each active instance. Hosts with no bot by design remain explicitly `not_applicable`; unreachable or unproven hosts remain inconclusive.

The behavioral canary uses a unique token and audits both transcript and ledger:

- exactly one response message;
- administrator classification when sent from the configured secondary admin;
- instance identity and one capability;
- connected WhatsApp and usable model;
- completed inbound event; and
- exactly one linked terminal echoed outbound operation.

A response that merely says a fresh token was a duplicate fails a separate semantic assertion even when only one message was physically sent.

The verifier emits machine-readable JSON suitable for the fleet sheet and a concise human summary. It never emits raw JIDs, phone numbers, tokens, message bodies beyond the operator-supplied canary token, or credentials.

## Data flow

1. WhatsApp transport receives an inbound event and resolves its canonical conversation and actor.
2. Runtime derives the actor access enum from authoritative configuration and identity mapping.
3. Session receives the user text plus a non-user-authored access envelope.
4. Streamed output is recorded in the current-turn payload tracker and queued durably.
5. Provider result passes through exact same-turn suppression.
6. Turn finalization accepts success only after terminal echoed delivery proof is linked.
7. Health and fleet verification consume the terminal record, process revision, and canary evidence.

## Failure behavior

- Missing/unreadable instructions: config write or restart is rejected; a running healthy process is left untouched.
- Unknown actor: prompt classification and tool authorization both fail closed.
- Duplicate exact final payload: second send suppressed, structured evidence retained.
- Distinct second payload: not suppressed; turn and canary are marked failed for investigation.
- Missing terminal proof: inbound turn remains recoverable/degraded, never reported as a successful reply.
- Safe nonterminal outbound work: restart blocked with counts only.
- Probe transport/identity mismatch: result is inconclusive, never converted to zero responses.

## Test strategy

### Configuration

- relative and absolute readable files;
- missing file, directory, unreadable file, symlink/path-policy violation;
- cwd-relative resolution;
- CREATE, PATCH, live lint, and restart-preflight parity;
- different service-user readability; and
- schema-only examples versus explicit live mode.

### Actor classification

- administrator via phone JID;
- administrator via mapped LID;
- authorized non-admin;
- unknown/unmapped LID;
- system turn;
- shared-session consecutive senders cannot inherit classification; and
- provider prompt contains enum but no identifier or admin-list data.

### Reply and durability

- streamed text plus identical result yields one outbound operation;
- whitespace/newline-equivalent identical result yields one operation;
- distinct result remains visible and fails the multi-reply invariant;
- different turns may intentionally send identical text;
- one terminal echoed operation finalizes `response_echoed`;
- zero-linked, nonterminal-linked, and processing-after-echo cases fail closed; and
- recovery never replays unsafe historical rows.

### Restart and fleet verification

- historical and recent safe nonterminal rows both block;
- terminal safe rows do not block;
- unsafe `maybe_sent` rows are reported and never replayed;
- SQLite/query/JSON failures fail closed without pipeline masking;
- retention deletion is not counted as an outbound send;
- stale process revision fails until restart; and
- physical duplicate, refusal, missing response, and semantic false duplicate each have distinct canary outcomes.

## Rollout

1. Land validators, tests, and machine-readable verification without changing live configs.
2. Run live config lint across the fleet and repair only proven path failures.
3. Deploy to one healthy canary instance with zero safe nonterminal work.
4. Run the post-restart verifier and administrator DM canary.
5. Expand host by host, preserving rollback revisions and database/config backups.
6. Update the fleet sheet from verified results; degraded debt remains visible until adjudicated.

## Rollback

Runtime code rolls back by deploying the recorded prior revision, after the same restart safety gate. Config changes restore from timestamped private backups. Database backups are retained for evidence; no database rollback occurs unless schema compatibility and the recovery plan explicitly allow it. Suppressed-payload telemetry is additive and can be ignored by older code.

## Acceptance criteria

- A missing instruction file cannot survive CREATE, PATCH, live lint, or restart preflight.
- The configured secondary administrator is identified as `administrator` through both phone-JID and LID delivery without identifier disclosure.
- Identical streamed/result payloads produce one outbound operation and one WhatsApp message.
- A replied inbound event cannot complete without one linked terminal echoed operation.
- Any historical safe nonterminal outbound operation blocks restart.
- Fleet verification distinguishes healthy, degraded, failed, not-applicable, and inconclusive hosts with revision and canary evidence.
