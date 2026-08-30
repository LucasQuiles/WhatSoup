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

The planner itself has no apply mode. The apply step is
`scripts/release-export.ts` (`npm run release:export`), which materializes the
plan from an EXACT commit — never the working tree — and self-verifies before
publishing:

```bash
npm --silent run release:export -- \
  --commit <full-40-hex-sha> \
  --release-root "$HOME/.local/opt/whatsoup/releases" \
  --json
```

Export properties (all fail closed):

- source bytes come from `git archive <commit>`, so working-tree drift can
  never leak into a release;
- the release is assembled in a staging directory and self-checked with the
  SAME drift checker the fleet runs (`--check-release` semantics) BEFORE it is
  atomically renamed into place — a failed export leaves no release;
- secret- and state-shaped paths (`tokens.env`, `*.db`, `auth/**`, ...) are
  excluded even when git-tracked;
- an existing release is never clobbered: without `--replace` the export
  refuses; with `--replace` the prior release is preserved at the manifest's
  rollback path first. The rollback slot itself is also never overwritten: a
  second `--replace` of the same release name refuses while
  `.rollback/<name>-before` is occupied — verify the preserved copy is no
  longer needed, then remove it manually before re-running;
- dependencies are NOT installed by the export: run `npm ci` inside the release
  on the host (the restart preflight blocks a release without `node_modules`).

The export creates release bytes only. Repointing a service at the new release
and restarting it remain separately-approved host mutations, and must preserve
instance config, auth, logs, DBs, token files, and keychain material outside
the release tree.

## Activating a release

Activation is the separately-approved host mutation the section above stops
short of. Having exported a release is not approval to activate it: activation
needs named approval in the current turn, naming the instance, the target
release, and the prepared rollback target.

**The wrapper symlink is the release selector.** The release that runs is the
target of the wrapper symlink `~/.local/bin/whatsoup` →
`<release>/deploy/whatsoup`. The wrapper resolves its own path through symlinks
and derives the repository root from the resolved location:

```bash
SCRIPT_DIR="$(cd "$(dirname "$(_resolve_symlinks "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
```

Every path the service executes is derived from `REPO_ROOT` — including the
entrypoint `$REPO_ROOT/src/bootstrap.ts`. The launchd plist `WorkingDirectory`
sets the process's current directory and nothing else. It does not select the
release.

### The WorkingDirectory false pass

Editing only the plist `WorkingDirectory` to the new release and restarting
produces a convincing green while the OLD code keeps running: `GET /health`
returns 200, the process cwd is the new release directory, and no fallback is
active. This happened on mini11 and was accepted as a successful activation
before the provenance fields were read.

The tell is provenance, not configuration: `instance.commit` in the health
payload and the process's `WHATSOUP_GIT_SHA` still report the OLD commit.

**Verify activation from the executing process, never from configuration.**

1. `ps -p <pid> -o command=` must show `<new release>/src/bootstrap.ts`.
2. `WHATSOUP_GIT_SHA` and health `instance.commit` must equal the new commit.

A cwd that agrees with the intended release is not proof of anything; it is the
exact observation the false pass produces.

Note that an exported release is not a git work tree, so git-derived provenance
inside it is unavailable. The wrapper detects this and falls back to the release
manifest's `source.commit` for `WHATSOUP_GIT_SHA`/`WHATSOUP_GIT_BRANCH`, and
unsets both (with a `WARN`) when neither source yields a 40-hex commit. A
release whose provenance is unset cannot be verified by step 2 above.

### Activation is a coordinated switch

Auxiliary launchd jobs pin a release through the ABSOLUTE SCRIPT PATH in their
`ProgramArguments` — not through `WorkingDirectory`. The templates in `deploy/`
substitute `__WHATSOUP_REPO_ROOT__` into `ProgramArguments`, and each script
then derives its own repo root from its own resolved path
(`harness-maintenance.sh`, `reply-guarantee-drain.sh`,
`run-release-drift-schedule.sh` all resolve `${BASH_SOURCE[0]}`), never from
cwd. `WorkingDirectory` in those plists selects nothing. Observed on mini11:
`com.whatsoup.harness-maintenance`, `com.whatsoup.release-drift-check`, and
`com.whatsoup.reply-guarantee`.

So the wrapper symlink governs the bot, and an absolute `ProgramArguments` path
governs each auxiliary job. Repointing the symlink alone leaves those jobs
executing the previous release, and the estate ends up mixed-generation — the
bot on one release, its maintenance and drift observers on another.

A correct activation repoints the wrapper symlink AND moves each auxiliary job's
`ProgramArguments` onto the new release as one switch. The supported way to do
the second half is to RE-RENDER the plists FROM INSIDE the new release, because
`__WHATSOUP_REPO_ROOT__` is substituted globally into both `ProgramArguments`
and `WorkingDirectory`, so the two stay consistent by construction. The two
renderers take their root differently, and only one honours an environment
variable:

- `com.whatsoup.release-drift-check` — `deploy/scripts/render-release-drift-launchd.sh`,
  which honours `WHATSOUP_REPO_ROOT`;
- `com.whatsoup.harness-maintenance` and `com.whatsoup.reply-guarantee` —
  `deploy/setup.sh`, whose `install_launchd_timer` derives the root from its own
  `${BASH_SOURCE[0]}` and IGNORES `WHATSOUP_REPO_ROOT`. Run it from inside the
  new release; exporting the variable does nothing for these two.

Re-rendering writes the plist on disk but does NOT switch a job that is already
loaded: launchd keeps the loaded definition until the label is reloaded, so
apply the reload sequence below to each auxiliary label as well as to the
instance. Skipping that leaves the aux jobs on the previous release even though
the plists on disk look correct.

Hand-editing `WorkingDirectory` is the trap: it changes cwd, leaves
`ProgramArguments` on the old release, and reproduces the same "configuration
looks right, old code runs" false pass described above.

### Reload sequence

`bootout`, then a bounded poll until the old process actually exits, then
`bootstrap`. Bootstrapping while the previous process is still in `SIGTERMed`
shutdown fails with `Bootstrap failed: 5: Input/output error` and leaves the
service DOWN. On mini11 recovery was a second `bootstrap` after the process had
exited; do not treat that retry as part of the plan.

```bash
old_pid=<pid captured before bootout>
launchctl bootout gui/"$(id -u)"/com.whatsoup.<instance>
for _ in $(seq 1 60); do
  kill -0 "$old_pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$old_pid" 2>/dev/null; then
  echo "FATAL: pid $old_pid still running after bootout; refusing to bootstrap" >&2
  exit 1
fi
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/com.whatsoup.<instance>.plist
```

Run this same sequence for every auxiliary label whose plist you re-rendered,
not just `com.whatsoup.<instance>` — a re-rendered plist does not take effect
until its label is reloaded.

`docs/runbooks/macos-launchd-deployment.md` owns the surrounding launchd
hazards this sequence inherits: the bounded retry for the transient bootstrap
error class, the rule that `kickstart -k` reuses the already-loaded definition
so a disk edit needs `bootout` + `bootstrap`, and the SSH/keychain-session
hazard that requires finishing a plist change with `kickstart -k`.

### Rollback

Record the previous wrapper symlink target before repointing it, and back up
every plist you edit as `<plist>.bak-<tag>-<ts>`. Rollback is then a single
coordinated restore — symlink target and the auxiliary plists (their
`ProgramArguments` paths, and `WorkingDirectory` if you changed it) together —
followed by the same reload sequence.

The prior generation survives the export, but not always at the path you
recorded: a `--replace` export of the SAME release name preserves the previous
release at the manifest's rollback path (`.rollback/<name>-before`) rather than
leaving it in place (see Dry-Run Planning above). Re-verify that the recorded
symlink target still resolves before relying on it, and fall back to the
manifest's rollback path when it does not.

Verify a rollback the same way as an activation: from the executing process,
not from the restored configuration.

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

Every invocation of `live-release-drift-alert.ts` prints exactly one structured
JSON log record to stdout (in addition to `--json` printing the full result).
The record is content-free: `schemaVersion`, `observedAt` (UTC),
`invocationId`, a bounded `outcome` (`passed` / `drift` / `checker_failed` /
`emit_failed`), `issueKinds` counts, a stable `conditionFingerprint`
(domain-separated hash of the issue-kind set plus the manifest identity
digest), `desiredReleaseDigest` / `observedReleaseDigest`, the `alert`
emit status, and a `correlationDigest` — a domain-separated hash of the
BOT ERRORS event id that can be joined against the emitted event without
printing the id itself. Absolute paths, release names, instance labels, and
issue messages never appear in the record. A persistent condition therefore
produces one identical, deduplicable record shape per invocation instead of
unbounded prose.

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

The rendered job invokes `deploy/scripts/run-release-drift-schedule.sh`, which
rotates the launchd log sink (`~/Library/Logs/whatsoup/release-drift-check.log`
and `.err.log`) before exec'ing the observers under the pinned Node runtime.
Rotation is size-bounded: a file over the cap (default 5242880 bytes) is
archived with `mv`+`gzip` and at most five gzipped generations are kept per
file (`--max-log-bytes` / `--keep-rotated-logs` on the renderer override both).
Rotation failure is fail-visible — a `release-drift-log-rotation-failed`
marker on stderr and a nonzero wrapper status when the log directory cannot be
written — but it never skips the observation itself, and unrotated evidence is
preserved in place.

The renderer substitutes install-time placeholders only. It refuses direct
writes into `~/Library/LaunchAgents`; copying the staged plist there and loading
it is the live alerting change.

Installing a launchd/cron schedule for this command is a live alerting change and
needs separate named approval. The scheduled job must use the pinned Node runtime
and either an explicit reviewed release path or the active bot plist's
`WorkingDirectory` via `--launchd-plist`; the latter is preferred so the check
tracks future re-cuts. It must remain read-only: no apply, re-cut, plist
mutation, restart, cleanup, WhatsApp turn, or credential change.

### Release currency is a separate observation

The scheduled macOS release observer also runs
`scripts/live-release-currency-alert.ts` through
`scripts/live-release-observers.ts`. Currency compares the active release
manifest's full source commit to an explicitly rendered remote branch ref. It
does not use the host's ordinary source checkout and it does not change runtime
health or readiness.

Currency has three states: `current`, `target-differs`, and `inconclusive`.
`target-differs` intentionally does not claim behind, ahead, or divergence and
does not authorize deploying the target. Review the approved release and its
required capabilities before any rollout; capability admission remains a
separate contract. Missing manifests, unsafe remote transports, malformed refs,
network failures, timeouts, and malformed remote output are inconclusive rather
than silently current.

Render the observer with an explicit reviewed target when it is not the default
public WhatSoup `main` ref:

```bash
bash deploy/scripts/render-release-drift-launchd.sh \
  --instance <instance> \
  --repo-root "$PWD" \
  --home "$HOME" \
  --target-url https://github.com/<owner>/<repo>.git \
  --target-ref refs/heads/<approved-branch> \
  --output /tmp/com.whatsoup.release-drift-check.plist
```

The same schedule emits integrity findings under `release-drift` and currency
findings under `release-currency`. `--clear-on-ok` clears each source only from
its own successful observation. Installing or updating the rendered job remains
a separately approved live-host mutation.

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

Live acceptance is a separately approved operation. Capture the source commit,
release path, manifest path, and prepared rollback target before repointing a
service manager. A scoped live turn, bogus-model check, or temporary-config
change needs its own explicit approval; none is part of the startup-notification
procedure below.

### Startup-notification acceptance

This is the one manager-neutral startup-notification acceptance and rollback
evidence procedure. Its execution requires explicit owner approval in the
current turn, including the named instance, release, service-manager action,
and rollback target. It does not authorize a deploy, restart, message send, or
external action by itself.

Run it once under launchd and once under systemd after that approval. Record the
manager and unit/plist identity in each receipt, but do not add a manager branch
to the protocol or this procedure. Docker inherits the process protocol and
remains untested. Source tests do not prove portability; only the two approved
operational receipts establish those manager claims.

1. **Prepare owner-private release and rollback evidence.** Capture the source
   commit, release path, release manifest path/digest, instance name,
   service-manager identity, and timestamp. Before the approved restart,
   capture the previous known-good release path/ref/manifest and the exact
   rollback action for that manager. This is evidence preparation, not
   permission to perform either action.
2. **Perform one approved restart.** Use the selected manager's established
   operational command exactly once for this acceptance attempt. Do not use a
   second restart to turn a wait, failure, or inconclusive result into green.
3. **At generic eligibility, capture the inputs.** After the configured
   generic stability window (with its three-second floor), capture the raw
   `GET /health` response and the private
   `<stateRoot>/startup-notify.json` v1 journal into the receipt directory.
   The captured health must show `status: "healthy"` and strict readiness through
   `transport.connected: true` and `transport.connection.state: "connected"`,
   then `startupNotification.state: "sent"`,
   `startupNotification.policy: "generic"`, a null `nextEligibleAt`, and the
   matching journal watermark/boot evidence (including `lastSendAt` no earlier
   than the watermark). Record this health observation as `passed`, `failed`,
   or `unavailable`; use `passed` only when the captured observation meets
   those conditions. `sent` is tracked submission evidence, not a
   provider-delivery claim. This acceptance expects generic aggregation to be
   enabled; a disabled or named-only policy is intentionally non-green.
4. **Run the fail-closed validator on the captured files.** The validator is
   one-shot and does not execute a probe command, contact a provider, inspect
   `bot.db`, run a daemon, or create a fleet monitor. It consumes the supplied
   files and the recorded observation outcome:

   ```bash
   bash scripts/run-with-pinned-node.sh scripts/validate-startup-notification-release.ts \
     --health-file "$RECEIPT_DIR/health.json" \
     --journal-file "$RECEIPT_DIR/startup-notify.json" \
     --probe-outcome passed \
     > "$RECEIPT_DIR/startup-notification-validation.json"
   ```

   Capture the command's stdout and exit status. Exit `0` is accepted only for
   the complete `sent`/`generic` submission projection, valid v1 journal,
   matching timestamps/watermark, and supplied `passed` outcome. Exit `1` is
   a rejected contract; exit `2` is missing, unreadable, malformed, or
   unavailable input and is inconclusive. Any nonzero result is non-green. Do
   not add other validator options or replace a failed or unavailable outcome
   with `passed`.
5. **Capture result or rollback evidence.** Preserve the approval reference,
   manager identity, release/rollback evidence, raw health and journal inputs,
   validator JSON, exit status, and timestamp together. On a non-green result,
   stop the acceptance attempt. A rollback is the previously prepared,
   separately approved manager action; capture its target, invocation result,
   and resulting health. It is a recovery action, not a retry or a second
   portability acceptance run.

Until the applicable receipt is accepted, do not claim the live instance has
the startup-notification release protection. Waiting, `send_failed`,
`journal_unreadable`, malformed/future journal data, a failed observation, or
an unavailable observation is explicitly non-green.

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
