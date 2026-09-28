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

### `npm run release:activate`

`scripts/release-activate.ts` performs the coordinated switch described in the
rest of this section. It is **macOS launchd only**; on any other platform it
refuses with exit `2` before doing anything. Every site value is a parameter or
is derived: paths from `HOME`/`XDG_*`, the health port from the instance
`config.json` (or `--health-port`), and the expected commit from the new
release's manifest. The health token is resolved with the precedence of
`deploy/scripts/lib/health_reader.py` and is never printed.

```bash
npm --silent run release:activate -- \
  --instance <instance> \
  --release /abs/path/to/<new-release> \
  --expect-current /abs/path/to/<current-release> \
  --aux-label com.whatsoup.reply-guarantee=setup-timer \
  --aux-label com.whatsoup.release-drift-check=release-drift \
  --backup-dir /abs/path/to/<backups> \
  --plan
```

- `--plan` (the default) is read-only. It prints JSON listing every
  precondition, each staged plist (with `renderDriftLines`, the number of lines
  that differ from the installed plist beyond the release root), and the ordered
  actions. It exits `0` only when every precondition holds. It runs the new
  release's renderers to capture their output, and writes nothing.
- `--apply` re-checks every precondition, then:
  1. takes a quick_check-verified SQLite backup, records the backup's schema
     migration level (`schemaMigration.before` in the receipt), records
     `symlink.before`, and copies and stages every plist into a mode-0700
     `<backup-dir>/activation-<commit12>-<utc>/`;
  2. switches the wrapper symlink and installs the staged plists;
  3. reloads each label with the reload sequence below;
  4. verifies from the executing process (a new pid whose argv names
     `<release>/src/bootstrap.ts`, authenticated health with the manifest
     commit and `whatsapp.connected: true`, and each auxiliary job's loaded
     definition on the new release).

  Any failure after the switch restores the symlink and plists, reloads every
  label, and verifies the rollback the same way — unless the new release
  changed the database schema (see "Rollback against a migrated database"
  below). `receipt.json` in the backup directory records the outcome.

Preconditions include: the wrapper symlink points at
`<expect-current>/deploy/whatsoup`; the new manifest is schema-valid, names
`--release` as its path and carries a full commit; the new release has
`deploy/whatsoup`, `src/bootstrap.ts` and `node_modules`; each auxiliary job
currently runs from `--expect-current`; a health token and port resolve; the
database exists; and no staged plist still references `--expect-current`.

Renderers (`--aux-label <label>=<renderer>`):

- `setup-timer` re-renders `deploy/<label>.plist` exactly as `deploy/setup.sh`
  `install_launchd_timer` does, from inside the new release, including the
  `launchd-claude-config-env.ts --preserve-from` filter;
- `release-drift` runs the new release's
  `deploy/scripts/render-release-drift-launchd.sh`, carrying the installed job's
  `--instance`, `--target-url`, `--target-ref`, `--max-log-bytes` and
  `--keep-rotated-logs` values forward.

The instance plist is edited, not re-rendered. `ProgramArguments[0]` is left
alone when it is the wrapper symlink and rewritten only when it names
`<expect-current>/deploy/whatsoup`. `WorkingDirectory` is rewritten only when it
lies inside `--expect-current`.

Exit codes: `0` plan ready, or activated and verified; `1` activation failed
and the rollback was verified; `2` refused before any live change; `3`
activation failed and the rollback could not be verified, so manual attention
is required; `4` activation failed and the automatic rollback was blocked
because the new release changed the database schema migration level (or the
level could not be read) — outcome `rollback-blocked-migrated`, manual database
restore required.

#### Health invariants verdict (report-only, #2481)

Under `--apply`, after the outcome is final, `receipt.json` (and the stdout
receipt) carries an `invariants` record:

- `floor`: the schema and the required ids from the `src/core/health-invariants.ts`
  (`RELEASE_INVARIANT_FLOOR`) of **the tree that runs the tool**, and
  `toolCommit`, that tree's commit (its release-manifest commit, read only
  when the manifest is a regular file of at most 64 KiB, else the `HEAD` of
  the checkout whose top level is that tree, asked with the clean git
  environment; `unknown` when neither resolves within 5 s). The floor comes
  from the release under test only if the tool is run from inside that
  release; `toolCommit` shows which tree it was. The lookup starts after the
  outcome and exit code are final and uses only asynchronous file reads. The
  manifest is opened once (non-blocking, never through a symlink), checked with
  fstat on that descriptor, and read only from it, at most 64 KiB + 1 bytes; a
  manifest that grew past 64 KiB after the check is refused. When the 5 s bound
  expires the lookup is marked expired, and no later step (in particular the
  `git` fallback) starts. A filesystem call already in flight cannot be
  cancelled in Node, so a stalled one can keep the process alive after the
  result is printed; the lookup reads only the tool's own checkout, the tree
  the CLI was loaded from. It is provenance, not attestation: `git` is
  resolved from `PATH` (as the repository's other tool git calls are), and the
  manifest's commit is taken as written.
- `activation`, and `rollback` when a rollback restarted the old release and
  observed it (otherwise `null`): the verdict for the process `verify`
  observed, read from the `health_invariants` block of its authenticated
  diagnostic body:
  - `satisfied`: the process declared every floor id. This is a declaration by
    the loaded code, not a proof of behaviour.
  - `missing`: a 2xx diagnostic body with no block, i.e. a release that
    predates it.
  - `below_floor`: the known schema, omitting a floor id (`undeclared` lists
    them).
  - `unknown`, with `detail`: `unknown-schema`, `malformed`, `unbound` (see
    the binding below), `unobserved` (no diagnostic body at all, or a binding
    that could not be observed), or
    `http-status` (a non-2xx diagnostic body). A failed or erroring read is
    never `missing`.
  - `schema` is `known`, `unrecognised`, or `null`; the producer's schema
    string is never copied.
- `alert`: whether the one event was attempted, its `kind` (`warning`,
  `clear`, or `null` when none is due), and the helper's exit status.

The observation beside it (`verification`, `rollback.observation`) gains
`health.invariants` (`reading`, the floor ids the body declared as
`floorIds`, and `extraIdCount`, a count of every other declared id) and
`binding`: `bound`, `unbound`, `restarted`, or `unobserved`. No
producer-declared id or schema string is stored anywhere: only the tool's own
floor ids and a count.

**Binding.** A body counts only when `binding` is `bound`. The evidence is
the poll that decided verification: the launchd pid (whose argv names the
release entrypoint), the body's own `instance.pid`, and the tool's clock read
immediately **before the health request was sent**. Once the activation
outcome and exit code are final, one sample reads the launchd pid, its argv,
and its process start time (`ps -o lstart=`). The start-time child runs with
only `PATH`, `TZ=UTC0` and `LC_ALL=C` in its environment. `bound` needs the
same pid and argv, a body naming that pid, and a start second **strictly
earlier** than the request second. The causal chain: the responder answered
after the request was sent, and a process that reuses its pid starts only
after the responder exits, so after it answered, so after the request was
sent. Such a process can never bind, however late the tool reads the
response. A start in the request second itself is `unobserved` (a same-second
reuse would read the same `lstart` text). A later start or another pid is
`restarted`; an observation that did not pass verification, a request time
the clock could not give, a sample that timed out, or a start time that could
not be read is `unobserved`; any other mismatch is `unbound`. The verdict is then `unknown` with `detail`
`unbound` or `unobserved`. The pids and times behind the binding, including
the pid the body reports, are used only to compute it and are never recorded;
the record keeps only the pre-existing launchd `pid`.

Report work never changes when or how the outcome is decided. Inside the
verification poll the binding adds only a clock read before each request, in
its own `try`: a clock fault leaves that observation's binding `unobserved`
and never touches the health read or the pass decision. After the exit code
is fixed, the whole report phase (binding sample, tool-commit lookup, receipt
writes, event, stdout) runs inside one exception boundary: any throw prints
only `release:activate: report-failed <error class>` (never the message, which
can carry a path), and the already-fixed exit code is returned; a failing
stderr is ignored. Every binding exec (`launchctl print`, `ps -o command=`, `ps -o lstart=`)
runs after the outcome and exit code are final, is attempted once (a timeout
or failure is `unobserved`, never retried), has its own 5 s timeout and is
killed with SIGKILL. One sample serves both observations, and it is taken only
when an observation passed with a diagnostic body, so the bounded cost is at
most 15 s, and it delays only the receipt, the event and stdout. The
tool-commit lookup (at most 5 s) follows it. Every other `launchctl`, `ps`,
`plutil` and renderer call keeps its previous behaviour, with no timeout.
These 5 s bounds cover the receipt, the event and stdout, not process exit: a
`ps` child that SIGKILL cannot reap, or a stalled filesystem call in the
tool-commit lookup, can keep the process alive after stdout is printed (the
exit code it then returns is still the fixed one).

Consequence for rollbacks, the exact warn/clear rule:

- a failed activation verification always warns: that observation did not
  pass, is never sampled, and is recorded `unknown`/`unobserved`. So
  `rolled-back` never clears, even when both processes declare the floor; the
  incident is cleared by a later `activated` run whose verdict is satisfied;
- after an **auxiliary-label** failure the activation observation passed, and
  the result depends on whether the rollback touched the instance:
  - a rollback that restored and restarted the instance: the sample sees the
    restarted process, so the activation reads `restarted` and warns;
  - a rollback that stopped before touching the instance
    (`rollback-blocked-migrated` at the schema gate, or `rollback-unverified`
    from a failed bootout): the sample can still see the verified new
    process, so the activation can read `bound`, and with every verdict
    satisfied **no event** is sent (the blocked rollback's own stderr and exit
    code carry the alarm);
- a clear is sent only for `activated` with every verdict satisfied.

This checks the producer's self-reported identity inside one window. It is
not a kernel proof: a process of the same user that holds the health port and
reports the right pid is outside it, and nothing is known about a restart
after the sample. The rule compares a kernel start time with the tool's
clock, both wall-clock: a wall-clock step backwards between the request and a
pid reuse (a manual clock change or a large NTP correction) can give the
reusing process a start second earlier than the request, and bind it. A producer that
predates `instance.pid` reads `unbound`.
It relies on the instance being the launchd job's own process:
`deploy/whatsoup` execs node, `src/bootstrap-common.ts` imports the main
module in that same process, and `src/core/health.ts` reports that
`process.pid` as `instance.pid`.

**What the receipt holds.** `receipt.json` is a local operator record in the
private backup directory (mode 0600). The activation record already carries
host data: release and backup paths, commits, the instance name, and the
launchd pids. Nothing #2481 adds carries a producer string, a pid, or host
data: the added fields are the tool's constants (schema, floor ids), enums
(including `binding`), booleans, counts, `null`, and `toolCommit`, the commit
of the tool tree.

`receipt.json` is written with the verdict **before** the event is sent
(`alert.status: "pending"`), then rewritten with the final status, so an
interrupt during the event leaves the verdict on disk. Every write is atomic
(temporary file, fsync, rename), followed by exactly one required directory
fsync (the shared writer's own directory fsync is turned off for this call),
and publication and durability are reported apart, so the durability line
prints at most once per write:

- a write that fails **before** the rename leaves the previous receipt whole
  and prints `release:activate: receipt-write-failed <ERRNO>`;
- a write whose rename succeeded but whose directory fsync failed leaves the
  **new** receipt published, not proven durable across a crash, and prints
  `release:activate: receipt-written-durability-unproven <ERRNO>`;
- otherwise the new receipt is published and durable.

The stderr line carries the errno name only (for example `EACCES`; never the
path or the error text). The event is still attempted and the exit code is
unchanged, because it reports the live activation, which a lost receipt does
not change. If the event also fails, stderr says the verdict is in
`receipt.json` whenever the first write published a receipt (durable or not),
and otherwise that the verdict was not recorded.

At most one BOT ERRORS event is sent, through the release observers' alert
helper, for source `release-invariants:<digest>`: the first 8 hex of sha256
over the schema and the sorted floor ids, joined by newlines. A tool with a
different floor raises and clears a different incident, so a clear never
closes a requirement it did not check. The dispatcher keeps that source
unchanged (its source segment allows `[A-Za-z0-9_.:-]`).
- a **warning** for any `--apply` that reached the switch with a recorded
  verdict that is not `satisfied`;
- a **clear** for the same instance and source only when the outcome is
  `activated` and every recorded verdict is `satisfied`; a clear with no open
  incident is dropped by the dispatcher;
- nothing when every recorded verdict is satisfied but the outcome is not
  `activated` (the auxiliary-label paths above), after a refusal (before or
  during the apply; no verdict), or for `--plan` (which never reads
  invariants).

See "Consequence for rollbacks" above for which rollback paths warn.

**Stranded incidents.** A clear resolves only the incident of its own source.
Incidents opened under the earlier bare `release-invariants` source, or under
the digest of an earlier floor, are never closed by a later clear. Before
resolving one by hand, the operator checks that the live instance meets the
floor that incident was raised for (the `evidence` line names its schema and
ids), then resolves it in BOT ERRORS.

Per operator decision, both the warning and the clear are **standard BOT
ERRORS events with no log tail**, on the private operator channel: the payload
this tool supplies carries verdicts and ids only (no paths or commits), and
the delivered event carries the standard operator fields every BOT ERRORS
alert carries (machine, platform, instance, process, runtime, and diagnostic
hints such as log-location hints and the outbox path), with the inline log
tail turned off for this call (`BOT_ERRORS_INLINE_LOG_TAIL=0`, the only
per-call override the helper accepts).

stdout stays one JSON document, printed after the event, so it can trail the
activation by the bounded report work above (at most 20 s) plus up to the
helper's 60 s timeout; `receipt.json` already holds the verdict during the
helper wait.

The verdict is **report-only**: it is not part of the pass condition, and the
outcome and every exit code above are unchanged. A failed event is printed to
stderr and recorded in `alert.status`; it does not change the exit code either.
Expect `missing` for rollback targets built before the block existed.

`kickstart -k` on an auxiliary timer runs that job once immediately; the plan
lists it. The manual procedure below remains the reference for what the command
does, and the fallback when it cannot be used.

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
service DOWN. On one `<host>`, recovery was a second `bootstrap` after the
process had exited. The wait for the old pid comes first; a retry never
substitutes for it. `release:activate` refuses to bootstrap while the old pid is
still running. After that pid has exited, it retries only the transient error
class, and only within a bounded limit.

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

`release:activate` performs this rollback automatically. It keeps the symlink
target and plist copies in `<backup-dir>/activation-<commit12>-<utc>/` rather
than as `.bak` files beside the plists. It checks `--expect-current` at plan
time; it does not fall back to a manifest rollback path. Exit `3` means the
automatic rollback could not be verified: restore by hand from that directory
using the steps above.

#### Rollback against a migrated database (exit `4`)

The rollback starts the OLD binary, and the old binary refuses a database
whose schema migration level is above its own ceiling
(`DatabaseCompatibilityError` `future_schema`). A new release that migrated the
database at startup and then failed verification would therefore leave the bot
down after an ordinary rollback. `release:activate` does not restore the
database automatically; it detects the case and stops:

- Before rolling back it reads the live database's level (read-only) and
  compares it with the level recorded from the backup. It reads again after the
  new instance has been booted out and has exited, before restoring anything,
  because a migration can commit during shutdown.
- If the level changed, or cannot be read (fail closed), it does NOT restore
  the symlink or plists and does NOT start the old release. The new release
  stays in place: as verification left it (`blockedAt: before-rollback`), or
  with its instance stopped (`blockedAt: after-instance-stop`).
- It exits `4` with outcome `rollback-blocked-migrated`. `receipt.json` records
  `schemaMigration.before`, `after` (or `afterError`) and `blockedAt`. stderr
  prints both levels, the backup path, and the restore commands with this
  host's paths filled in.

**Data loss:** restoring the backup loses every message received after the
backup was taken. The moved-aside live database is then the only copy of them;
keep it. Restore only with approval naming the instance:

```bash
# 1. Stop every label the activation touched; the instance must be gone.
launchctl bootout gui/"$(id -u)"/com.whatsoup.<instance>
launchctl bootout gui/"$(id -u)"/<each aux label>
launchctl print gui/"$(id -u)"/com.whatsoup.<instance>   # must fail: not loaded
# 2. Move the live database and its sidecars aside together.
aside=<db>.pre-restore-$(date -u +%Y%m%dT%H%M%SZ); mkdir -m 700 "$aside"
mv <db> <db>-wal <db>-shm "$aside"/                       # -wal/-shm may be absent
# 3. Restore the pre-activation backup.
cp <backup>/bot.db <db> && chmod 600 <db>
# 4. Repoint the wrapper symlink and the plists to the old release.
ln -sfn "$(cat <backup>/symlink.before)" ~/.local/bin/whatsoup
cp <backup>/<label>.plist ~/Library/LaunchAgents/<label>.plist   # every label
# 5. Start every label, then verify from the executing process as above.
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/<label>.plist
```

Never leave a `-wal` or `-shm` file from the migrated database beside the
restored `bot.db`.

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

`live-release-drift-alert.ts` prints one structured JSON log record to stdout
per checked target — exactly one for a single `--release` or `--launchd-plist`,
and one per job when `--launchd-plist` is repeated (in addition to `--json`
printing the full result).
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
  --preserve-from "$HOME/Library/LaunchAgents/com.whatsoup.release-drift-check.plist" \
  --output /tmp/com.whatsoup.release-drift-check.plist
```

`--preserve-from` keeps a `CLAUDE_CONFIG_DIR` the installed job already carries
when the instance config sets none; a missing installed plist preserves
nothing, so the flag is safe on a first install too.

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
and either an explicit reviewed release path or a job's plist via
`--launchd-plist`; the latter is preferred so the check tracks future re-cuts.
It must remain read-only: no apply, re-cut, plist mutation, restart, cleanup,
WhatsApp turn, or credential change.

`--launchd-plist` derives the release from `ProgramArguments` — the wrapper
symlink for the bot and fleet jobs, the absolute script path for the auxiliary
jobs — exactly as "Activation is a coordinated switch" above describes. It reads
`WorkingDirectory` only as a cross-check and reports
`launchd-working-directory-mismatch` when the two disagree, which is the
WorkingDirectory false pass caught at observation time rather than at incident
time. A job whose release cannot be derived from `ProgramArguments` fails closed
(`checker_failed`, exit 2); it never falls back to `WorkingDirectory`, because
that fallback is what let a stale release read as green for two months.

`--launchd-plist` is repeatable, so one invocation can cover the instance job
alongside `com.whatsoup.whatsoup-fleet`, `com.whatsoup.harness-maintenance`,
`com.whatsoup.release-drift-check`, and `com.whatsoup.reply-guarantee` — the
mixed-generation estate the coordinated switch exists to prevent. The invocation
exits on the worst status across the set, so one healthy job cannot mask a stale
one.

`--clear-on-ok` is refused alongside several `--launchd-plist` targets. BOT
ERRORS keys an incident by `machine|instance|source` and every target in one
invocation shares that key, so a clean job's clear would resolve the incident a
drifted job had just opened. `--instance`, `--source`, and `--manifest` are
likewise per-invocation, not per-job: a multi-job run labels every event with
the same instance and source, and checks every release against one `--manifest`
override if given. Use single-target invocations when per-job attribution or a
clear event matters.

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
  --preserve-from "$HOME/Library/LaunchAgents/com.whatsoup.release-drift-check.plist" \
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
