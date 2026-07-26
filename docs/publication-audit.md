# Publication Audit

`docs/publication-audit.md` is the tracked source of truth for documentation that must be reviewed before public publication. The publication guard validates that every tracked internal documentation path has exactly one row here.

Internal publication roots covered by the guard: `docs/runbooks/`, `docs/sdlc/`, `docs/superpowers/`, `docs/plans/`, `docs/cutover/`, `docs/research/`, `docs/triage/`, `docs/specs/` (selected), `docs/work-index*`, `docs/current-program.md`, `docs/handoff-*.md`, `HANDOFF-*.md`, `docs/project-status-*.md`, `docs/audit-*.md`, `tmp/`.

**Total classification rows:** 128

| Classification | Count |
|---|---:|
| PUBLIC | 3 |
| PRIVATE-ARCHIVE | 125 |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | 128 |

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
| `docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md` | PRIVATE-ARCHIVE | Internal boundary-core GitHub and Git-history evidence, implementation notes, limitations, and rollout boundary; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md` | PRIVATE-ARCHIVE | Internal boundary-contract falsifiers, implementation ledger, output measurements, limitations, and authorization boundary; retained in the repository but excluded from public publication by default. |
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
| `docs/superpowers/plans/2026-07-26-open-issue-triage-tooling.md` | PRIVATE-ARCHIVE | Internal issue-triage tooling implementation plan; retained in the repository but excluded from public publication by default. |
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
| `docs/superpowers/specs/2026-07-26-open-issue-triage-and-cohort-pr-design.md` | PRIVATE-ARCHIVE | Internal issue-triage, evidence, and cohort-publication design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/kill-session-transactional-cancellation/design.md` | PRIVATE-ARCHIVE | Internal targeted-cancellation protocol design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/kill-session-transactional-cancellation/requirements.md` | PRIVATE-ARCHIVE | Internal targeted-cancellation protocol requirements; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/kill-session-transactional-cancellation/tasks.md` | PRIVATE-ARCHIVE | Internal targeted-cancellation implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/design.md` | PRIVATE-ARCHIVE | Internal protocol design; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/installation-evidence-ledger.json` | PRIVATE-ARCHIVE | Sanitized pointer and recapture contract only; exact target topology, posture, counts, and fingerprints remain in a private mode-0600 packet outside the repository. |
| `docs/superpowers/specs/provider-event-lifecycle/provider-contract-claude-code-2.1.207.json` | PRIVATE-ARCHIVE | Sanitized provider schema/correlation evidence; retained for internal conformance review and excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/requirements.md` | PRIVATE-ARCHIVE | Internal protocol requirements; retained in the repository but excluded from public publication by default. |
| `docs/superpowers/specs/provider-event-lifecycle/tasks.md` | PRIVATE-ARCHIVE | Internal implementation plan; retained in the repository but excluded from public publication by default. |
| `docs/triage/README.md` | PUBLIC | Sanitized operator contract for deterministic issue evidence, dry-run, confirmation, and recovery; complete issue bodies and private runtime identifiers are forbidden. |
| `docs/triage/open-issue-review-ledger.jsonl` | PUBLIC | Body-free append-only mutation receipts containing only public issue metadata, repository-relative paths, hashes, and sanitized diagnostics. |
| `docs/work-index-repair-matrix.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/work-index.json` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `docs/work-index.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
| `tmp/connection-exhausted-rca-2026-04-04.md` | PRIVATE-ARCHIVE | Internal planning or operational documentation; retained in the repository but excluded from public publication by default. |
