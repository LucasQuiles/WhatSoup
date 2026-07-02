# Cloud Groups API Eligibility Map

Date: 2026-06-30 15:41 EDT
Status: READ_ONLY / NO_SEND / NO_META_MUTATION / INITIAL_MAP

## Purpose

Correct the fallback model without over-claiming it. Meta's current WhatsApp
Business Platform documentation exposes a Groups API surface, so "Cloud API is
1:1-only" is no longer an accurate planning statement. The accurate current
statement is narrower: WhatSoup has no Cloud API transport today, and there is
no proof that the existing consumer WHATSOUP group workflows can be migrated or
mirrored through Business Platform Groups API without onboarding, policy, and
workflow redesign.

## Sources

- Meta Groups API overview:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/groups
- Meta group messaging docs:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging/
- Meta Groups API get-started docs:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started
- Local transport registry: `src/transport/registry.ts`
- Local transport factory: `src/transport/factory.ts`

## Observed Facts

- Current Meta docs expose a WhatsApp Business Platform Groups API surface for
  group creation/management, group messaging, and webhooks.
- The get-started documentation ties Groups API use to a business number in
  Cloud API, not the WhatsApp Business app.
- WhatSoup local transport IDs are currently `baileys` and `twilio` only.
- WhatSoup local transport factory only constructs Baileys `ConnectionManager`
  and `TwilioConnection`; no Cloud API or Groups API adapter exists locally.
- The active Q/WHATSOUP collaboration path is a consumer WhatsApp group reached
  through the `personal` instance. No evidence proves that existing consumer
  group identifiers or memberships can be reused by Business Platform Groups
  API.

## Eligibility Matrix

| Workflow | Current status | What is known | What remains unproven |
|---|---|---|---|
| Existing consumer WHATSOUP group continuity | UNKNOWN / UNPROVEN | Current group path works through Baileys-backed consumer WhatsApp surfaces | Whether Business Platform Groups API can mirror, migrate, or preserve the same group/membership/history |
| New official business group creation | SUPPORTED_BY_DOCS / LOCAL_ABSENT | Meta documents Groups API creation/management surfaces | Business account, number, webhook, eligibility, policy, and local adapter readiness |
| Group message send through official API | SUPPORTED_BY_DOCS / LOCAL_ABSENT | Meta documents group messaging via the official API surface | WhatSoup payload mapping, opt-in/policy constraints, rate/pricing behavior, and no-send contract tests |
| Group message receive through webhooks | SUPPORTED_BY_DOCS / LOCAL_ABSENT | Meta documents webhook-based API workflows | Webhook contract, identity mapping, privacy/redaction handling, and replay-safe persistence |
| 1:1 business-compatible continuity | SEPARATE OFFICIAL PATH | Cloud/Twilio WhatsApp API can be evaluated for eligible 1:1 workflows | Provisioning, template/session-window policy, opt-in, credentials, adapter implementation |
| SMS fallback | NOT A GROUP PATH | Twilio SMS can support some emergency 1:1 notification workflows after provisioning | Group parity, media parity, and conversational WhatsApp continuity |

## Required No-Send Proofs Before Implementation

1. Account/number eligibility proof that does not create groups, send messages,
   invite users, mutate Meta app state, or print credentials.
2. Local adapter contract tests against mocked Cloud Groups API responses only.
3. Workflow map from current group-heavy WhatSoup operations to official API
   groups, including identity mapping, privacy boundaries, and unsupported
   history/membership assumptions.
4. Webhook contract tests for inbound group messages and delivery/status events.
5. Policy matrix for opt-in, templates, customer-service windows, group
   invitation rules, pricing, and account restrictions.
6. Redaction tests proving no raw WhatsApp identifiers, phone numbers, auth
   files, access tokens, message bodies, or webhook secrets enter artifacts.

## Kill Criteria

- Any live Meta app, WABA, phone-number, group, invite-link, webhook, credential,
  or message mutation is required before explicit owner approval.
- The proof requires sending a live message or creating/inviting a real group.
- Existing consumer-group continuity is claimed without a concrete mapping proof.
- A local adapter test needs real credentials or network calls instead of mocks.
- Artifact output includes raw IDs, phone numbers, message bodies, auth paths, or
  credential values.

## Planning Implication

Cloud Groups API is a legitimate future official-group research track. It is
not currently a same-day replacement for the live consumer-group-heavy WhatSoup
surface, because the local adapter does not exist and the existing group
continuity/migration assumptions are unproven.
