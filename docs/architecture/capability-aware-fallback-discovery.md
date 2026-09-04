# Capability-Aware Fallback Discovery

**Date:** 2026-09-04
**Status:** Approved operational objective; evidence-derived implementation

This decision record is the durable objective-to-control map for the change. Runtime
configuration remains canonical in `docs/configuration.md`; this file records why the
existing controls were modified and which suggested mechanisms were rejected.

## Governing intent

Fallback selection must preserve useful agent continuity when the primary route is
unavailable. A long model list, a recently captured list, or a successful process spawn is
not the outcome. The outcome is a small, provider-diverse ladder whose entries are current,
agent-capable, and backed by the strongest available completion evidence.

The control chain is:

`catalogue observation -> capability eligibility -> completion evidence -> deterministic ranking -> bounded fallback ladder -> runtime result`

## Evidence and root cause

The existing discovery path is already dynamic at the inventory boundary: it asks the
configured OpenCode gateway for the models available in the current project and derives one
candidate per provider. The live inventory examined for this change contained 73 model IDs
across six provider prefixes.

The ranking then discards all catalogue metadata and assumes the last remaining ID for a
provider is its newest useful model. That assumption is false by implementation, not merely
by observation: OpenCode's `models` command sorts the models inside each provider
lexicographically by model ID before printing them. One provider's selected entry had a 2025
release date while multiple active, tool-capable 2026 entries appeared earlier in the same
live output. A later shadow capture also showed that naive date-only ranking would select a
beta vision experiment over a slightly older active model, and that the gateway provider now
lists both zero-cost and paid entries. A prior correction added model-name substring
exclusions after list order selected embedding and media models, but it did not repair
lifecycle, chronology, or free-tier classification.

OpenCode documents that `models --refresh` refreshes its models.dev cache, while ordinary
`models` reads configured-provider availability from the current project. The installed
runtime also exposes parseable metadata with `models --verbose`: status, release date,
modalities, context limits, and tool-call capability. A pure refresh completed quickly in
the service environment; a non-pure refresh wedged behind unrelated plugin startup. The
current WhatSoup lister invokes neither `--refresh`, `--pure`, nor `--verbose`.

The root cause is therefore proven for catalogue ranking and freshness provenance:

1. the lister throws away the metadata needed to determine agent suitability and recency;
2. the ranker substitutes output position for release chronology;
3. an in-memory capture timestamp is presented without distinguishing a successful upstream
   refresh from a read of the persistent cache; and
4. the requested route label is not an independently observed runtime identity.

## Objective, requirements, and constraints

### Objective

At every discovery refresh, derive the fallback ladder from the freshest available
configured-provider catalogue, admit only candidates suitable for an agent turn when the
gateway supplies capability metadata, and rank candidates deterministically from recent
completion evidence plus catalogue recency.

### Requirements

1. A successful upstream refresh is distinguishable from a cached fallback read.
2. Catalogue collection runs without external plugins.
3. Verbose output is shape-checked and bounded before metadata is trusted.
4. Explicitly inactive, non-text-output, or non-tool-capable models are ineligible for the
   automatic agent ladder; with equal completion evidence, stable lifecycle outranks preview
   lifecycle before release chronology is considered.
5. Missing metadata remains compatible with older/custom gateways and uses the legacy
   conservative filter; it is never described as capability-proven.
6. A configured operator preference wins when its exact ID is present.
7. Recent successful completion evidence outranks unknown evidence; failed evidence excludes
   only the exact model, allowing another model from the same provider to become a candidate.
8. With equal evidence and lifecycle, a valid later month- or day-precision release date wins;
   equal dates preserve the established catalogue tie break so legacy gateways remain
   deterministic.
9. A gateway entry can fill the reserved free-tier tail only when verbose metadata confirms
   that input, output, and every nested numeric price are zero; metadata-free legacy output
   retains the prior prefix assumption.
10. Provider diversity, the existing chain cap, the reserved keyless tail, and mid-window
   active-entry preservation remain unchanged.
11. Health/log evidence reports the capture mode and selection basis without provider error
    prose or credentials.

### Constraints

- Do not add a second catalogue service or a hand-maintained model table.
- Do not probe every model on every user turn; current real-completion canaries remain the
  availability oracle.
- Do not expand the fallback chain merely because the inventory is large.
- Do not claim the gateway's requested model label is independently observed identity.
- Preserve older gateway compatibility and injected test seams.
- Catalogue failure must retain the last usable derived chain.

## Objective-to-control map

| Field | Decision |
|---|---|
| Governing objective | Preserve useful agent continuity with a current, usable, provider-diverse ladder. |
| Observed failure | ID-only, tail-position ranking selected an older model despite newer active tool-capable entries; naive date ranking selected a beta experiment; the gateway prefix mixed paid and zero-cost entries. |
| Evidence | OpenCode configured-provider output, verbose metadata, refresh behavior, runtime discovery logs, and the existing discovery tests/history. |
| Operational impact | A provider can be represented by a stale or unsuitable rung, causing avoidable turn failure and misleading runtime claims. |
| Root cause | Proven: metadata is discarded and output order is treated as chronology; refresh provenance is not carried. |
| Required invariant | Automatic candidates are agent-capable when capability metadata exists; ranking is evidence-first, lifecycle-aware, then release-date-aware; the reserved free tail is zero-cost when cost metadata exists. |
| Existing control | Dynamic ID discovery, provider diversity, name-token non-chat filter, and real-completion canaries. |
| Remaining gap | No metadata parser, no refresh/cached distinction, false list-order chronology, no lifecycle or cost classification, and no same-provider next candidate after exact-model failure. |
| Proposed mechanism | Extend the existing lister result with bounded metadata and capture mode; extend the existing pure ranker to consume it. |
| Enforcement point | Catalogue capture and `deriveFallbackChainFromCatalog`; no new runtime service. |
| Platforms | Shared WhatSoup policy with an OpenCode CLI adapter; other harness catalogues remain unchanged. |
| Trigger | Boot discovery, stale window-arm refresh, and post-canary re-derivation. |
| Response | Prefer fresh data; fall back to explicitly cached/legacy data; exclude proven-ineligible or exact-model-dead candidates; retain the prior chain on total failure. |
| Valid exception | An exact operator preference may select an otherwise automatically ineligible model; explicit intent is logged as the basis. |
| Positive control | Newer active text/tool metadata wins within a provider and a fresh successful canary wins across providers. |
| Negative control | Inactive, non-tool, non-text-output, paid-tail, unknown-cost-tail, malformed-metadata, beta-over-stable, and exact-model-dead cases do not become the automatic candidate. |
| Bypass analysis | Unknown metadata cannot be called capability-proven; cached fallback is labeled; a dead model cannot condemn every model under its provider. |
| Proof | Parser fixtures, ranking falsifiers, refresh-to-cache degradation tests, existing discovery wiring/canary tests, typecheck, and live shadow comparison. |
| SSOT | Existing catalogue lister and fallback discovery modules. |
| Status | Modify existing controls; do not add another selector. |

## Alternatives

### Increase the chain length

Rejected. It increases turn latency and provider load without correcting stale selection.
Inventory size and execution-ladder size serve different objectives.

### Keep ID-only discovery and add more name heuristics

Rejected. It repeats the prior symptom patch and cannot express release date, lifecycle
status, output modality, or tool support.

### Always choose the newest catalogue entry

Rejected. Recency is weaker evidence than a fresh successful completion. It is only the
tie-breaker among candidates with the same completion status.

### Canary every model on every turn

Rejected. It adds cost and latency and can itself create quota pressure. The existing bounded
periodic canary remains the availability signal.

### Build a separate fleet-wide model router

Rejected for this lane. It duplicates the existing discovery boundary and expands the task
beyond preserving fallback continuity in WhatSoup.

## Source implications

- OpenCode CLI documentation defines `models` as the configured-provider list and
  `--refresh` as the models.dev cache refresh:
  <https://opencode.ai/docs/cli/#models>.
- OpenCode's command implementation sorts model IDs lexicographically inside each provider
  and prints the refresh banner before model records:
  <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/models.ts>.
- models.dev defines `release_date` with `YYYY-MM` or `YYYY-MM-DD` precision and exposes
  lifecycle, modalities, tool-call support, and nested cost fields:
  <https://github.com/anomalyco/models.dev/blob/dev/README.md#schema-reference>.
- OpenCode loads project-specific configuration by walking from the current directory to the
  nearest Git root, and merges it with credential and other configuration layers:
  <https://opencode.ai/docs/config/#per-project>. Therefore capture must run in the same
  service environment and project context as the agent.

These findings imply a thin adapter over the installed CLI, not a global static list.

## Proof sequence

1. Feed a provider list where an older model is last but a newer tool-capable model appears
   earlier; the old implementation selects the older entry.
2. Feed the same list with validated metadata; the new implementation selects the newer
   entry.
3. Mark that exact model dead; the next eligible model from the same provider is selected.
4. Mark an older eligible model `ok` and the newer one unknown; the proven model wins.
5. Give a beta experiment a later date than an active model; the active model wins while
   completion evidence is equal.
6. Put a newer paid model after a zero-cost gateway model; only the zero-cost model may fill
   the reserved free tail.
7. Make refreshed verbose capture fail and cached verbose capture pass; the catalogue remains
   usable and is labeled cached.
8. Include the ANSI refresh banner emitted by the installed CLI; the successful refreshed
   capture remains labeled refreshed rather than being misreported as cached.
9. Make metadata malformed; no malformed metadata is trusted and legacy ID compatibility is
   explicit.
10. Make a nested cache price non-zero or omit valid cost from a verbose record; the entry
    cannot claim or occupy the zero-cost tail.
11. Run the existing discovery, canary, health, type, lint, and repository gates.

## Live shadow result

The implemented capture/ranker was run without changing service configuration or routes. One
development environment refreshed 114 configured model IDs across eight provider prefixes and
selected active, tool-capable representatives plus a zero-cost gateway tail. The first date-only
draft selected a newer beta vision experiment; the lifecycle falsifier corrected that before
deployment, after which the active stable model won. A separate fleet service environment exposed
73 IDs across six prefixes. This difference is expected and material: configured-provider
catalogues are runtime-, credential-, and location-scoped, not one fleet-global list.

The implemented live adapter returned `captureMode=refreshed` with no refresh failure. This
proves the capture path and its provenance label; it does not prove that every listed model
can complete an agent turn. Completion evidence remains a separate ranking input.

## Recovery boundary

The candidate basis contains one representative per provider. If every eligible model under
a provider is dead, the representative remains in the bounded canary sweep and can prove the
provider recovered. If one dead model is replaced by a viable sibling, the replaced model is
not also probed; it becomes eligible after its failure-evidence TTL expires. Probing every
sibling would turn catalogue size into runtime load and violate the bounded-ladder objective.

## Separate but related gap

Provider/model identity in a turn result is currently a requested route label, not an
independent provider receipt. This design forbids treating that label as observed identity.
Adding a receipt requires a separate parser/result contract and should not be smuggled into
catalogue ranking. It remains required before cross-harness identity parity can be claimed.

## Codex runtime-catalogue addendum

The 2026-07-20 repository decision to report `codex-cli` as `no-adapter` was correct
when made: that installed release had no non-interactive listing command. It is no longer
current. On 2026-09-04, the installed binaries on two fleet hosts independently exposed
`codex debug models` as a JSON catalogue. The hosts returned different visible sets, and
each default-command result differed from its own `--bundled` result. A shared static list
would therefore erase both runtime version and account/cache differences.

This is adjacent to, but not part of, automatic fallback discovery. Discovery still asks
the configured OpenCode gateway because its job is to derive cross-provider fallback
candidates. The Codex adapter supplies the existing `/model` catalogue and pin-verification
surface when the selected harness is `codex-cli`; it does not introduce another selector.

| Field | Codex decision |
|---|---|
| Governing objective | Make the model-selection surface reflect the exact installed Codex runtime without inventing a fleet-global list or overstating freshness. |
| Observed failure | WhatSoup always reported `no-adapter` even though both inspected Codex releases now expose a native JSON catalogue; the two hosts returned different visible models. |
| Evidence | Live probes of Codex 0.153.1 and 0.139.0, default-versus-`--bundled` comparisons, repository history for the July add/remove attempt, and upstream command/model-manager source. |
| Operational impact | Operators cannot inspect or deterministically verify Codex model pins and are pushed toward dated, hand-maintained assumptions. |
| Root cause | The July capability observation became stale after Codex added `debug models`; no capability probe or adapter replaced the deliberate early return. |
| Required invariant | Resolve the exact configured binary, accept only shape-valid picker-visible slugs, preserve command order, and make cache/source uncertainty explicit. |
| Existing control | One per-harness resolver, one bounded child-process collector, reason-specific degradation, stable-number rendering, and capture-stamped resolver caching. |
| Remaining gap | No Codex parser or resolver adapter; the native JSON omits cache age/source and upstream suppresses refresh errors. |
| Proposed mechanism | A thin strict parser over `codex debug models --disable multi_agent`, plugged into the existing shared CLI cache/reason policy. |
| Enforcement point | Existing binary preflight module and `resolveModelCatalogue`; the test-only CLI lister seam is reused by pin and drill paths. |
| Platforms | Shared WhatSoup behavior with a Codex-specific adapter; Claude, OpenCode, and Gemini behavior is unchanged. |
| Trigger | `/model` catalogue rendering and pin-time catalogue verification for a `codex-cli` route. |
| Response | Return `visibility=list` slugs; fail closed on malformed/duplicate/oversized output; disclose command failure, timeout, empty, or parser failure through existing reasons. |
| Valid exception | A previously captured non-empty list may be served after a transient re-probe failure, with its actual WhatSoup capture age disclosed. |
| Positive control | Mixed `list`/`hide`/`none` JSON returns only visible slugs in source order and uses the resolved binary path. |
| Negative control | Malformed root, missing array, unknown visibility, unsafe/duplicate slug, hidden-only list, oversized output, non-zero exit, and timeout cannot become a trusted list. |
| Bypass analysis | The native command can silently use its own cache or bundled fallback, so the UI labels upstream freshness unreported rather than calling the capture live or fresh. |
| Proof | Parser falsifiers, command/timeout/output-bound tests, resolver cache/degradation tests, typecheck, live two-host comparison, and the repository gates. |
| SSOT | `providers/binary-preflight.ts` parses the native output; `model-catalogue-resolver.ts` owns cache and render-reason policy. |
| Status | Modify the existing controls; reject a static table, a second catalogue service, and provider-wide fallback rewrites. |

Upstream source confirms the limitation behind the label. The debug command uses
`RefreshStrategy::OnlineIfUncached`, while the model manager first accepts a fresh cache,
falls back to the network only on cache miss, and logs rather than propagates refresh
failure. Its serialized response contains only `models`, so WhatSoup cannot prove source or
upstream age from the command result:

- <https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/cli/src/main.rs#L2292-L2319>
- <https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/models-manager/src/manager.rs#L340-L408>
- <https://github.com/openai/codex/blob/rust-v0.139.0/codex-rs/protocol/src/openai_models.rs#L237-L246>
