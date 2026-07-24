# Release Snapshot Deployment

Status: active

This runbook defines the source-controlled release-snapshot workflow. It is a
contract for planning, reviewing, and verifying a release. It is not approval to
mutate a live host.

## Boundaries

- A source PR merge proves source durability only. It does not update any live
  release directory, plist, service, or WhatsApp runtime.
- A release re-cut is a separate live operation. It needs named approval in the
  current turn before touching a release directory or service manager.
- The dry-run planner does not copy files, edit launchd plists, restart
  services, delete old snapshots, send WhatsApp messages, or emit live alerts.
- Hot-patched release snapshots are evidence. They are not canonical source.

## Snapshot Manifest

Every new release snapshot must have a manifest named
`.whatsoup-release-manifest.json` at the release root. The manifest records:

- `schemaVersion`
- source ref and commit
- release path
- build timestamp
- mutable-path exclusions
- rollback snapshot path
- tracked file paths, byte sizes, and SHA-256 hashes

Mutable paths are excluded from code-drift comparison because they are expected
to differ between a source tree and a running release. Examples include
`node_modules/**`, logs, SQLite databases, auth directories, local artifacts,
and the release manifest itself.

## Restart-Safety Enforcement (preflight gate)

`deploy/preflight-check.sh` is the restart-safety gate the launch wrapper
(`deploy/whatsoup`) runs before every restart. For a non-git release export
(the deployed shape a release-root directory takes — see Boundaries above), it
now treats the manifest as a hard release-pipeline invariant, not an advisory
file:

1. **Missing** — `.whatsoup-release-manifest.json` does not exist at the
   release root. Refuses to start (exit `3`), reporting
   `release export lacks .whatsoup-release-manifest.json`.
2. **Unreadable** — the file exists but cannot be read (permission denied,
   I/O error). Refuses to start (exit `3`), reporting `release manifest is
   malformed` with an `unreadable` reason — distinct from `invalid-json`
   because the remediation differs (fix the permission/I-O problem, not
   re-export the release).
3. **Malformed** — the file exists and is readable but is not valid JSON
   (truncated, corrupted, binary). Refuses to start (exit `3`), reporting
   `release manifest is malformed` with an `invalid-json` reason.
4. **Schema-invalid** — the file is valid JSON but does not satisfy the
   manifest schema (missing `schemaVersion`/`source`/`release`/`rollback`).
   Refuses to start (exit `3`), reporting `release manifest is malformed` with
   an `invalid-schema` reason.
5. **Valid** — the manifest exists, parses, and satisfies the schema. Preflight
   proceeds (`PREFLIGHT-OK: release manifest present and schema-valid`); this
   does **not** run a full drift comparison against the release's files (see
   Drift Detection below) — it only proves the manifest itself is trustworthy
   input for one.

The validation reuses `parseReleaseSnapshotManifest` from
`scripts/release-snapshot-plan.ts` (`--validate-manifest <path>`) — the same
parser Drift Detection uses — so this gate and drift detection never disagree
about what counts as a valid manifest. This closes the gap behind the
2026-07-16 incident: `WhatSoup-release-ee35101f` shipped to multiple hosts
without a manifest and nothing on the restart path caught it before every host
flagged permanent release-drift. Backfilling or repairing a manifest on an
already-deployed release is a live host mutation and needs separate approval;
this gate only decides whether a restart of the tree AS FOUND is safe.

## Dry-Run Planning

Generate a deterministic plan before a re-cut:

```bash
npm --silent run release:snapshot -- \
  --release-root "$HOME/LAB" \
  --source-ref HEAD \
  --json
```

The plan enumerates:

- rollback preparation
- release directory creation
- each tracked file copy
- manifest write path
- the approval boundary for launchd/service mutation

The planner has no apply mode. If an operator turns the plan into live actions,
that live step must be approved separately and should preserve instance config,
auth, logs, DBs, token files, and keychain material outside the release tree.

## Drift Detection

Use the manifest to compare a release snapshot against the source commit used
to build it. A code edit inside a release snapshot is drift. Mutable state under
the manifest's exclusion list is not code drift.

Run the check in read-only mode:

```bash
npm --silent run release:snapshot -- \
  --check-release "$HOME/LAB/WhatSoup-release-<commit>" \
  --json
```

The command exits `0` when the release matches its manifest and exits nonzero
when files are missing, changed, or unexpectedly present. It reads the manifest
from `.whatsoup-release-manifest.json` inside the release by default; use
`--manifest /absolute/path/to/manifest.json` only when auditing an archived
manifest separately from its release directory.
Older release snapshots without a manifest are reported as `manifest-missing`
drift. That finding is evidence to re-cut from reviewed source; it is not
approval to overwrite the release.

Drift findings mean the release is no longer a faithful copy of reviewed source.
They do not by themselves authorize deleting the release or replacing it. Decide
whether to port the lesson back to source, re-cut from merged source, or roll
back to the prior release path.

## Scheduled Drift Alerting

Production hosts can wrap the same read-only drift check with
`scripts/live-release-drift-alert.ts`. The wrapper runs
`release-snapshot-plan.ts --check-release` against a release directory and queues
a BOT ERRORS event only when drift or checker failure is observed. Clean checks
do not emit by default; use `--clear-on-ok` only for a deliberate recovery proof.

Example one-shot command:

```bash
bash scripts/run-with-pinned-node.sh scripts/live-release-drift-alert.ts \
  --launchd-plist "$HOME/Library/LaunchAgents/com.whatsoup.<instance>.plist" \
  --instance release-bot \
  --source release-drift \
  --json
```

The checked-in macOS template is
`deploy/com.whatsoup.release-drift-check.plist`. Render it to a staging path
before any install/load step:

```bash
bash deploy/scripts/render-release-drift-launchd.sh \
  --instance <instance> \
  --repo-root "$PWD" \
  --home "$HOME" \
  --output /tmp/com.whatsoup.release-drift-check.plist
```

The renderer substitutes install-time placeholders only. It refuses direct
writes into `~/Library/LaunchAgents`; copying the staged plist there and loading
it is the live alerting change.

Installing a launchd/cron schedule for this command is a live alerting change and
needs separate named approval. The scheduled job must use the pinned Node runtime
and either an explicit reviewed release path or the active bot plist's
`WorkingDirectory` via `--launchd-plist`; the latter is preferred so the check
tracks future re-cuts. It must remain read-only: no apply, re-cut, plist
mutation, restart, cleanup, WhatsApp turn, or credential change.

## Pinned npm toolchain in `verify:release`

The `verify:release` npm script routes all `npm ci`, `run typecheck`, `test`,
`run lint`, and `run build` invocations for the `tools/whatsoup_guard` and
`console` sub-packages through `scripts/run-with-pinned-npm.sh`. This wrapper
sources `deploy/lib/resolve-node.sh`, resolves the Node binary pinned in
`.nvmrc`, and derives npm as the binary co-located with that Node. It does not
fall back to a system npm; if the pinned Node or its adjacent npm is missing it
exits 1 with a FATAL message.

The effect is that sub-package installs in `verify:release` are subject to the
same Node-pin and version-compatibility gate (`package.json#engines.node`) as
the rest of WhatSoup. A system Node outside the declared range cannot sneak in
via a nested `npm --prefix` call.

If you need to override the npm binary (e.g., for a host with a non-standard
directory layout), set `WHATSOUP_NPM=/absolute/path/to/npm` before running
`verify:release`.

## Live Acceptance

After a separately approved re-cut:

1. Capture the source commit, release path, and manifest path.
2. Repoint the service manager only after rollback is prepared.
3. Restart the target service.
4. Capture `/health`.
5. Send a scoped live turn only if approved.
6. Confirm no raw provider diagnostic text is sent to a user.
7. Confirm fallback/health behavior for a bogus model only if that mutation is
   separately approved.
8. Revert any temporary config change and confirm health recovery.

Until this acceptance is complete, do not claim the live instance is protected by
new source changes.

## In-place-git release-proof pilot (central host)

The snapshot planes above do not apply to the central pilot host, which runs
an in-place-git checkout. Its release-proof plane is the monitor-only pilot
specified in
`docs/superpowers/specs/2026-07-11-central-hub-release-proof-pilot-design.md`
(gates, non-regression criteria, abort rules, and promotion packet live
there; this section is the operator entry point).

Operator sequence (each gate separately owner-gated):

1. **Gate 1 — isolated dry proof:** stage with
   `install-bot-errors-release-proof.sh dry-run --host <host> --mode observe
   --bundle-sha <merged-sha>`; run both detectors against temporary
   `BOT_ERRORS_STATE_DIR`; prove no application path changed. Before any
   standalone timer install, capture the effective daily-health profile and
   require
   `python3 -c 'import json,sys; assert json.load(open(sys.argv[1])).get("expectTreeProvenance", False) is False' <effective-profile-path>`
   to exit 0. Missing or unreadable effective-profile evidence is
   Inconclusive and stops the pilot.
2. **Gate 2 — controlled alert drill:** one warning + same-key clear through
   the production dispatcher (`--source release_proof_drill`, unique
   conservative instance, `BOT_ERRORS_INLINE_LOG_TAIL=0`). Requires
   execution-time owner confirmation — it is an external communication.
3. **Gate 3 — observe install + 24 h soak:**
   `install --mode observe`; verify with `verify` and the explicit
   four-unit `check-unit-drift.sh` invocation; capture the spec §9
   non-regression evidence before and after.
4. **Gate 4 — emit + 48 h soak:** `set-mode --mode emit` after a separate
   owner gate; one manual cycle per detector before automated coverage.
5. **Gate 5 — application provenance proof:** separate approval; deploy an
   approved main SHA, restart the app, stamp `expected_head_sha`, prove
   `/health.instance.commit`/`branch` and a runtime-staleness clear.

Rollback at any point: `install-bot-errors-release-proof.sh rollback
--host <host> --receipt <receipt-dir>` (printed by `install`). Rollback
accepts only owner-private receipts under
`~/.local/state/whatsoup/release-proof-installer/receipts/`, touches only
monitor artifacts, and never invokes an application service command.
