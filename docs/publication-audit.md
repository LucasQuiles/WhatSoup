# Publication Audit

`docs/publication-audit.md` is the tracked source of truth for documentation that must be reviewed before public publication. The publication guard validates that every tracked internal documentation path has exactly one row here.

Internal publication roots covered by the guard: `docs/runbooks/`, `docs/sdlc/`, `docs/superpowers/`, `docs/plans/`, `docs/cutover/`, `docs/research/`, `docs/triage/`, `docs/specs/` (selected), `docs/work-index*`, `docs/current-program.md`, `docs/handoff-*.md`, `HANDOFF-*.md`, `docs/project-status-*.md`, `docs/audit-*.md`, `tmp/`.

**Regenerate, do not hand-merge.** Run `npm run guard:publication:write` to rewrite this file
into canonical form: rows derived from `git ls-files`, sorted, with exactly one declared-count
line and one summary block. Existing classifications and rationales are preserved verbatim; a
newly tracked doc is added as `PRIVATE-ARCHIVE` with a default rationale for you to refine.

This matters on merges. Every doc-bearing PR edits the counter lines here, so any landing
conflicts every other open PR on this file. When that happens, take either side to clear the
markers and re-run the command — the result is a fixed point, so the resolution is mechanical
rather than a hand-count. `docs/work-index.{json,md}` has the same property via
`npm run work-index:regen`.

**Total classification rows:** 348

| Classification | Count |
|---|---:|
| PUBLIC | 198 |
| PRIVATE-ARCHIVE | 150 |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | 348 |

| Path | Classification | Rationale |
|---|---|---|
| `docs/current-program.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/research/2026-04-05-sp1-media-access-minimal-investigation.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/research/2026-06-30-continuity-rd/BAILEYS-RISK-MAP.md` | PRIVATE-ARCHIVE | Internal continuity research; retained in the repository but excluded from public publication by default. |
| `docs/research/2026-06-30-continuity-rd/CLIENT-ALTERNATIVES-RESEARCH.md` | PRIVATE-ARCHIVE | Internal continuity research; retained in the repository but excluded from public publication by default. |
| `docs/research/2026-06-30-continuity-rd/CLOUD-GROUPS-API-ELIGIBILITY-MAP.md` | PRIVATE-ARCHIVE | Internal continuity research; retained in the repository but excluded from public publication by default. |
| `docs/research/2026-06-30-continuity-rd/WHATSOUP-FLEET-CONTINUITY-MATRIX.md` | PRIVATE-ARCHIVE | Internal continuity research; retained in the repository but excluded from public publication by default. |
| `docs/research/gemini-cli-stream-json-investigation-2026-04-04.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/agent-decision-polls.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/agent-job-dispatch-gap.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/error-response-workflows.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/fleet-bot-hardening-standard.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/host-maintenance.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/imessage-transport.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/knowledge-profiles.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/macos-host-setup.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/macos-launchd-deployment.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/mwlab-deployment.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/mwlab-transcription-pinecone.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/nucles-deadman.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/objective-tracking.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/personal-line-watch.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/phonectl-asset-inventory.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/pinecone-transcription-bridge.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/release-deployment.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/signal-transport.md` | PUBLIC | Sanitized operator documentation for the public Signal transport surface; contains no private topology, credentials, or internal planning references. |
| `docs/runbooks/substrate-slice-1.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/runbooks/twilio-transport.md` | PRIVATE-ARCHIVE | Internal operational runbook; retained in the repository but excluded from public publication by default. |
| `docs/sdlc/closed/fleet-charts-20260407/state.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-09-fleet-topology-control-plane-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-09-settings-migration-framework-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-10-compatibility-deprecation-policy-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-10-public-release-readiness-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-29-harness-maintenance-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-30-codex-npm-cooldown-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-30-mcp-ops-hygiene-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-05-30-systemd-unit-reconciliation-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-06-10-twilio-transport-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-06-16-handoff-distiller-wiring-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-07-03-openai-compatible-byok-providers-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-07-05-onboarding-safety-firstrun-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/specs/2026-07-09-safe-initialization-capability-lifecycle-remediation-design.md` | PRIVATE-ARCHIVE | Internal planning and security-sensitive remediation design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-04-07-fleet-charts-guidelines.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-04-07-fleet-charts-kickoff.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-04-07-fleet-charts-project-statement.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-04-07-fleet-charts-sop.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-07-15-semantic-boundary-hygiene-implementation-notes.md` | PRIVATE-ARCHIVE | Internal semantic-boundary measurements, implementation evidence, limitations, and promotion decision; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md` | PRIVATE-ARCHIVE | Internal boundary-contract falsifiers, implementation ledger, output measurements, limitations, and authorization boundary; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md` | PRIVATE-ARCHIVE | Internal boundary-core GitHub and Git-history evidence, implementation notes, limitations, and rollout boundary; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-07-28-incident-control-plane-finder-report.md` | PRIVATE-ARCHIVE | Internal Plans 2-7 completeness map for the incident control plane (requirement classification, reuse anchors, sequencing constraints); retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-04-colony-orchestration-phase1.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-05-phase4-m2-websocket-console.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-05-phase4-realtime-performance.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-05-phase5-analytics-observability.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-05-sp1-media-access.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-05-sp2-content-completeness.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-05-sp3-search-enhancement.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-05-sp4-two-way-voice.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-06-scheduled-groups-tabs.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-07-anti-echo-session-controls.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-07-fleet-charts.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-25-operation-tracker.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-04-25-pr-0a-transport-contract-foundation.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-05-29-harness-maintenance.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-10-twilio-sms-transport.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-11-twilio-voice-webhook.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-13-d20-provider-keychain-unlock-policy.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-13-outstanding-burndown.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-13-provider-errpreview-sanitization.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-13-python-deploy-redaction-ssot.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-13-verification-reliability-residuals.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-06-16-handoff-distiller-wiring.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-console-truthful-session-update-and-send-ux.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-delivery-audit-and-idempotency.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-durable-inbound-and-reply-guarantee.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-health-recovery-and-self-update.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-metrics-realtime-and-watch-completeness.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-outbound-governor-and-flood-observability.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-09-privacy-erasure-and-media-confinement.md` | PRIVATE-ARCHIVE | Internal audit remediation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-11-central-hub-release-proof-pilot.md` | PRIVATE-ARCHIVE | Internal release-proof pilot implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-15-headless-fallback-runtime-alignment.md` | PRIVATE-ARCHIVE | Internal headless fallback runtime-alignment and fleet-readiness implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-15-semantic-boundary-foundation.md` | PRIVATE-ARCHIVE | Internal semantic-boundary foundation implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md` | PRIVATE-ARCHIVE | Internal fail-closed boundary-contract, evidence-receipt, feedback-bounding, and provider-deadline implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-16-boundary-core-history-provenance.md` | PRIVATE-ARCHIVE | Internal boundary-core fingerprint, history, disposition, provenance, and receipt implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-17-boundary-exit-parser-codeql-hardening.md` | PRIVATE-ARCHIVE | Internal security remediation implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-17-boundary-validator-ci-refactor.md` | PRIVATE-ARCHIVE | Internal behavior-preserving CI and fitness remediation implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-17-macos-credential-durability.md` | PRIVATE-ARCHIVE | Internal credential durability implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-20-cicd-control-foundation.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-20-cicd-enforcement-control-plane-program.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-20-cicd-workflow-portability.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-23-agent-reliability-remediation-implementation.md` | PRIVATE-ARCHIVE | Internal agent reliability and host-remediation implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-26-open-issue-triage-tooling.md` | PRIVATE-ARCHIVE | Internal issue-triage tooling implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-28-chat-queue-admission.md` | PRIVATE-ARCHIVE | Internal ChatRuntime admission implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-28-controller-state-recovery-integrity.md` | PRIVATE-ARCHIVE | Internal fail-closed controller-state recovery implementation plan; sanitized test identifiers only; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-28-incident-ingestion-surface.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-28-incident-store-core.md` | PRIVATE-ARCHIVE | Internal incident-store implementation plan (Plan 1 of the incident control plane series); sanitized fixture identifiers only; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-28-primary-probe-cancellation.md` | PRIVATE-ARCHIVE | Internal primary-probe cancellation implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-28-runtime-health-signal-dispositions.md` | PRIVATE-ARCHIVE | Internal runtime-health signal-contract implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-29-launchd-restart-policy-2682.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-29-maybe-sent-ambiguity-episode.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/plans/2026-07-29-portable-startup-notification-protocol.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/reviews/2026-04-07-anti-echo-review-handoff.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/reviews/2026-05-31-bot-errors-tool-call-audit.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/reviews/2026-07-09-wall-to-wall-audit-pr-briefs.md` | PRIVATE-ARCHIVE | Internal copy-ready PR briefs from the audit; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/reviews/2026-07-24-r13-r15-tech-debt-review-map.md` | PRIVATE-ARCHIVE | Internal R13-R15 tech-debt review map, live-inventory reconciliation, and closed-issue audit snapshot; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-04-colony-orchestration-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-05-phase2-mcp-features-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-06-scheduled-groups-tabs-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-07-anti-echo-session-controls-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-07-provider-attribution.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-25-baseline-test-failures.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-25-console-test-jsx-runtime-fix.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-25-instance-loader-fixture-fix.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-25-operation-tracker-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-25-pr-0a-aqs.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-04-25-transport-layer-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-09-wall-to-wall-audit-remediation-design.md` | PRIVATE-ARCHIVE | Internal audit remediation design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-11-central-hub-release-proof-pilot-design.md` | PRIVATE-ARCHIVE | Internal release-proof pilot design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-11-turn-lifecycle-fitness-extraction-design.md` | PRIVATE-ARCHIVE | Internal behavior-preserving fitness remediation design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-15-headless-fallback-runtime-alignment-design.md` | PRIVATE-ARCHIVE | Internal runtime-alignment and rollout design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md` | PRIVATE-ARCHIVE | Internal semantic quality and boundary-enforcement design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-17-boundary-exit-parser-codeql-hardening-design.md` | PRIVATE-ARCHIVE | Internal security remediation design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-17-boundary-validator-ci-refactor-design.md` | PRIVATE-ARCHIVE | Internal behavior-preserving CI and fitness remediation design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-17-macos-credential-durability-design.md` | PRIVATE-ARCHIVE | Internal credential durability design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-20-cicd-enforcement-control-plane-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-23-agent-reliability-remediation-design.md` | PRIVATE-ARCHIVE | Internal reliability and host-remediation design; sanitized of private fleet identifiers and excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-26-open-issue-triage-and-cohort-pr-design.md` | PRIVATE-ARCHIVE | Internal issue-triage, evidence, and cohort-publication design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-28-chat-queue-admission-design.md` | PRIVATE-ARCHIVE | Internal ChatRuntime admission and durability design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-28-controller-state-recovery-integrity-design.md` | PRIVATE-ARCHIVE | Internal controller-state integrity and fail-closed recovery design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-28-incident-control-plane-design.md` | PRIVATE-ARCHIVE | Internal incident control plane architecture design (locked sections 1-6 plus assembled migration section); retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-28-incident-ingestion-surface-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-28-primary-probe-cancellation-design.md` | PRIVATE-ARCHIVE | Internal primary-model probe cancellation design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-28-runtime-health-signal-dispositions-design.md` | PRIVATE-ARCHIVE | Internal runtime-health signal-disposition design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-29-launchd-restart-policy-2682-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-29-maybe-sent-ambiguity-episode-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/2026-07-29-portable-startup-notification-protocol-design.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/kill-session-transactional-cancellation/design.md` | PRIVATE-ARCHIVE | Internal targeted-cancellation protocol design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/kill-session-transactional-cancellation/requirements.md` | PRIVATE-ARCHIVE | Internal targeted-cancellation protocol requirements; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/kill-session-transactional-cancellation/tasks.md` | PRIVATE-ARCHIVE | Internal targeted-cancellation implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/design.md` | PRIVATE-ARCHIVE | Internal protocol design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/installation-evidence-ledger.json` | PRIVATE-ARCHIVE | Sanitized pointer and recapture contract only; exact target topology, posture, counts, and fingerprints remain in a private mode-0600 packet outside the repository. |
| `docs/superpowers/specs/provider-event-lifecycle/provider-contract-claude-code-2.1.207.json` | PRIVATE-ARCHIVE | Sanitized provider schema/correlation evidence; retained for internal conformance review and excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/requirements.md` | PRIVATE-ARCHIVE | Internal protocol requirements; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/tasks.md` | PRIVATE-ARCHIVE | Internal implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/triage/README.md` | PUBLIC | Sanitized operator contract for deterministic issue evidence, dry-run, confirmation, and recovery; complete issue bodies and private runtime identifiers are forbidden. |
| `docs/triage/open-issue-priority-clusters-20260728.json` | PUBLIC | Sealed numeric-only P0/P1 projection containing issue numbers, reviewed cluster identifiers, source bindings, and aggregate counts; titles, bodies, paths, ownership details, and pull-request content are excluded. |
| `docs/triage/open-issue-priority-clusters-20260728.md` | PUBLIC | Deterministic view of the sealed numeric-only P0/P1 projection; it exposes no fields beyond the reviewed JSON projection. |
| `docs/triage/open-issue-registry.json` | PUBLIC | Body-free canonical issue evidence containing only public issue metadata, repository-relative paths, hashes, and sanitized analysis. |
| `docs/triage/open-issue-registry.md` | PUBLIC | Generated body-free canonical issue evidence view containing only public issue metadata, repository-relative paths, hashes, and sanitized analysis. |
| `docs/triage/open-issue-review-ledger.jsonl` | PUBLIC | Body-free append-only mutation receipts containing only public issue metadata, repository-relative paths, hashes, and sanitized diagnostics. |
| `docs/triage/reviews/open-issue-refresh-20260728-current.json` | PUBLIC | Body-free reviewed issue evidence batch. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/1786.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/1882.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/1976.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/1977.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2135.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2144.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2145.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2147.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2148.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2150.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2155.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2164.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2169.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2170.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2189.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2190.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2191.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2192.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2193.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2194.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2197.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2200.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2204.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2206.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2207.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2209.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2210.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2211.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2213.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2214.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2218.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2222.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2224.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2225.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2235.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2241.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2242.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2244.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2248.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2250.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2252.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2253.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2257.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2258.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2259.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2260.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2280.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2281.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2282.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2284.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2288.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2289.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2290.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2295.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2298.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2300.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2301.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2304.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2321.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2322.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2323.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2325.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2330.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2331.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2333.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2340.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2342.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2343.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2353.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2354.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2355.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2356.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2357.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2363.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2384.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2385.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2386.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2387.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2388.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2390.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2392.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2393.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2394.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2395.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2397.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2398.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2399.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2400.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2402.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2403.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2405.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2406.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2407.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2408.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2409.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2410.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2412.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2413.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2414.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2416.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2419.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2420.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2421.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2424.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2427.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2428.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2429.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2430.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2435.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2437.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2439.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2444.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2445.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2447.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2453.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2457.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2460.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2462.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2463.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2464.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2480.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2481.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2482.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2483.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2485.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2486.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2503.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2506.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2507.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2508.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2509.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2510.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2511.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2512.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2513.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2514.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2517.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2518.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2519.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2520.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2521.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2522.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2523.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2525.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2526.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2527.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2528.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2529.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2530.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2531.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2532.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2533.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2534.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2535.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2536.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2537.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2538.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2539.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2540.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2541.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2544.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2545.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2546.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2547.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2548.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2549.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2550.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2551.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2552.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2553.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2554.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2555.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2556.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2557.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2558.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2559.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2560.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2561.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2562.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2564.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2565.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2566.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2567.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2568.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2569.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-current/2572.json` | PUBLIC | Body-free reviewed issue evidence. |
| `docs/triage/reviews/open-issue-refresh-20260728-main-59166b78.json` | PUBLIC | Body-free schema-v2 reviewed issue evidence bound to the exact source registry and target main revision. |
| `docs/triage/reviews/open-issue-refresh-20260728-main-59166b78/2517.json` | PUBLIC | Public exact review record binding issue 2517 to its current draft implementation owner without reproducing issue-body text. |
| `docs/triage/snapshots/open-issues-20260728T0730Z-reconciled.json` | PUBLIC | Body-free complete registry reconciliation seal bound to the committed review manifest and exact main revision. |
| `docs/triage/snapshots/open-issues-20260728T2225Z-main-59166b78.json` | PUBLIC | Body-free complete registry reconciliation seal bound to the committed review manifest and exact main revision. |
| `docs/work-index-repair-matrix.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/work-index.json` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/work-index.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `tmp/connection-exhausted-rca-2026-04-04.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
