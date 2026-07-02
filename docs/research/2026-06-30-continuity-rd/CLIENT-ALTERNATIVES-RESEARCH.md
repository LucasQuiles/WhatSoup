# Client Alternatives Research

Date: 2026-06-30
Status: PARTIAL_WITH_CURRENT_SOURCES

## Option Matrix

### Option: Continue Baileys with hardening

- viability: HIGH for existing fleet where accounts still hold.
- implementation effort: LOW to MEDIUM.
- user continuity: good until enforcement worsens.
- ban/enforcement risk: HIGH, because unofficial-client risk remains.
- auth complexity: HIGH.
- message-send reliability: variable.
- media support: good when connected.
- group support: good when connected.
- operational burden: high relink/auth-bond burden.
- migration path: keep current runtime, add stronger gates and canaries.
- rollback path: pin previous Baileys/protocol version.
- proof experiment: rc13 no-send canary on staging/disposable account.
- kill criteria: 401/device_removed within 60 seconds on staging twice.

Current rc13 delta, 2026-06-30:

- WhatSoup is still pinned to Baileys `7.0.0-rc12`; npm reports `7.0.0-rc13` as `latest`.
- Baileys `v7.0.0-rc13` release notes describe a small `protocolMessage` parsing regression fix, not a `device_removed` or pairing-retention fix.
- Current rc13 community issues still include pairing-code failure (`requestPairingCode` succeeds but the phone cannot link, ending in `408`) and pairing-handler crash on malformed/partial `link_code_companion_reg` notifications.
- Strategy impact: rc13 belongs in a disposable/staging no-send canary with explicit kill criteria. It should not be treated as a production recovery fix without measured hold/liveness proof.

### Option: Baileys fork or patch

- viability: UNKNOWN.
- implementation effort: MEDIUM.
- user continuity: uncertain.
- ban/enforcement risk: HIGH unless fork changes detectable behavior materially.
- auth complexity: HIGH.
- message-send reliability: unknown.
- media support: unknown.
- group support: likely similar to Baileys.
- operational burden: high.
- migration path: dependency branch and one-bot canary.
- rollback path: dependency pin revert.
- proof experiment: compare connect stability and no-send health over 24 hours.
- kill criteria: no measurable improvement over current Baileys.

### Option: whatsapp-web.js

- viability: MEDIUM for experiments, LOW as strategic escape.
- implementation effort: MEDIUM to HIGH.
- user continuity: possible for WhatsApp Web parity.
- ban/enforcement risk: HIGH because it is still unofficial Web automation.
- auth complexity: MEDIUM to HIGH.
- message-send reliability: community reports session persistence and readiness issues.
- media support: good when stable.
- group support: good when stable, but LID/new-group edge cases exist.
- operational burden: browser/Puppeteer operations.
- migration path: shadow client on disposable/staging line.
- rollback path: no production cutover.
- proof experiment: read-only/no-send session hold test on disposable account, with explicit ready-vs-still-actionable liveness checks.
- kill criteria: session invalidation, ban/restriction signal, or headless instability.

Current community delta, 2026-06-30:

- whatsapp-web.js has adjacent immediate-logout reports: #5682 authenticates, fires ready, and then emits LOGOUT almost immediately; #3991 reports automatic logout after 30s-1m. Sources: https://github.com/wwebjs/whatsapp-web.js/issues/5682 and https://github.com/wwebjs/whatsapp-web.js/issues/3991
- The current issue list also includes a 2026 ghost-connection class where the socket appears on but cannot perform sends after idle. Source: https://github.com/wwebjs/whatsapp-web.js/issues
- The official whatsapp-web.js auth docs emphasize that persistence requires `LocalAuth` or `RemoteAuth`; default auth does not persist sessions. Source: https://wwebjs.dev/guide/creating-your-bot/authentication.html
- Implication: wwebjs is useful as a comparison client for diagnosing "Baileys-specific protocol handling" versus "unofficial Web automation class risk", but it should not be treated as a production failover without a dedicated canary, liveness model, and no-send proof.

### Option: WhatsApp Business Cloud API

- viability: HIGH for official business-compatible 1:1 workflows if pre-provisioned; LOW as a same-day rescue for a live consumer line.
- implementation effort: HIGH.
- user continuity: strong for supported 1:1 workflows, templates, webhooks.
- ban/enforcement risk: lowest among WhatsApp options if policy-compliant.
- auth complexity: WABA, business phone number, tokens, webhooks, templates.
- message-send reliability: official API path.
- media support: supported for many message types by official docs.
- group support: possible through the official Groups API surface, but not proven
  for current consumer-group continuity; requires Cloud API business number,
  group eligibility, webhook, and policy proof.
- operational burden: Meta app, business verification, template approval, pricing.
- migration path: add new transport adapter and workflow eligibility map using separate/pre-provisioned business numbers.
- rollback path: keep Baileys for consumer/group workflows during coexistence.
- proof experiment: local adapter contract against mocked Cloud API, no live send; separately verify Meta number/migration constraints before any live plan.
- kill criteria: required workflows are group/personal-presence bound and cannot map, or plan requires reusing a live consumer number as an emergency fallback.

Current official/provider delta, 2026-06-30:

- Twilio's WhatsApp Business Platform docs describe three products: consumer WhatsApp, WhatsApp Business app, and WhatsApp Business Platform / API. The API path requires WhatsApp-enabled senders and a Meta Business Manager / WABA onboarding surface. Source: https://www.twilio.com/docs/whatsapp/api
- Twilio documents explicit opt-in requirements and warns that messaging users without opt-in can lead to blocks and WhatsApp Business account suspension. Source: https://www.twilio.com/docs/whatsapp/api
- Business-initiated notifications generally require pre-registered templates except replies inside the customer-service window; freeform messaging is available inside the session window. Source: https://www.twilio.com/docs/whatsapp/api
- Twilio documents a 24-hour customer-service window after the most recent inbound user message, fallback webhook URLs for inbound delivery failures, and media support with size/type limits. Source: https://www.twilio.com/docs/whatsapp/api
- Twilio also documents account/number limits and says WhatsApp can restrict numbers/WABAs at its discretion for scam or severe-spam signals. Source: https://www.twilio.com/docs/whatsapp/api

Strategy impact: official API/Twilio paths are strong for pre-provisioned 1:1 continuity and operator notifications, but they are not a same-day replacement for consumer-line group orchestration. A Cloud/Twilio spike should therefore prove adapter contracts, webhook/fallback handling, opt-in/template posture, and workflow eligibility before any live-number plan.

Current official Groups API delta, 2026-06-30 15:39 EDT:

- Meta's current WhatsApp Business Platform docs expose a Groups API surface for
  programmatic group creation/management and group messaging/webhooks. Sources:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/groups,
  https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging/,
  and https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started.
- The same docs indicate the Groups API is tied to a business number in Cloud
  API, not the WhatsApp Business app. This keeps it in the "pre-provisioned
  official path" category rather than the "same-day rescue for an existing
  consumer group" category.
- Strategy correction: do not state that Cloud API is inherently 1:1-only. The
  accurate current claim is narrower: WhatSoup has no Cloud API transport today,
  and no proof that existing consumer-group orchestration can be migrated or
  mirrored through Business Platform Groups API without onboarding, policy, and
  workflow redesign.

### Option: Twilio SMS transport

- viability: MEDIUM for emergency 1:1 notifications after provisioning; LOW as an immediate conversational fallback today.
- implementation effort: LOW to MEDIUM because local docs and transport exist.
- user continuity: partial; WhatsApp groups/media lost.
- ban/enforcement risk: not WhatsApp.
- auth complexity: Twilio credentials and phone/SMS setup.
- message-send reliability: good only if configured, credentialed, rate-limited, and US registration/verification is approved.
- media support: limited.
- group support: no WhatsApp group parity.
- operational burden: delivery status/rate-limit gaps remain.
- migration path: provision a separate SMS continuity instance or explicit per-workflow fallback; do not assume existing WhatsApp instances can flip today.
- rollback path: switch transport config back after proof.
- proof experiment: no-send readiness proof: live config present, keyring credential present, sender registered/verified.
- kill criteria: no live config, missing credential, unapproved 10DLC/toll-free verification, or workflow depends on WhatsApp group context/media.

Updated boundary, 2026-06-30:

- Do not label SMS or Twilio WhatsApp as "fleet continuity" unless the target workflow is 1:1, opt-in/registration status is proven, and the operator-facing queue can preserve intent without group context.
- The safest next proof is still no-send readiness: config present, credentials present without printing values, sender status proven, template/opt-in requirements documented, and a mock/webhook artifact showing how failed delivery becomes a human-review item.

### Option: Android-device automation bridge

- viability: LOW to MEDIUM as break-glass.
- implementation effort: HIGH.
- user continuity: can operate the official mobile app UI.
- ban/enforcement risk: uncertain; UI automation may still be risky.
- auth complexity: phone fleet, ADB, UI state, permissions.
- message-send reliability: fragile.
- media support: manual/UI dependent.
- group support: possible through app UI, brittle.
- operational burden: high.
- migration path: operator-assisted queue only, not autonomous send.
- rollback path: disable bridge and retain read-only phone control.
- proof experiment: screenshot-only group navigation, no send.
- kill criteria: UI drift, privacy exposure, or unreliable targeting.

### Option: Human-in-the-loop queue

- viability: HIGH as universal fallback.
- implementation effort: MEDIUM.
- user continuity: slower but safer.
- ban/enforcement risk: low if humans use official clients.
- auth complexity: low to medium.
- message-send reliability: human-dependent.
- media support: human-dependent.
- group support: possible through official clients.
- operational burden: high during incidents.
- migration path: queue intents and safe summaries to operators.
- rollback path: resume automated send when safe.
- proof experiment: local queue simulation and operator packet artifact.
- kill criteria: queue latency unacceptable or summaries insufficient.

## Top Strategic Conclusion

LIKELY: the durable strategy is hybrid, not replacement:

1. Keep Baileys for workflows that need consumer/group parity while it works.
2. Move critical alerting and eligible 1:1 workflows to official or non-WhatsApp channels.
   Evaluate Business Platform Groups API separately for future official group
   workflows; do not treat it as an immediate replacement for existing consumer
   groups.
3. Add queue/human-review fallback so users are not dropped when the live client fails.

## Q Collaboration Update

CONFIRMED: Q responded and ranked fallbacks by failure mode, not as one universal list.

Current synthesized ranking:

| Failure mode | First useful option | Why |
|---|---|---|
| Per-account Baileys companion enforcement | line quarantine + queue/human review + non-WA alert | re-pairing repeats the same detection loop |
| Fleet-wide Baileys protocol break | rc canary / version bump after no-send proof | this is the only mode where Baileys rc movement directly helps |
| Number ban | line migration / alternate official or non-WA path | same-line companion fallback does not save a banned line |
| Critical operator alert continuity | non-WA alert plane | removes paging from WhatsApp/Baileys dependency |
| 1:1 user conversational floor | SMS only after E5 readiness proof | current configs do not mount Twilio and provider status is unknown |
| Group orchestration continuity | human-in-loop / official client / Android-assisted workflow now; Cloud Groups API research for future official groups | SMS does not preserve groups; Cloud Groups API exists but current consumer-group migration is unproven |
