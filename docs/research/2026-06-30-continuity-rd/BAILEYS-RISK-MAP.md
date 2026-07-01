# Baileys Risk Map

Date: 2026-06-30
Status: PARTIAL_WITH_SOURCES

## Local Evidence

| Evidence | Status | Source |
|---|---|---|
| WhatSoup currently depends on Baileys rc12 | CONFIRMED | `package.json` dependency read locally: `@whiskeysockets/baileys` = `7.0.0-rc12` |
| npm latest is rc13 | CONFIRMED | clean rerun: `npm view @whiskeysockets/baileys version dist-tags --json`; `NPM_VIEW_EXIT=0`, `latest: 7.0.0-rc13` |
| ad-bot new line keeps official Web but loses Baileys in seconds | CONFIRMED locally, mechanism INFERRED | `scratchpad/auth-bond-migration/INVESTIGATION.md` |
| WhatSoup has only `baileys` and `twilio` transport IDs | CONFIRMED | `src/transport/registry.ts`, `src/transport/factory.ts` |
| Reply Guarantee exists above runtime transport | CONFIRMED | `docs/reply-guarantee.md` |
| Twilio SMS transport exists but has gaps | CONFIRMED | `docs/runbooks/twilio-transport.md` |
| Cloud API adapter is not present in current transport registry | CONFIRMED | `src/transport/registry.ts` |
| Meta WhatsApp Business Platform exposes a Groups API surface | CONFIRMED by current official docs, local implementation absent | Meta Groups API docs and group messaging/get-started docs; no WhatSoup transport adapter exists |
| Q collaboration path is live in WHATSOUP group | CONFIRMED | Q responded to the owner-approved personal-line prompt at 2026-06-30 05:14 UTC |
| Current fleet configs do not mount Twilio as a live instance transport | CONFIRMED | read-only config census across reachable instances found no `transport: "twilio"` / `twilioConfig` |
| Personal instance is group-heavy | CONFIRMED | MCP `list_chats` census: 72 groups of 100 chats; DB census: 94 groups of 94 chat rows; both show group dominance |
| Q instance is group-heavy in DB snapshot | CONFIRMED | DB census: 43 group chat rows, 14 direct/other rows; group message count dominates |
| DB and MCP chat inventories can disagree | CONFIRMED | `personal` MCP shows 28 direct/other rows while DB chat table shows 0 direct/other rows; treat exact counts as surface-dependent |

## Ecosystem Evidence

Primary/current sources used:

- Baileys docs: https://baileys.wiki/docs/socket/connecting/
- Baileys connection lifecycle docs: https://whiskeysockets-baileys-94.mintlify.app/concepts/connection
- Baileys issue #2248: https://github.com/WhiskeySockets/Baileys/issues/2248
- Baileys issue #2140: https://github.com/WhiskeySockets/Baileys/issues/2140
- Baileys issue #2110: https://github.com/WhiskeySockets/Baileys/issues/2110
- Baileys issue #1895: https://github.com/WhiskeySockets/Baileys/issues/1895
- Baileys issue #1052: https://github.com/WhiskeySockets/Baileys/issues/1052
- WhatsApp official unofficial-app warning: https://faq.whatsapp.com/1217634902127718
- Meta WhatsApp Business Platform overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform
- Meta WhatsApp Business Platform groups docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups
- Meta WhatsApp message API docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api/

Incremental community check, 2026-06-30 02:44 EDT:

- Baileys #2248 (opened Jan 9, 2026) is a very close external analogue: QR pairing succeeds, credentials are saved, connection opens, then WhatsApp closes with `401` and `conflict: device_removed` within seconds. The reporter also states Playwright/Chromium WhatsApp Web remains stable on the same device/network, matching the WhatSoup official-Web-vs-Baileys discriminator.
- Baileys #2110 (opened Nov 25, 2025) reports a related reconnect path where Baileys establishes a socket, but the phone/WhatsApp rejects the session and the server side sees `device_removed` plus `401 Logged Out`.
- Baileys #1895 (opened Oct 8, 2025) is the slower/chronic form: successful auth followed by recurring disconnections after minutes/actions, with reports more common under multiple active sessions.
- Baileys docs still say `loggedOut` / 401 should not be blindly reconnected, while `restartRequired` is the expected forced reconnect after QR auth. This supports Q's mode split: do not merge terminal auth loss with ordinary restart/transient reconnect.

Incremental community check, 2026-06-30 06:41 EDT:

- Baileys #2248 remains the closest analogue to the WhatSoup ad-bot discriminator: QR pairing succeeds, credentials are saved, connection opens briefly, then WhatsApp closes with `401` and `device_removed`; the reporter says Playwright/Chromium WhatsApp Web remains stable on the same device/network. Source: https://github.com/WhiskeySockets/Baileys/issues/2248
- Baileys #2381 adds a related 2026 report where QR is scannable, the connection reaches WebSocket level, then closes with `401` immediately after pairing; the reporter explicitly suspects IP rate limiting or version/browser-fingerprint rejection. Source: https://github.com/WhiskeySockets/Baileys/issues/2381
- whatsapp-web.js #5682 is an adjacent-client analogue: QR authentication succeeds, `ready` fires, then the client emits `LOGOUT` almost immediately despite fresh auth/cache and no other active Web sessions. Source: https://github.com/wwebjs/whatsapp-web.js/issues/5682
- whatsapp-web.js #3991 reports a 30s-1m automatic logout using `LocalAuth`, with WhatsApp Web version and Chromium details included. Source: https://github.com/wwebjs/whatsapp-web.js/issues/3991
- whatsapp-web.js issue list shows a 2026 "ghost connection" report where the socket appears on but cannot send after idle. Source: https://github.com/wwebjs/whatsapp-web.js/issues
- whatsapp-web.js authentication docs confirm session persistence depends on `LocalAuth`/persistent filesystem or `RemoteAuth`, not the default auth mode. Source: https://wwebjs.dev/guide/creating-your-bot/authentication.html

Interpretation: switching from Baileys to another unofficial Web automation stack is not a clean risk transfer. It may change the failure signature and implementation burden, but the community evidence shows immediate logout, auth restore, and ghost-connection classes also exist in whatsapp-web.js. A comparison client is still useful as a controlled diagnostic, but not as a strategic production escape without its own canary and kill criteria.

Incremental community check, 2026-06-30 07:50 EDT:

- Current npm/package delta is explicit: local WhatSoup is pinned to `@whiskeysockets/baileys` `7.0.0-rc12`, while npm latest is `7.0.0-rc13` with dist-tag `latest`. Command: `npm view @whiskeysockets/baileys version dist-tags --json`; exit 0.
- Baileys release notes for `v7.0.0-rc13` describe a small `protocolMessage` parsing regression fix, not a `401` / `device_removed` / pairing-retention fix. Source: https://github.com/WhiskeySockets/Baileys/releases
- Baileys #2590 is a current rc13 pairing-code report: `requestPairingCode()` succeeds, but the phone cannot link the device and the socket ends with `408 Request Time-out` / QR refs exhausted. Source: https://github.com/WhiskeySockets/Baileys/issues/2590
- Baileys #2600 is a current rc13 pairing-code crash report: a `link_code_companion_reg` notification without expected cryptographic fields crashes the handler. Source: https://github.com/WhiskeySockets/Baileys/issues/2600
- Baileys #2591 is a current rc13 reconnect/user-trust report: app-state sync on every reconnect sends repeated "Sync completed" notifications to the primary phone, and the reporter ties repeated notifications to reconnect frequency. Source: https://github.com/WhiskeySockets/Baileys/issues/2591

Interpretation: rc13 may still be worth a disposable/staging no-send canary because it is the current release, but the community delta does not justify treating rc13 as the fix for WhatSoup's acute `device_removed` class. The safer model is "version canary with kill criteria," not "upgrade as remediation."

Incremental community check, 2026-06-30 10:09 EDT:

- Baileys #2248 is still the closest published analogue to the local ad-bot discriminator: QR pairing succeeds, credentials are saved, the connection opens briefly, then WhatsApp closes with `401` and `conflict: device_removed` within seconds. The reporter also says Playwright/Chromium WhatsApp Web remains stable on the same device/network. Source: https://github.com/WhiskeySockets/Baileys/issues/2248
- Baileys #2110 reports a saved-credential reconnect variant where Baileys appears connected server-side but WhatsApp/mobile rejects the session, then the socket is revoked with `device_removed` and `401 Logged Out`. Source: https://github.com/WhiskeySockets/Baileys/issues/2110
- Baileys #2140 reports the slower v7 class: after minutes or hours, `stream:error code 401` with `conflict type=device_removed`, even when the device was not intentionally removed. Source: https://github.com/WhiskeySockets/Baileys/issues/2140
- Baileys #2370 reports registration/pairing failure with `405` across v6 and v7 RCs, across two networks, while existing WhatsApp Web sessions and manual Linked Devices flows continue to work. Source: https://github.com/WhiskeySockets/Baileys/issues/2370
- Baileys #2512 reports phone-number pairing-code failure where the code is generated and entered, but the phone shows a link failure and Baileys receives `stream:error code 515`. Source: https://github.com/WhiskeySockets/Baileys/issues/2512
- Baileys #1869 reports a ban/restriction spike including long-lived Baileys accounts and both v7 RC and v6 users. Source: https://github.com/WhiskeySockets/Baileys/issues/1869
- The Baileys repository README states the project is not affiliated with WhatsApp and discourages abusive/bulk automated use. It also reports latest release `v7.0.0-rc13` as of May 21, 2026. Source: https://github.com/WhiskeySockets/Baileys

Interpretation: the community signal now supports a four-bucket risk taxonomy, not one generic "Baileys disconnect" bucket:

1. `401/device_removed` acute eviction after apparently successful pair.
2. `401/device_removed` delayed revocation after saved-credential reconnect or hours/days of runtime.
3. registration/pairing failures before a usable session (`405`, `515`, pairing-code failure).
4. account-level ban/restriction risk.

WhatSoup should preserve separate monitoring, kill criteria, and fallback actions for each bucket. A green official Web session only falsifies "the line cannot link any companion"; it does not make the Baileys/unofficial-client bucket safe.

## Confirmed Risks

| Risk | Status | Evidence | Mitigation |
|---|---|---|---|
| Unofficial-client enforcement can affect account state or device linking | CONFIRMED in official guidance, local mechanism INFERRED | WhatsApp FAQ says unofficial apps can lead to restrictions, including ability to link devices | do not depend on Baileys as sole continuity path |
| 401/device_removed after fresh pair is seen by other Baileys users | CONFIRMED community signal | Baileys #2248, #2140, #2110, #1052 | classify as known ecosystem risk, not one-off local anomaly |
| External reports also distinguish acute seconds-after-pair eviction from slower recurring disconnections | CONFIRMED community signal | Baileys #2248 is acute; Baileys #1895 is chronic/recurring | preserve WhatSoup's FM-1 vs FM-2 split and do not use one close rule for all modes |
| Pairing/registration can fail before a durable session exists | CONFIRMED community signal | Baileys #2370 (`405`) and #2512 (`515`) | add separate `PAIRING_BLOCKED` / `REGISTRATION_BLOCKED` mode; do not collapse into auth-bond recovery |
| Ban/restriction spikes are reported by Baileys users, including long-lived accounts | CONFIRMED community signal | Baileys #1869 | keep line quarantine and non-WA fallback separate from relink/retry playbooks |
| Auth persistence is a hard requirement and demo auth helpers are not production storage | CONFIRMED | Baileys docs warn against `useMultiFileAuthState` in production | continue durable auth-bond work and proof-gated auth storage |
| WhatSoup currently lacks an official Cloud API transport | CONFIRMED | transport registry/factory only list `baileys` and `twilio` | design Cloud API adapter or non-WhatsApp fallback |
| SMS fallback is not currently deploy-ready as a conversational replacement | CONFIRMED for config absence, UNKNOWN for live provider status | no active Twilio instance config; likely keyring service names not found on checked hosts; live 10DLC/verification status not proven | treat SMS as a build/provision workstream, not instant failover |
| Current consumer-group orchestration is not proven preserved by fallback transports | CONFIRMED for SMS, UNKNOWN for future Cloud Groups API | personal/q inventories are group-heavy across DB/MCP surfaces; Meta exposes a Business Platform Groups API, but WhatSoup has no adapter and no eligibility/workflow proof | separate SMS/1:1 fallback from Cloud Groups API research and current official-client/human-review continuity |

## Suspected Risks

| Risk | Status | Reasoning | Proof gap |
|---|---|---|---|
| Fleet-wide churn is slow-form unofficial-client enforcement | SUSPECTED | same class as ad-bot but less acute; recurring loggedOut/device_removed exists | needs better log parser and account-history correlation |
| Fresh numbers may be worse than aged numbers | LIKELY | ad-bot new line was accepted by official Web but Baileys rejected; aged fleet lines hold longer | needs controlled aged-vs-fresh canary without live send |
| Baileys rc13 may reduce or shift symptoms | UNKNOWN / NOT A KNOWN FIX | latest dist-tag changed from local rc12, but rc13 notes target protocol-message parsing and current rc13 issues still include pairing/linking/reconnect trust problems | needs no-send canary in disposable/staging account; do not promote as a direct fix for `401/device_removed` |
| whatsapp-web.js may share enforcement surface | LIKELY | it also automates WhatsApp Web and has session/auth fragility issues | needs disposable account proof, not production |
| Adjacent unofficial clients can fail in ways that look usable but are not send-capable | LIKELY | whatsapp-web.js issue list reports ghost connection after idle, and issues #5682/#3991 report immediate logout after successful auth | needs no-send/readiness probe and send-disabled liveness model |

## Falsified Or Deprioritized Risks

| Risk | Status | Evidence |
|---|---|---|
| ad-bot line cannot link any companion | FALSIFIED | official Web linked and remained listed |
| ad-bot issue is only host/IP/network | FALSIFIED for observed event | official Web works, same stack holds elsewhere |
| direct Q contact is available by simple `Q` lookup | FALSIFIED | `wa-fleet resolve personal Q` exit 11 |

## Monitoring Signals

- `connection.update` close status, especially 401 with `conflict type=device_removed`.
- Reconnect count per bot per day.
- Time from open to removal.
- Baileys version and WhatsApp Web protocol version.
- Auth restore events and auth mutation diffs.
- Whether line is official-Web-linkable while Baileys is evicted.
- User-facing reply guarantee fallback notices.
- Group-vs-DM dependency ratio.
- Whether fallback transports are configured, credential-present, and compliance-approved before an incident.

## Proof Gaps

- No rc13 canary run.
- No Cloud API adapter spike.
- No Cloud Groups API eligibility/workflow-mapping spike.
- No provider-console proof of SMS 10DLC/verification status.
- No long-horizon disconnect/auth-loss event table; current logs cannot measure true healthy-line de-link rate.
- No third-party unofficial-client controlled test, and that test would be higher risk.
- qRegistry cannot currently support a "complete continuity" claim because `qregistry-check` hard-fails on the current register.
