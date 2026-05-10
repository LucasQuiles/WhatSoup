# WhatSoup Guard

Universal WhatSoup Protection Layer package for detecting drift, recording guard
events, and exercising deployment-neutral protection workflows.

See `../../docs/specs/2026-05-08-whatsoup-protection-layer-design.md` for the
public design and
`../../docs/plans/2026-05-09-whatsoup-protection-layer-integration-follow-up-plan.md`
for the current integration follow-up.

## Scope

WhatSoup Guard is a product capability, not a deployment-specific pack. It keeps
the core engine deployment-neutral:

- policy/profile loading
- fixture collection
- baseline comparison
- drift evaluation
- mute, deduplication, and storm-guard decisions
- ledger writes
- alert formatting and transport result accounting
- self-protection checks
- simulator scenarios for product-path proof

Concrete platform collectors, operator inventory, network identifiers,
transport identifiers, machine-specific labels, account identifiers, and
operator procedure notes are out of scope for this package. Those values belong
in operator configuration or future collector-pack plans.

## Commands

Run package-local validation from the repo root:

```bash
npm --prefix tools/whatsoup_guard run typecheck
npm --prefix tools/whatsoup_guard test
```

Run the source CLI through the package-local TypeScript runner:

```bash
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts ping
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts cycle --policy <policy.yaml> --state-dir <state-dir>
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts status --state-dir <state-dir>
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts mute --state-dir <state-dir> --host <scope-id> --domain exposure --duration 1h --reason "maintenance"
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts simulate --state-dir <state-dir> --fixture <fixture.json> --scenario drift --now 2026-05-08T10:00:00.000Z
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts watchdog --state-dir <state-dir> --policy <policy.yaml>
```

The source `cycle --policy <policy.yaml> --state-dir <state-dir>` command loads
the policy, opens the local SQLite/JSONL state, builds the configured transport
chain, runs fixture-backed collectors for the policy inventory, and appends a
heartbeat summary. Human command output is written to stdout; structured guard
logs are disabled by default and are emitted as Pino JSON to stderr only when
`WHATSOUP_GUARD_LOG_LEVEL` is set.

## Alert Body

Alert text is intentionally copy-pasteable and deployment-neutral. A typical
formatted alert looks like:

```text
[whatsoup-guard] HIGH scope-a - fixture.ports
when:    2026-05-08T10:00:00.000Z
probe:   fixture.ports
domain:  exposure
diff:    {"added":{"ports":[443]},"removed":{},"changed":{}}
action:  alert
fingerprint: 7a2f000000000000000000000000000000000000000000000000000000000000
mute: whatsoup-guard mute --state-dir '<state-dir>' --host 'scope-a' --domain 'exposure' --duration 1h --reason '<why>'
event-id: 42
```

Fields:

- `severity` in the header drives dedup windows and critical retry behavior.
- `scope` and `probe` identify the protected object and the check that found
  drift.
- `domain` is one of exposure, credential, capability, change, or alerting.
- `diff` is structural JSON evidence. It must not contain secret values.
- `action` is the policy action that was taken or proposed.
- `fingerprint` is the stable dedup key for repeated equivalent drift.
- `mute` is a template. Replace `<state-dir>` and `<why>` before running it.
- `event-id` is the ledger row that sourced the alert.

## Simulator Fixture

Simulator fixtures are generic JSON objects. Keys use
`<probe-id>/<scope-id>` and values are the baseline or observed fields.

```json
{
  "baselines": {
    "fixture.ports/scope-a": { "ports": [80] }
  },
  "observations": {
    "fixture.ports/scope-a": { "ports": [80, 443] }
  }
}
```

The simulator writes SQLite and JSONL state under the provided state directory.
Use temporary directories for local experiments unless you intentionally want to
keep the evidence.

Named scenarios are available through `--scenario`:

| Scenario | Purpose |
|---|---|
| `clean` | Baseline and observation match; only heartbeat is written. |
| `drift` | Basic drift event. |
| `muted-drift` | Active mute suppresses matching drift. |
| `dedup` | Repeated high-severity drift is deduplicated. |
| `dedup-escalation` | Repeated high drift is deduplicated, then critical severity breaks dedup. |
| `crit-storm` | Repeated critical drift is storm-guarded. |
| `alert-fallthrough` | Primary delivery fails and fallback succeeds. |
| `watchdog-heartbeat` | Clean cycle with heartbeat evidence. |
| `transport-broken` | All alert delivery channels fail. |
| `self-secret-widened` | Guard-owned secret metadata violates expected file mode. |

When `--scenario` is omitted, the simulator runs the `drift` scenario. Scenario
runs use the same SQLite tables and JSONL event mirror as the runtime path, but
they use fixture collectors and in-memory transport sinks where needed so local
experiments do not require live external services.

Example:

```bash
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts simulate \
  --state-dir <state-dir> \
  --fixture <fixture.json> \
  --scenario dedup-escalation \
  --now 2026-05-08T10:00:00.000Z
```

## Watchdog

`watchdog` reads the event ledger and emits meta-alerts when heartbeat silence
or transport failure crosses the configured threshold.

```bash
tools/whatsoup_guard/node_modules/.bin/tsx tools/whatsoup_guard/src/cli/index.ts watchdog \
  --state-dir <state-dir> \
  --policy <policy.yaml> \
  --threshold-hours 7
```

The watchdog uses the policy `transport.meta_alert` block to build ntfy,
Pushover, or webhook sinks. If no meta-alert sink is enabled, watchdog findings
are recorded as `alert_delivery_failed_all` events with
`failure: "no_meta_alert_sinks"` and the command reports a delivery failure
instead of implying successful delivery.

## State And Evidence

The state directory contains:

- `state.sqlite`: durable event, mute, baseline, and runtime-state tables.
- `events.jsonl`: JSONL event mirror for local inspection and recovery.
- local notification fallback files when a desktop notifier is unavailable.

Plan evidence lives under ignored `artifacts/` directories during development.
Those files are useful for local review but are not release evidence by
themselves. Tracked plans and CI output remain the durable release record.

## Release Caveats

Package-local green is not release green.

As of the Workstream D package-local pass:

- guard package typecheck is green locally
- guard package tests are green locally
- root validation and remote CI remain separate release gates; package-local
  success does not prove the whole repository is merge-ready
- the feature branch has no remote CI evidence until it is pushed and the
  path-filtered workflow runs
- task evidence under `artifacts/` is local and ignored, so tracked readiness
  summaries must be kept current

Do not call the package merge-ready until root validation is accepted or green,
remote CI evidence exists or is explicitly substituted, and the readiness plans
match the current branch state.
