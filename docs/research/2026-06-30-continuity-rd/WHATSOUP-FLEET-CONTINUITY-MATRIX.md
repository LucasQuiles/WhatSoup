# WhatSoup Fleet Continuity Matrix

Date: 2026-06-30
Status: PARTIAL_WITH_DEBT

## Continuity Modes

| Mode | Trigger | User impact | Safe fallback | Owner gate |
|---|---|---|---|---|
| NORMAL | Baileys connected, model usable, outbound queue healthy | no impact | monitor only | no |
| DEGRADED_AUTH | auth-bond stale, reconnect churn, or device_removed detected | bot may miss or delay replies | stop relink loops, preserve auth artifacts, notify operator | relink/auth mutation |
| DEGRADED_SEND | receive path ok but send path risky or failing | replies delayed | queue outbound, mark pending, avoid duplicate sends | live send retry |
| READ_ONLY_MONITOR | sends disabled but health/thread reads available | no bot replies, evidence preserved | read-only probes, status only | no |
| QUEUE_ONLY | client unavailable but app can enqueue intent | delayed user service | durable queue plus explicit undelivered status | sending drain |
| HUMAN_REVIEW_QUEUE | automated send path unsafe | human must approve/perform replies | operator queue with safe summaries | every send |
| LINE_QUARANTINED | line banned, restricted, or evicting companions | line unavailable | isolate line, stop retries, preserve evidence | new line or migration |
| BOT_DISABLED_SAFE | bot runtime unsafe or unknown | bot unavailable | clear status and no-send guard | restart/re-enable |
| FLEET_FAILSAFE | systemic Baileys degradation | broad service interruption | disable automated WhatsApp sends, switch alert plane/queue/human review; use SMS/Cloud API only where pre-provisioned | broad failover |

## Fallback Ranking

| Rank | Option | Why |
|---:|---|---|
| 1 | Non-WhatsApp alert plane for operator paging | removes the most critical continuity path from Baileys dependency and can be decoupled from WhatsApp |
| 2 | Queue-only plus human-review queue | preserves user intent and avoids unsafe duplicate automated sends; can work before alternate transports are live |
| 3 | Twilio SMS fallback for eligible 1:1 workflows | code path exists, but current fleet configs do not mount it and live compliance status is unproven |
| 4 | Cloud API adapter for business-compatible workflows, including a separate Groups API research track | official path, but must be pre-provisioned; existing consumer-group migration is unproven |
| 5 | Baileys hardening/canary | useful for protocol-break mode, not for account-specific enforcement/ban modes |
| 6 | Android bridge | can preserve consumer UI/group workflows, but operationally fragile and high burden |

## Failure-Mode Mapping

| Failure | Class | Current safe response | Missing control |
|---|---|---|---|
| One line banned | WhatsApp account/line | LINE_QUARANTINED, no blind retries | inventory-backed line isolation |
| One bot loses auth | Baileys/session | DEGRADED_AUTH, artifact pack, trust-note relink | auth-bond doctor tied to inventory |
| One host dies | companion host/service | READ_ONLY_MONITOR from other surfaces if available | host failover/runbook |
| Phones reachable but auth gone | phone/control plane | preserve evidence, operator-approved relink | durable phone inventory |
| Web automation blocked | client strategy | queue/human review/non-WhatsApp alert plane | alternate official transport |
| Baileys unusable fleet-wide | strategic dependency | FLEET_FAILSAFE | tested fallback transport |

## Q Mode Split

CONFIRMED from Q collaboration and local checks: "Baileys failed tomorrow" is not one incident class.

| Failure mode | Best immediate response | What does not solve it |
|---|---|---|
| Per-account de-link / companion removal | quarantine line, stop blind re-pair treadmill, queue/human-review affected workflows | rc bump alone, if WhatsApp is enforcing account/client fingerprint |
| Fleet-wide protocol break | version canary, rc bump, no-send staging proof | new number, if protocol is broken globally |
| Number ban/restriction | line quarantine and migration plan | companion fallback on the same line |

## Group Dependency Proof

CONFIRMED by personal-instance MCP `list_chats` census:

```text
total_chats=100
groups=72
direct_or_other=28
group_message_count=41505
direct_message_count=7197
active_groups_7d=28
active_direct_7d=18
```

Implication: SMS should be treated as a 1:1 notification or human-review
continuity path. Cloud API should be split into two tracks: immediate
pre-provisioned 1:1/business workflows, and a separate official Groups API
research track. Neither is proven to replace the current consumer-group-heavy
operating surface today.

Reconciliation with Q's proof:

- Q used DB/store counts and also found high group dependency.
- DB census for `personal`: 94 group chat rows / 0 direct-or-other chat rows.
- DB census for `q`: 43 group chat rows / 14 direct-or-other chat rows.
- MCP and DB disagree on exact `personal` direct-chat coverage, so exact counts are surface-dependent.
- The decision does not change for current operations: every checked surface is
  group-heavy enough that SMS cannot be a group-orchestration replacement, and
  Cloud Groups API remains unproven for the existing consumer groups until a
  no-send eligibility and workflow-mapping proof exists.

## SMS Readiness Proof

CONFIRMED: the codebase contains a Twilio SMS transport and mock-backed tests, but the currently inspected live instance configs do not mount `transport: "twilio"` and do not include `twilioConfig`.

UNKNOWN: live 10DLC/toll-free verification status. Repo docs explicitly warn that US outbound SMS can be blocked until verification/registration is approved and that the mock suite does not prove live deliverability.

Verdict: SMS is not an immediate conversational failover today. It is a high-priority provisioning and proof workstream.

## Measurement Gap

Q's read-only proof and the local sweep agree that mode-1 frequency is not fully measured. Journald/log retention is too short and `heal_reports` does not capture disconnect/auth-loss events as a durable rate table.

Recommended continuity instrumentation:

```text
event table: auth_loss_signal
fields: instance_label, host, timestamp, classifier_enum, reason_enum, confidence
source: existing auth-loss-signals classifier edge
guardrail: no JIDs, phone numbers, message bodies, or auth contents
acceptance: 2-3 weeks of queryable per-instance auth-loss cadence
negative test: one continuously flapping logged-out session inserts exactly one row
```

This is the cheapest next experiment if we want to rank Baileys fallback urgency from measured fleet data rather than short retained logs.

## Immediate Continuity Gap

CONFIRMED: WhatSoup has partial fallback components, but no single orchestrated continuity state machine that ranks transport paths, captures user intent, and safely degrades across Baileys failure.

CONFIRMED: the current crash-recovery path can fail a stranded inbound without producing a user-facing continuity fallback. Existing test `tests/integration/crash-recovery.test.ts -t "processing inbound with no terminal op is marked failed on preConnectRecovery"` passed with `CRASH_GAP_TEST_EXIT=0`; it asserts the current behavior is `processing -> failed` when no terminal outbound op exists.

CONFIRMED: a durable stuck-reply queue already exists on the Stop-hook path. Targeted test `tests/hooks/rgp-hooks.test.ts -t "enqueues a stuck-reply intent"` passed with `RGP_QUEUE_TEST_EXIT=0`.

Continuation proof, 2026-06-30 03:11 EDT:

- CONFIRMED by source inspection: runtime crash paths can disarm `ReplyGuaranteeManager` and call `markInboundFailed`, so the runtime watchdog does not necessarily get a chance to send or persist a fallback for those rows.
- CONFIRMED by focused tests: the hook-layer RGP queue retains failed sends and never acknowledges them as delivered without a successful drain.
- Q_INPUT_RECEIVED: the capture layer should be a separate `inbound_events`-anchored continuity queue, not the hook-layer RGP queue, because runtime-failed inbound can mean no reply was authored.
- Q_INPUT_RECEIVED: the bridge must not key on `failed` broadly; it must key only on the crash/runtime-fault edge where reply guarantee was disarmed and no terminal outbound op exists.
- Q_INPUT_RECEIVED: automatic send requires both a single-writer reply-slot CAS and deterministic transport dedupe (`clientMsgId = f(inbound id)`).
- LOCAL FALSIFIER: current source does not prove deterministic transport dedupe across recovery. `OutboundQueue` uses one generated id inside a retry loop, but not an inbound-derived id, and recovery helper paths do not pass deterministic ids.
- A/B/C PROOF: stable `inbound_events.seq` exists before runtime fault handling, but current persisted failure reason is too generic after restart. Fleet aggregate counts show broad `failed/error/no-terminal` is common, so retroactive scanning would over-capture.

Current local proof now has the restart-reclaim half of that marker-only design:

- Migration 33 adds forward-only nullable marker fields to `inbound_events`.
- `preConnectRecovery` emits `crash_reclaim_no_terminal_outbound` for `processing` rows with no terminal outbound before marking them failed.
- Negative tests prove by-design no-reply, terminal outbound, and historical generic failed rows do not mark.
- Queue creation remains slice two.
- Automatic draining remains blocked until deterministic idempotency and ack-lost ambiguity are proven.

Open continuity question: Q has been asked whether synchronous runtime-disarm marker emission is required before queue slice two. Until answered, queue implementation remains deferred.
