# Portable Startup-Notification Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the #2667 startup-notification protocol portable across the four
in-tree transports, strict about readiness, observable through health/fleet,
and free of generic-notice duplication after an intentional self-restart.

**Architecture:** Reuse the four canonical JID builders through one
configured-admin resolver, tighten `RuntimeConnection`, and place all startup
timer/settlement state in a small core controller over the deployed v1 journal.
Expose a bounded controller projection through the existing health server and
fleet poller. Keep process behavior manager-agnostic; the release runbook owns
launchd/systemd acceptance.

**Tech Stack:** TypeScript, Node.js 24, Vitest, existing JSON `/health`,
existing deployment shell/Python tooling, Markdown runbooks.

## Global Constraints

- Start from current `origin/main`; do not assume #2667 is the tip. Preserve
  unrelated changes and do not duplicate existing probes, monitors, codecs,
  JID builders, or health systems.
- `src/core/jid-constants.ts` remains the JID-builder SSOT. The new resolver
  selects existing builders only; it does not parse generic user targets.
- The v1 journal `{v:1,boots,lastNotifiedAt}` is production data. Read it
  unchanged; no migration or version rewrite. Future versions must be gated by
  `v` and fail open for service availability.
- `RuntimeConnection.getConnectionState` becomes mandatory. Do not retain
  `?.()` or `?? true` at startup/health call sites.
- `/health` is additive and privacy-safe. Do not expose JIDs, identities,
  message text, filesystem paths, raw provider errors, or bot.db correlation.
- Do not make generic waiting/failure states change normal instance-health
  severity. The rollout validator—not the fleet poller—interprets those
  notification states fail-closed.
- An intentional restart receipt settles the same journal batch before send;
  it suppresses an admin generic aggregate even when the requester differs
  from the administrator. That is an intentional “back online” policy, not an
  incident channel.
- No service-manager integration belongs in runtime code. Acceptance requires
  one launchd and one systemd receipt; Docker is inherited behavior and remains
  explicitly untested.
- The stale personal-line-watch correction is release-blocking in this same
  PR. Do not deploy, restart, message, or mutate live services without a
  separately explicit owner request.
- Treat skipped, masked, truncated, or missing test summaries as inconclusive.

---

## Task 1: Freeze the configured-admin send inventory and introduce the resolver

**Files:**

- Modify: `src/core/jid-constants.ts`
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Modify: `src/core/admin.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `src/runtimes/agent/runtime-tool-registrations.ts`
- Modify: `tests/core/jid-constants.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/config.twilio.test.ts`
- Modify: `tests/core/admin.test.ts` and the closest existing Signal/iMessage
  access-identity tests
- Modify: the existing fleet-ops PATCH normalization tests
- Modify: `tests/main-bootstrap-helpers.test.ts`
- Modify: `tests/runtimes/agent/restart-loop-guard-gate.test.ts` and
  `tests/runtimes/agent/runtime-tool-registrations.test.ts`
- Add/modify: one narrow repository inventory guard test if the existing static
  guard pattern can assert the complete adopted/scope-out list without
  duplicating behavior tests

1. Before changing source, record a fresh `rg` inventory of
   `toPersonalJid(...admin`, `config.adminPhones`, `adminJid`, and direct
   administrator `sendTracked` calls. Compare it against the approved list:
   main introduction/startup; restart-loop guard; HEAL timeout; HEAL tool
   registration; and `resolveAdminChatJid` all adopt. Access replay,
   control-peer/loop routing, fleet config normalization, and inbound parsing
   remain named scope-outs. Stop if a new configured-admin send lacks a
   disposition.
2. Add failing table-driven resolver tests proving exact outputs for Baileys,
   Signal, Twilio, and iMessage. Include a Twilio `+E.164@sms` target and an
   iMessage AppleID target so the test rejects an accidental WhatsApp suffix.
3. Add failing configuration tests: iMessage admits an AppleID email and an
   E.164 identity, canonicalizes the email through
   `canonicalizeImessageDirectIdentity`, and rejects an invalid value. Reuse
   that shared helper; do not add a local email regex, phone parser, or broaden
   non-iMessage identity rules. Add the corresponding fleet PATCH ingress
   regression so an AppleID and a phone-shaped value remain loader compatible.
   The create-line route's default-Baileys-only transport model is
   a named scope-out, not an implicit iMessage creation promise.
4. Implement one exported resolver in `jid-constants.ts`, type-only importing
   `TransportId` if necessary. Map only to `toPersonalJid`, `toSignalJid`,
   `toSmsJid`, and `toImessageJid` as declared in the design. Remove the local
   `main.ts` helper.
5. Adopt the resolver at every listed send site. Thread a resolver/JID
   dependency into `runtime-tool-registrations.ts` from its existing runtime
   composition root rather than importing/reimplementing transport selection
   in a registration leaf.
6. Refactor `resolveAdminChatJid` so a history lookup is restricted to the
   selected transport namespace, then falls back to the resolver. Retain LID
   lookup only for Baileys. Add a regression test that a foreign WhatsApp row
   cannot become the fallback target for an iMessage or Twilio administrator.
7. Run the focused configuration, JID, admin, main-bootstrap, restart-loop,
   and registration suites. Re-run the inventory command and make the guard
   fail if a new configured-admin direct send appears without an explicit
   disposition.

## Task 2: Tighten the readiness contract at the shared boundary

**Files:**

- Modify: `src/transport/runtime-connection.ts`
- Modify: `src/core/health.ts`
- Modify: all affected test fixtures that construct `RuntimeConnection`
- Modify: existing connection-factory/coverage tests, likely
  `tests/transport/connection-coverage.test.ts`
- Modify: `tests/core/health.test.ts`

1. Add failing compile/behavior coverage that treats a missing connection state
   method as invalid. Replace the legacy health test that expected synthetic
   success without `getConnectionState`.
2. Make `getConnectionState(): ConnectionStateSnapshot` mandatory on
   `RuntimeConnection`. Update test doubles explicitly with connected or
   disconnected state; never add a default stub in production code.
3. Make `HealthDeps` and startup consumers use the strict contract directly;
   delete optional invocation and synthetic connected fallbacks.
4. Extend the existing production connection-factory coverage to instantiate
   Baileys, Twilio, Signal, and iMessage and assert that each exposes a
   callable state method returning the expected bounded snapshot fields. This
   is the runtime backstop for adapters that bypass static typing.
5. Deliberately leave the separate scheduler connection interface unchanged;
   its optional state behavior is outside this runtime-connection contract.
6. Run focused health and transport coverage tests, then `npm run typecheck`.
   A missing final result or masked failure is inconclusive.

## Task 3: Extract the startup lifecycle into one fake-clock controller without changing v1 data

**Files:**

- Modify: `src/core/startup-notify.ts`
- Add: `src/core/startup-notification-controller.ts`
- Modify: `src/main.ts`
- Modify: `tests/core/startup-notify.test.ts`
- Add: `tests/core/startup-notification-controller.test.ts`
- Modify: `tests/main-bootstrap-helpers.test.ts`

1. Add v1 journal fixtures using exactly `{v:1,boots,lastNotifiedAt}`. Test
   that an existing v1 record is read, updated, and persisted without a schema
   migration; missing/corrupt/unsupported reads are bounded diagnostics that
   do not throw or overwrite an unknown-version source record.
2. Write fake-clock/fake-timer controller tests before implementation for this
   matrix:

   | Scenario | Required result |
   | --- | --- |
   | clean boot and connected through window | one generic send and one persisted watermark |
   | repeated boots before eligibility | one aggregate, using all v1 boot records |
   | disconnected at eligibility then reconnect | no send while disconnected; timer re-arms and later sends once |
   | zero configured window | existing three-second minimum, never synchronous send |
   | pending resume message | prompt continuity send settles batch; no later generic aggregate |
   | intentional `restart_self` receipt | prompt requester receipt settles batch and suppresses later generic aggregate |
   | intentional receipt after previous unnotified flaps | receipt settles the entire batch; no separate administrator aggregate |
   | controller stop | pending timer is cancelled and cannot send afterward |
   | journal issue | process-side controller remains available and reports bounded non-green notification evidence |

3. Keep `startup-notify.ts` as the v1 codec/message composer. If it needs a
   diagnostic result, expose a small typed read/write result rather than a
   second parser or a filesystem read in the controller. Preserve its
   fail-open service-availability behavior and v1 on-disk schema.
4. Implement `StartupNotificationController` with injected clock, scheduler,
   strict readiness port, journal port, and tracked-send port. It is the only
   owner of startup timer handles, boot settlement, eligibility calculation,
   and its health snapshot. It must not import a service manager, database,
   provider bridge, or transport builder.
5. Replace main's independent generic/resume/restart timers with one controller
   construction and calls for boot, resume policy, and intentional-restart
   receipt policy. Ensure receipt settlement happens before dispatch and that
   a requester different from the administrator receives no follow-on generic
   administrator message.
6. Keep message text composition in the existing composer and send semantics in
   the existing `sendTracked` path. A successful await means a tracked provider
   submission attempt, not delivery correlation.
7. Run the new controller suite, existing startup-notify suite, and main
   bootstrap suite under the pinned Node runtime.

## Task 4: Publish one bounded startup projection through health and fleet

**Files:**

- Modify: `src/core/health.ts`
- Modify: `src/main.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `src/fleet/health-poller.ts` only if the cache/projection test proves
  the existing pass-through drops the new field
- Modify: `tests/fleet/health-poller.test.ts` and/or
  `tests/fleet/health-poller-branches.test.ts`

1. Add exact-shape tests for an always-present `startupNotification` object:
   `state`, `policy`, `stabilitySeconds`, `bootCountSinceNotification`,
   `lastBootAt`, `lastNotifiedAt`, `nextEligibleAt`, and `lastDeliveryAt`.
   Cover `not_applicable`, `disabled`, waiting, intentional receipt,
   delivered, delivery failure, and journal-unreadable states.
2. Add negative assertions that the JSON has no JID, phone/email identity,
   message body, journal pathname, raw exception/provider text, or bot.db
   field. Confirm existing health status/reasons do not flip solely for a
   normal wait or notification-side failure.
3. Define the projection type in the controller/core health boundary and pass
   it through `HealthDeps`. Do not duplicate state inference in health.ts or
   main.ts.
4. Add a fleet poller test with the additive object. Assert it is retained in
   the existing cached snapshot/API projection and that ordinary waiting state
   is not classified as an outage. If that passes without source change, leave
   `health-poller.ts` untouched; this is the intended reuse-first result.
5. Do not add a poller, bot.db reader, delivery correlator, or generic health
   reason for notification state. Run focused core-health and fleet suites.

## Task 5: Add the one-shot, fail-closed rollout validator and portable runbooks

**Files:**

- Add: a narrowly scoped deployment validator under `deploy/scripts/` only if
  no existing release validator can consume the new health/journal contract
  without duplication
- Modify: its focused unit tests under `deploy/scripts/tests/` or
  `tests/scripts/`
- Modify: `deploy/bot-errors-runtime-manifest.json` and its parity tests only
  if the chosen deployed script is a managed runtime artifact
- Modify: `docs/configuration.md`
- Modify: `docs/runbooks/personal-line-watch.md`
- Modify: `docs/runbooks/release-deployment.md`

1. First inspect existing release health validators and manifests. Reuse one if
   it can make exact assertions without changing its unrelated health
   classification. Otherwise add one one-shot validator with a JSON interface
   that reads a supplied `/health` body and a supplied v1 journal path; it must
   not make network calls or write state in unit tests.
2. Write fixtures that make the validator fail closed for a missing/malformed
   startup object, unknown enum, `journal_unreadable`, `delivery_failed`, no
   applicable boot timestamp, bad/missing v1 journal, and watermark/timestamp
   mismatch. Add one passing controlled clean-restart fixture. Exit/status and
   JSON output must distinguish invalid input from a failed assertion;
   neither may yield green.
3. If a new deploy script is selected, follow existing deploy-manifest policy:
   add required path/hash/marker and prove bundle/deployer parity. Do not bolt
   startup semantics into the keychain-heal health classifier or create a
   periodic monitor.
4. Update configuration documentation for each transport's configured admin
   identity/JID behavior, the health object, and the named distinction between
   generic/resume/intentional-restart settlement.
5. Replace the stale runbook claim that rapid restarts normally yield a burst
   of identical startup messages. State the current aggregate behavior,
   stability delay, receipt exception, and health troubleshooting path without
   promising provider delivery correlation.
6. Add the launchd and systemd acceptance checklist to release deployment:
   exact release identity, queue-drain/rollback preconditions, one controlled
   restart, fail-closed health/journal assertion at eligibility, and preserved
   receipt. Mark Docker inherited but untested. Do not include manager commands
   in the runtime protocol.
7. Run focused validator, manifest, deployment parity, and documentation-link
   checks available in the repository. Confirm no test output is masked.

## Task 6: Cross-contract verification, review, and handoff

1. Run the adopted JID/config/admin/routing tests, strict connection and health
   tests, startup controller fake-clock matrix, fleet cache tests, and rollout
   validator tests. Then run `npm run typecheck`,
   `npm run guard:lint:src`, relevant deployment manifest guards, and the
   repository's prescribed branch verification gate.
2. Re-run the configured-admin send inventory against the final tree. Every
   result must either use the resolver or match a named scope-out in this plan;
   a newly discovered unnamed result blocks completion.
3. Inspect the final diff for a second JID formatter, a second startup timer,
   a duplicate journal reader, new bot.db correlation, a manager-specific
   runtime branch, or stale wording. Remove only code introduced by this work
   if consolidation reveals it; do not erase unrelated user changes.
4. Capture release acceptance as separate operational evidence after explicit
   owner approval: one launchd receipt and one systemd receipt. Until both
   exist, report source verification complete but portability acceptance
   pending. Docker remains untested, not failed or implicitly certified.
5. Before commit or PR, inspect `git diff --check`, exact-head status, and all
   command exit summaries. Any skipped, masked, truncated, or absent final
   summary is inconclusive and must be rerun or disclosed. Commit only scoped
   public-safe changes, using the SSH remote for any later push.
