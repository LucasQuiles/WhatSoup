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

The exporter is an operator tool for a trusted checkout and toolchain. Its `git`
and `tar` executables are selected through `PATH`; use an operator-controlled
`PATH` and trusted executables. `cleanGitEnv` removes Git configuration overrides
and sets `GIT_OPTIONAL_LOCKS=0`, so `git status` does not take the index lock. It
does not authenticate those executables. The exact-commit checks below assume that
toolchain is trusted.

The operator also controls `--release-root` and `--rollback-root`, including every
ancestor directory. Use non-symlinked directories and keep them free of concurrent
writers for the whole export. Absolute-path validation is lexical; it does not
confine writes against another writer replacing an ancestor. A rollback root may
be separate from the release root by design and must satisfy the same precondition.

Provision memory and disk for the selected commit before export. The archive is
buffered with a 1 GiB subprocess output limit, the full tree is extracted, and
each selected file is read into memory for hashing. There is no aggregate staging
quota or file-count limit. A process crash can leave staging for later inspection;
it is not evidence of a published or qualified release.

Export properties under those preconditions (all fail closed, except the pending
host-built outputs described below):

- the commit must be `refs/remotes/origin/main` or an ancestor of it, in a
  clone whose `origin` resolves (after `insteadOf` rewrites) to
  `github.com/LucasQuiles/WhatSoup`. Run
  `git fetch origin +refs/heads/main:refs/remotes/origin/main` in the exporting
  clone first; that form also works in a single-branch clone. A commit that has
  not landed on `main` is refused with `release source must be on main: commit
  <sha> is not refs/remotes/origin/main (<main-sha>) or an ancestor of it`
  before anything is written. The check reads the local remote-tracking ref and
  never the network. Because `main` on that repository is protected against
  force-push, a stale ref can refuse a landed commit (fetch, then retry) but
  never admit an unlanded one. An `origin` that is a fork, mirror or local
  checkout is refused, because its own unpushed commits would look landed. The
  ref is read by its full name only, replace refs are ignored for every git read
  in the export, and a repository with a legacy `info/grafts` file is refused,
  so local history rewrites cannot make a commit look landed. A shallow clone
  can refuse a landed commit beyond its depth; `git fetch --unshallow origin`
  fixes that. The JSON report records the main commit used as `sourceOnMain`.
  Hosts that start directly from a git checkout (`deploy/preflight-check.sh` on
  a non-release tree) are not covered by this check; until every host runs a
  release from `main`, refusing those restarts would stop hosts whose current
  build has not landed yet;
- source bytes come from `git archive <commit>`, so working-tree drift can
  never leak into a release;
- the release is assembled in a staging directory and self-checked with the
  SAME drift checker the fleet runs (`--check-release` semantics) BEFORE it is
  atomically renamed into place — a failed export leaves no release. The one
  tolerated finding is `required-output-missing` (next item);
- required outputs are built on the host after export, so export cannot see
  them. They are the `--required-output` paths, plus `dist/index.html`
  automatically when the commit tracks `console/package.json`. Export publishes
  the release without them and lists them in the report as
  `pendingHostOutputs`. The drift check keeps reporting `required-output-missing`
  until they exist, and `release:activate` refuses the release meanwhile;
- when `deploy/source-runtime-manifest.json` is present, its pinned entrypoint
  graph is also checked against the staged release and its release manifest;
  a stale source hash refuses publication before restart preflight;
- secret- and state-shaped paths (`tokens.env`, `*.db`, `auth/**`, ...) are
  excluded even when git-tracked;
- an existing release is never clobbered: without `--replace` the export
  refuses; with `--replace` the prior release is preserved at the manifest's
  rollback path first. The rollback slot itself is also never overwritten: a
  second `--replace` of the same release name refuses while
  `.rollback/<name>-before` is occupied — verify the preserved copy is no
  longer needed, then remove it manually before re-running;
- dependencies and the console build are NOT produced by the export. On the
  host, inside the release, run:

  ```bash
  bash scripts/run-with-pinned-npm.sh ci
  bash scripts/run-with-pinned-npm.sh --prefix console ci
  bash scripts/run-with-pinned-npm.sh --prefix console run build   # writes <release>/dist, served by the fleet
  ```

  The restart preflight blocks a release without `node_modules`, and
  `release:activate` refuses a release whose required outputs are missing or are
  not regular files inside the release (a directory or a symlink does not count).

Reading the export result: `ok: true` means the release was published. While
any required output is pending, `selfCheck.ok` in the JSON report is `false`,
because `selfCheck` is the plain drift report and still lists
`required-output-missing`; `pendingHostOutputs` names the paths still to build.
Without `--json`, the summary prints `self-check ok` when nothing is pending.
Otherwise it prints `self-check ok except pending host build: <paths>`,
followed by a pointer to this runbook. The former `self-check ok=<true|false>`
line is no longer printed: a script that parsed it must read
`pendingHostOutputs` from the JSON report instead.

The export creates release bytes only. Repointing a service at the new release
and restarting it remain separately-approved host mutations, and must preserve
instance config, auth, logs, DBs, token files, and keychain material outside
the release tree.

## Activating a release

Activation is the separately-approved host mutation the section above stops
short of. Having exported a release is not approval to activate it: activation
needs named approval in the current turn, naming the instance, the target
release, and the prepared rollback target.

A release exported from a commit that tracks `console/package.json` (every
current `main` commit) cannot be activated until the host has built its
console. First run the host step from [Dry-Run Planning](#dry-run-planning)
inside the new release: both `ci` installs, then the console build. Until
`<release>/dist/index.html` is a regular file inside the release, `--plan`
lists the precondition `release-required-outputs-present` as failed and exits
`2`, and `--apply` refuses the same way. `--apply` checks the outputs again
under the activation lock, just before the switch, against the list the plan
checked: a manifest whose `requiredOutputs` or `release.path` changed after
planning is refused before any change. A release whose manifest
lists no `requiredOutputs`, such as one exported before this requirement, is
not affected.

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
- `--backup-dir` must either be absent, in which case `--apply` creates it with
  mode 0700, or be a real directory (not a symlink) owned by the current user
  with no group or other permission bits. Planning (precondition
  `backup-dir-private-owned`) and `--apply` both refuse any other directory;
  neither changes its mode. `--apply` re-runs that precondition and makes its
  last check just after creating or finding the directory, before the first
  backup write; a process running as the same user that replaces or loosens it
  after that last check is not detected. Each
  activation writes its backups into a new child directory created with mode
  0700 (the process umask can only remove bits from that mode).
- `--apply` re-checks every precondition, then:
  1. takes a quick_check-verified SQLite backup, records the backup's schema
     migration level (`schemaMigration.before` in the receipt), records
     `symlink.before`, and copies and stages every plist into a mode-0700
     `<backup-dir>/activation-<commit12>-<utc>/`;
  2. switches the wrapper symlink and installs the staged plists. Each
     installed plist keeps its current permission bits, capped at `0644`
     because launchd refuses group- or world-writable job definitions. An
     owner-only (`0600`) instance plist, for example one carrying credentials
     in `EnvironmentVariables`, stays `0600` through the switch and through
     the automatic rollback;
     Root-owned WhatSoup LaunchAgents are replaced through the root plist
     helper installed on the host (see "Root-owned LaunchAgents: the root
     plist helper" below). A missing or outdated helper refuses the
     activation before the switch; a helper that reports incomplete recovery
     fails the activation;
  3. reloads each label with the reload sequence below;
  4. verifies from the executing process (a new pid whose argv names
     `<release>/src/bootstrap.ts`, authenticated health with the manifest
     commit and `whatsapp.connected: true`, and each auxiliary job's loaded
     definition on the new release).

  Any failure after the switch restores the symlink and plists, reloads every
  label, and verifies the rollback the same way — unless database migration or
  the sealed refresh-fence compatibility gate blocks automatic rollback (see
  "Rollback" below). `receipt.json` in the backup directory records the
  outcome.

Preconditions include: the wrapper symlink points at
`<expect-current>/deploy/whatsoup`; the new manifest is schema-valid, names
`--release` as its path and carries a full commit; the new release has
`deploy/whatsoup`, `src/bootstrap.ts` and `node_modules`; every manifest
`requiredOutputs` path (the built console) is a regular file inside the new release,
reached without a symlinked path component, checked again under the activation lock
just before the switch, where the manifest must still name `--release` and list
exactly the outputs the plan checked; each auxiliary job
currently runs from `--expect-current`; a health token and port resolve; the
database exists; and no staged plist still references `--expect-current`.

The script does not check Microsoft 365 plugin copies. For a binding with
`workflowAuthority`, the runtime checks both copies at startup, before each later
native-settings write, before each `claude-cli` spawn, before each turn publishes its
authority and before each `microsoft365` adapter launch. A binding without
`workflowAuthority`, and every `accountEmail` binding, gets no native-copy check: its
`claude-cli` children receive the bridge key and load the `enabledPlugins` copy unchecked,
so only the settings deny floor stops native writes, and the adapter checks only the
`pluginDirs` copy it launches. Before
activating a release for an instance with an `m365Bridge` binding, check that the guarded
plugin is installed through `agentOptions.pluginDirs`. When no guarded plugin is admitted
there, or the copy that `enabledPlugins` names is missing or differs from the guarded
copy, including after a marketplace update during the run, the runtime withdraws
`workflowAuthority` and logs `Microsoft 365 workflow authority withdrawn` with a reason.
Microsoft 365 writes then stay denied until both copies match and the instance restarts.
See the "One guarded plugin build" note in
[the configuration reference](../configuration.md#connector-mutation-policy-411).

Activate a release that introduces `workflowAuthority` before you add that key to the
instance configuration: the previous release refuses it, so the automatic rollback
could not start the old binary on such a configuration. See "Deploy order" in the
configuration reference.

#### Root-owned LaunchAgents: the root plist helper

A root-owned, `uchg`-protected `com.whatsoup.<name>.plist` in the bot user's
`~/Library/LaunchAgents` cannot be replaced by the bot user. Activation
replaces it through `protected_plist.py`, run as root by exactly one sudoers
rule, from a fixed root-owned install:
`/Library/PrivilegedHelperTools/com.whatsoup.protected-plist.py` (root:wheel
`0444`). `scripts/lib/release-activation/root-helper.json` is the one record of
that path and of the helper's sha256. Change the helper and that pin in the
same commit; a test fails when they differ. Before any live change, activation
compares the installed helper with the pin. This is a version check, not a
security control. A mismatch refuses with "root plist helper missing or
outdated; run the install step".

What the helper guarantees:
- Root changes no inode except the intended plist and the files that run
  itself creates. It never writes, chmods, chowns or changes the flags of
  anything else, whatever the bot user does to its folders during the run.
- The plist must be root-owned, single-link, at most `0644`, readable by the
  bot user, free of any ACL, and either unflagged or flagged `uchg` only. Root
  changes only the `uchg` flag, and only while that flag freezes the plist's
  single name. The ACL check runs on the opened file before any byte is read:
  Darwin applies an ACL before the mode bits, so a deny entry could hide the
  plist from the bot user while its mode bits allow the read. A folder whose
  inheritable ACL would reach root's new copy is refused before any change.
- The new contents must be a strict XML plist (Apple's document type, known
  elements only, one top-level dictionary) whose `Label` names the target.
- A failed replacement restores the original bytes and protection. When it
  cannot do that and confirm it, the helper exits 3 and the activation fails
  with "root plist helper recovery is incomplete": inspect that plist and its
  `uchg` flag before any retry.
- `sudo` relays every signal it receives, so the bot user can send the helper
  any signal. While the helper's work runs, it blocks in its own thread every
  signal except SIGKILL, SIGSTOP, SIGABRT and the fault signals (SIGSEGV,
  SIGBUS, SIGFPE, SIGILL, SIGTRAP, SIGSYS). A mask holds only in one thread,
  and the helper's `os.getgrouplist` call starts a second thread that leaves
  SIGPROF and SIGEMT deliverable. So, for the whole process, the helper also
  ignores the blocked signals whose default action terminates, cores or stops
  it: SIGHUP, SIGINT, SIGQUIT, SIGEMT, SIGPIPE, SIGALRM, SIGTERM, SIGTSTP,
  SIGTTIN, SIGTTOU, SIGXCPU, SIGXFSZ, SIGVTALRM, SIGPROF, SIGUSR1 and SIGUSR2.
  The other blocked signals (SIGURG, SIGCONT, SIGCHLD, SIGIO, SIGWINCH,
  SIGINFO) are discarded by default and keep their disposition. It also raises
  its CPU limit. When the work ends, it restores the mask and the
  dispositions. A signal can then end the helper again, but only after the
  change or its recovery has finished; activation reports that death as
  unconfirmed.
- Signals still deliverable during the change: SIGKILL and SIGSTOP, which no
  process can block, catch or ignore, and SIGABRT and the fault signals, which
  report the helper's own crash but which the bot user can also send through
  sudo. Whether the bot user can cause a SIGKILL or SIGSTOP of the helper is
  not established. A death by SIGKILL, SIGABRT or a fault signal after `uchg`
  is cleared re-protects nothing. It leaves the plist without `uchg`, holding
  the old bytes before the rename or the new bytes after it, possibly with a
  leftover `.<name>.activate-*` file in the folder. A SIGSTOP there holds the
  plist in that state until the helper continues. Activation reports any of
  these as unconfirmed (next item). An interruption raised as an exception,
  such as KeyboardInterrupt, re-protects what it can and exits 3.
- Activation trusts only exit 0 with the new bytes in place and exit 2
  (refused, plist as found). Every other result means unconfirmed protection
  and the rollback reports `rollback-unverified`: exit 3, a signal (SIGKILL or
  a fault signal), the 30-second timeout, or another code. That includes
  sudo's own exit 1 when the sudoers rule is missing.

What it does not guarantee: the bot user owns `~/Library`, so it can always
rename its own `LaunchAgents` folder and create another one. Between the rename
into place and setting `uchg`, it can also swap the new plist; the helper
detects that and reports incomplete recovery (exit 3), but cannot prevent it.
In a user-owned home, `uchg` gives tamper resistance, not a security boundary.

A host that lets the bot user run anything as root gets no protection from the
helper. That includes a host whose sudoers grants the bot user
`NOPASSWD: ALL`; check with `sudo -l -U <bot-user>`. It also includes a bot
user in the `admin` group while an Xcode under `/Applications` is the selected
developer folder: `/Applications` is admin-writable, and `/usr/bin/python3`
resolves through that folder.
sudo keeps `HOME`, so the rule runs Python isolated (`-I`), without
`site` (`-S`, so no site-packages or `.pth` file loads) and without bytecode
writes (`-B`); keep `DEVELOPER_DIR` and `TMPDIR` out of `env_keep`.

Owner steps, once per host and again after any helper change:

1. Check out the reviewed `origin/main` commit in a clone the bot user cannot
   write (owned by an administrator, not inside the bot user's home). Running
   the install step from the bot user's release tree would let that user change
   what root installs.
2. Install the helper. The step refuses, before it reads the pin or the helper,
   when the bot user can write the clone's script, pin or helper or any folder
   on their path from `/`. It also refuses on a pin mismatch, on an install
   folder or ancestor that is not root-owned or is group- or other-writable, and
   when the bot user can write any entry on the way to the interpreter: each
   original path component and each symlink hop of `/usr/bin/python3`, the
   selected developer folder and the import path, with the hops' folders. It
   then walks every file and folder below each import-path folder (the
   standard library and `lib-dynload`; root imports these modules) and refuses
   any the bot user can write. A symlink there is checked along its target
   chain, and one that links to a folder, or whose target cannot be inspected
   (a dangling link included), refuses. "Can write" covers the owner,
   the group and other write bits, and ACLs: any ACL entry that is not a deny
   entry refuses. A deny-only ACL, such as `group:everyone deny delete` on
   every macOS home, cannot grant write access and passes. Any error while
   walking, reading an ACL or inspecting `/var/db/xcode_select_link` refuses;
   only a missing select link means the Command Line Tools. When the install is
   already current, it
   changes nothing:

   ```bash
   sudo /usr/bin/python3 -I -S -B <clone>/scripts/lib/release-activation/install_root_helper.py --user <bot-user>
   ```

3. Install the one sudoers rule it prints, replacing any earlier `-I -B` rule.
   Use no wildcards: sudo then matches these exact arguments, in this order.

   ```bash
   sudo visudo -f /etc/sudoers.d/whatsoup-protected-plist
   # <bot-user> ALL = (root) NOPASSWD: /usr/bin/python3 -I -S -B /Library/PrivilegedHelperTools/com.whatsoup.protected-plist.py
   ```

4. Verify the install and the rule:

   ```bash
   shasum -a 256 /Library/PrivilegedHelperTools/com.whatsoup.protected-plist.py   # equals the sha256 in root-helper.json
   ls -le /Library/PrivilegedHelperTools/com.whatsoup.protected-plist.py          # root wheel, -r--r--r--, no ACL
   sudo -l -U <bot-user>   # lists the one rule and no broader NOPASSWD grant
   ```

The install step checks owners, mode bits and ACLs on the clone, the
interpreter chain and the import-path folders. It does not walk the
interpreter's framework library (`Python3`), which sits outside the import
path. Step 4's `ls -le` shows any ACL on the installed helper.

#### BOT ERRORS health-consumer prerequisite

A candidate release can declare the minimum BOT ERRORS health-consumer
capability it needs in its sealed runtime manifest:

```json
{
  "activationRequirements": {
    "botErrorsHealth": { "secureStorageSelector": 1 }
  }
}
```

When this positive requirement is present, `release:activate` reads the loaded
`com.bot-errors.health` definition and accepts two shapes: the direct form that
`install-bot-errors-health-launchd.sh` renders (a Python interpreter as the
program, running the release's `bot-errors-runner.py`, with that release as the
working directory), and the older bash wrapper form whose fallback health profile
path lies under that same release. It reads the consumer manifest,
runner and checker through bounded, no-follow file descriptors below one
consumer root. Each read requires stable
file identity and metadata, plus stable root and ancestor directory identities.
The manifest must record matching runner and checker hashes. The consumer must
advertise `consumerCapabilities.botErrorsHealth.secureStorageSelector` at or
above the required value. The checker's `mustContain` contract must include
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, and every declared marker must be a nonblank
string present in the checker. This checks the packaged contract; marker
presence does not prove deployed probe behavior.

A missing consumer, an unrecognised or malformed loaded definition, a lower
capability, a runner or checker hash mismatch, or a missing or invalid checker
marker contract makes the plan not ready and
refuses activation before a switch. When the sealed runtime-manifest entry is
absent, or its document has no `activationRequirements` declaration, the
existing activation behaviour remains. A present but malformed or non-positive
declaration is invalid and refuses activation.

During `--apply`, after backup staging and immediately before the wrapper
symlink changes, the command reads the consumer again. Its root, capability and
manifest, runner and checker SHA-256 values must exactly match the plan. A
compatible capability or byte change requires a new plan. Any mismatch refuses
activation before the symlink or plist switch. These bounded reads establish
samples; they do not make later launchd execution bytes immutable. Consumer
roots must remain deployment-owned and writers must be serialized through
activation; later execution needs its own controls. This check does not
establish a generic rollback-to-consumer association.

`--apply` and `reconcile-launchd-restart-policy --apply` serialize on
`~/.local/state/whatsoup/release-activation.lock`, one lock per HOME. A held lock
refuses before any backup or live change, and the failure names the lock. A holder
that died in the current boot is reclaimed by the next run. A recycled holder pid
or an unreadable lock keeps refusing: confirm no activation or reconcile is
running, then remove the file. Immediately before the switch, activation refuses
unless the wrapper target and every installed plist still match the plan. Before
reporting `activated` it confirms they still match what it installed; a mismatch
there fails the activation. A rollback restores nothing over state from another
writer, which ends as `rollback-unverified` for the operator to resolve.

`release:activate` remains macOS launchd only. On every other platform, its
existing platform precondition refuses before activation work; this consumer
check supplies no portable replacement.

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
restore required; `5` activation failed and the automatic rollback was blocked
by an incompatible or unreadable sealed refresh fence — outcome
`rollback-blocked-refresh-fence`, manual recovery required.

#### `deploy/setup.sh` on a release host

`deploy/setup.sh` step 3 links `~/.local/bin/whatsoup` to the tree setup runs
from, and on macOS step 4 bakes that tree into the timer plists. Either change
takes effect at the job's next start, such as a crash restart, a watchdog
restart or a reboot, without `release:activate`'s preconditions, backup,
verification and rollback. So once `~/.local/bin/whatsoup` exists, both steps
refuse with exit `2`, naming `release:activate`, unless one of these holds:

- this tree is the one the wrapper already runs, and setup runs through the
  path the wrapper names (a git checkout may also be reached another way);
- the tree the wrapper runs and this tree are both git checkouts.

A tree counts as a git checkout when git reports it as a work tree, by the probe
`deploy/whatsoup` uses to choose git mode, and it has no
`.whatsoup-release-manifest.json` at its root. Every other tree counts as a
release, including an older release without a manifest. A wrapper that does not
resolve to an existing `deploy/whatsoup`, such as one whose target is gone or
whose link chain is longer than 40 links, is refused too; on a fresh install,
remove `~/.local/bin/whatsoup` first. A first install with no wrapper is
allowed. The refusal happens before any step changes anything. Its message
prints a `release:activate` command with an `--aux-label` for each setup timer;
add the others the host runs, as in the example above.

From a tree other than the active release:

- `--npmrc-only` runs only step 5, the hardened `~/.npmrc` merge;
- on Linux, `--skip-wrappers` skips step 3 and `--timers-only` runs only step 4;
- on macOS, only `--npmrc-only` runs, because `--skip-wrappers` and
  `--timers-only` still reach step 4.

`--wrappers-only` runs only step 3, so on a release host it runs only from the
active release. The preflight and the step 1 checks always run. Step 3 replaces
each link by renaming a new link over it, so a link is never missing while it
changes.

**Linux.** `release:activate` refuses on Linux, so no command moves a Linux
release host to another tree, and the refusal says so. To move one on purpose,
stop its units, repoint `~/.local/bin/whatsoup` by hand to the other tree's
`deploy/whatsoup` with a new link renamed over the old one (`ln -s` to a
temporary name, then GNU `mv -T`), never `rm` then `ln`, then run setup from
that tree through the path the link names, and start the units again. Nothing
checks, backs up or rolls back that switch.

**Helper links after an activation.** The fleet console's launchd job starts
`~/.local/bin/whatsoup-fleet`. `release:activate` moves only
`~/.local/bin/whatsoup`; `release:activate-host` also moves
`~/.local/bin/whatsoup-fleet`, but only when its declaration lists
`com.whatsoup.whatsoup-fleet` with `fleet-wrapper`. Neither moves the other
helper links. So after an activation run setup from the active release as
below; otherwise the console can keep starting the previous release.

Step 3 installs eight links in `~/.local/bin`, but the guard reads only
`~/.local/bin/whatsoup`. The other seven point into whichever tree ran setup and
passed the guard:

- `whatsoup-fleet`
- `whatsoup-auth`
- `whatsoup-ensure-node`
- `whatsoup-harness-maintenance`
- `whatsoup-reply-guarantee-drain`
- `whatsoup-heal-notify`
- `whatsoup-release-drift-linux.sh`

After an activation they still run the previous release, and they break if
that release is removed.

To move them, run `deploy/setup.sh --wrappers-only` from the active release,
through the path that `~/.local/bin/whatsoup` names:

```bash
bash "$(dirname "$(readlink ~/.local/bin/whatsoup)")/setup.sh" --wrappers-only
```

The guard passes because that is the tree the wrapper already runs, and step 3
points all eight links into it. No other step runs: no `npm ci`, no console
build and no timer render inside the live release, and a target that is already
executable is not touched. A job that already started through a helper link
keeps running the previous release until it restarts.

If the wrapper names a relative or unnormalized path, the command above does not
apply. setup.sh refuses even from the active release, because the path it would
write never matches. First respell the wrapper as the absolute path of the same
file. That changes no code the bot runs, only how the path is written. This is
the macOS procedure; on Linux use GNU `mv -T` where the block uses BSD `mv -fh`.

1. Run `bash /abs/path/to/<active-release>/deploy/setup.sh --wrappers-only`.
   It refuses and changes nothing. The refusal must say "run setup through the
   path the wrapper names"; any other refusal means this procedure does not
   apply. After `Bot wrapper: … ->` it prints the wrapper's resolved path, with
   every link in the chain and its directories resolved.
2. Put that resolved path in `NEW` and paste the whole block below. It is one
   subshell that stops at the first failed check, with or without `set -e`, and
   prints `stop: …`. It makes the new link only after every check passes:
   - no `release:activate` or reconcile runs, that is,
     `~/.local/state/whatsoup/release-activation.lock` is absent, because this
     writes the wrapper outside that lock;
   - `NEW` is absolute and normalized: it starts with `/`, has no trailing `/`,
     no `//` and no `.` or `..` component;
   - `NEW` is exactly the resolved path: its last part is not a link and its
     directory has no linked part;
   - `NEW` is an existing regular file and the same file the wrapper runs
     (`-ef` compares device and inode, following the link). If it is another
     file, moving the wrapper is a release switch for `release:activate`, not
     a respelling;
   - the temporary link `~/.local/bin/.whatsoup.relink` does not exist in any
     form.

   The block then swaps the link atomically, as setup's step 3 does: it makes a
   new link beside the wrapper and renames it over the old one with BSD
   `mv -fh`, which replaces a link to a directory instead of moving into it. It
   never runs `rm` on the wrapper and then `ln`, because a job that starts in
   between would find no wrapper. If the rename fails, the wrapper is unchanged;
   the block removes the temporary link only while it still points at `NEW`,
   and stops. Last, it reads the wrapper back and stops unless it names `NEW`.

   ```bash
   (
     fail() { echo "stop: $*" >&2; exit 1; }
     NEW='<the path printed after "Bot wrapper: … ->">'
     W="$HOME/.local/bin/whatsoup"
     T="$HOME/.local/bin/.whatsoup.relink"
     LOCK="$HOME/.local/state/whatsoup/release-activation.lock"
     if [ -e "$LOCK" ] || [ -L "$LOCK" ]; then fail "$LOCK exists; an activation or reconcile may be running"; fi
     case "$NEW" in
       */ | *//* | */./* | */. | */../* | */..) fail "NEW is not normalized: $NEW" ;;
       /*) ;;
       *) fail "NEW is not absolute: $NEW" ;;
     esac
     if [ -L "$NEW" ]; then fail "NEW ends in a link: $NEW"; fi
     [ "$(cd -P "$(dirname "$NEW")" 2>/dev/null && pwd)" = "$(dirname "$NEW")" ] || fail "NEW is not the resolved path: $NEW"
     [ -f "$NEW" ] || fail "NEW is not an existing regular file: $NEW"
     [ "$NEW" -ef "$W" ] || fail "NEW is not the file the wrapper runs: $NEW"
     if [ -e "$T" ] || [ -L "$T" ]; then fail "$T already exists; inspect it"; fi
     ln -s "$NEW" "$T" || fail "could not create $T"
     if ! mv -fh "$T" "$W"; then
       if [ "$(readlink "$T")" = "$NEW" ]; then rm "$T"; fi
       fail "could not rename $T over $W; the wrapper is unchanged"
     fi
     [ "$(readlink "$W")" = "$NEW" ] || fail "the wrapper does not name $NEW"
     echo relinked
   )
   ```

   If it stops because `~/.local/bin/.whatsoup.relink` exists, inspect it with
   `readlink`. If it is a link you made in an earlier attempt, remove it with
   `rm` and run the block again; otherwise find out what made it first.
3. After `relinked`, run the `--wrappers-only` command above.

### `npm run release:activate-host`

Host activation is a separate, explicitly declared transaction for one or
more launchd members and their declared shared host consumers. It is not
permission to discover a wider member set or to run `release:activate --apply`
once per instance:

```bash
npm --silent run release:activate-host -- \
  --unit /absolute/path/host-unit.json \
  --release /absolute/path/to/exported-release \
  --backup-dir /absolute/private/retained-backups --plan
```

The schema-v1 declaration lists each instance, its reviewed current release,
and each owned auxiliary label plus its renderer. An auxiliary label cannot be
another configured instance's primary label (`com.whatsoup.<name>` where
`<name>/config.json` exists under the instance config root): a declared
member's label refuses when the declaration is read, any other instance's when
planning. A rendered auxiliary plist must carry the declared `Label`, because
`--apply` writes it to `<label>.plist` and reloads that label.
Planning re-reads installed and loaded launchd definitions, refuses disagreement, and proves every
installed consumer of a selected shared wrapper is declared (the limits are
below). It prints only paths,
digests, membership, port numbers, and state; it never prints health tokens,
config contents, plist environment values, or health bodies.
`--backup-dir` has the `release:activate` rule: absent, or a real directory
owned by the current user with no group or other access, checked for each
member (`<instance>:backup-dir-private-owned`) when planning and again by
`--apply`. Its parent directory must also be owned by the current user with no
group or other access (`backup-root-private-owned`).

Schema version 2 adds an explicit `hostAuxiliaries` array for the closed host
jobs that are not owned by one member. It accepts only these label/mode pairs:
`com.bot-errors.health` with `path-rebase`;
`com.whatsoup.harness-maintenance` or `com.whatsoup.reply-guarantee` with
`setup-timer` or their closed legacy `path-rebase` form;
`com.whatsoup.whatsoup-fleet` with `fleet-wrapper`; and a declared member's
`com.whatsoup.<instance>-watchdog` with `quiesce`.
Planning gives each host auxiliary label the member auxiliary check above: one
that is another configured instance's primary label refuses
(`host-aux-not-instance:<label>`).
Selector-bearing entries name their reviewed `expectCurrent`; the fleet entry
also names its absolute wrapper link. The planner proves the installed and
loaded path, executable, and complete argument list agree before switching.
A staged host-auxiliary plist must carry its declared `Label`.
For a host `setup-timer`, its newly rendered complete `ProgramArguments` must
also equal the installed list after only exact `expectCurrent` path values are
rebased to the target release. An external guard or other argument the template
does not render is a drift refusal; this coordinator does not preserve or
reconstruct it.
It refuses an undeclared loaded `com.bot-errors.health` job, including when
its definition cannot be read reliably.

Schema version 3 adds a closed `outsideUnits` array for reviewed, unrelated
LaunchAgents that the transaction must prove are outside the host unit but must
never edit, reload, stop, or start. Each entry pins `label`, the installed
`plistSha256`, and either `loadState: "loaded"` or `"unloaded-113"`. Its
`reviewInputs` lists lexically ordered, normalized absolute `roots`, `links`,
and `{ path, sha256 }` source files, plus ordered
`argumentBindings: [{ index, path, kind }]`. The roots must exactly equal the
target release plus every declared `expectCurrent` (members and host
auxiliaries). The links must exactly equal the members' standard
`~/.local/bin/whatsoup` launcher path (listed once) plus every declared
host-auxiliary link, whether or not that standard launcher joins the
transaction.
Each source file must remain outside those paths both by spelling and after
symlink resolution; it is reread and rehashed from the same bytes during
planning and immediately before the first `--apply` filesystem or launchd
mutation. Every selected root and launcher must itself resolve, so an
unresolvable selected path is a refusal.

An outside label cannot be `com.whatsoup.*` or a closed host consumer such as
`com.bot-errors.health`. The pinned plist and every reviewed input must contain
no raw or XML-escaped reference to a selected root or launcher. A `loaded`
entry must have a matching plist label and exact installed/loaded path,
program, and argv. Planning reads a `loaded` entry's plist with the strict
plist reader described under `path-rebase` below; a plist it cannot read
exactly refuses (`installed loaded plist is unreadable: <reason>`), for
example one that spells a `PYTHON*` environment key with a numeric character
reference. The reader takes `Label`, `ProgramArguments`,
`EnvironmentVariables` and `WorkingDirectory` only from the root dictionary of
the plist; the same keys at any other depth do not count. A `ProgramArguments`
entry that is not a `<string>` refuses (`installed loaded plist is unreadable
or has a mismatched label`).

For an interpreter, every absolute argv value after argv[0]
must have one exact index-and-path binding: `review-file` must name a hashed
source input, and `runtime-data` explicitly declares a generated data path.
Runtime data is checked against selected roots and launchers by its lexical
path and nearest existing realpath ancestor; it cannot reuse a reviewed source
path. Every loaded interpreter needs at least one reviewed source input.
Shell `-c` and `-lc` forms remain opaque commands pinned
by the reviewed plist and still need a reviewed source input. The sole module
form is exact Python `[python, -m, dotted.package.module]`, with no other
argument. Its normalized absolute installed `WorkingDirectory` must be an
existing directory outside every selected root and launcher, must exactly match
the loaded working directory, and must have no `PYTHON*` variable in the plist
or the loaded inherited, default, or explicit environment. The reviewed files
must hash-bind the resulting `module.py` and every parent package
`__init__.py`; namespace packages and package-as-entry forms refuse. Other module
or option forms refuse. The reviewed declaration must classify any script,
environment, or other input that can affect release selection as `review-file`;
the bounded checker does not discover arbitrary dynamic dependencies. It does
not prove Python import hooks, `sitecustomize`, `.pth` files, native extensions,
or same-name package precedence; those remain separate transitive review
inputs. An `unloaded-113` entry is accepted only for a digest-pinned zero-byte
plist stub, which may use `files: []` and `argumentBindings: []`, and only if
the bounded `launchctl print gui/<uid>/<label>` check returns exactly exit 113.
Any other plist under `unloaded-113`, whatever its content, refuses before that
check (`unloaded-113 plist is not a zero-byte stub`): a non-empty plist left in
`~/Library/LaunchAgents` can load at the next login. This is a
review-bound exception, not general dependency discovery: any changed plist,
runtime definition, review input, root/link tuple, unreadable input, or new
consumer refuses the transaction and requires a new review declaration. Plan
output and the apply receipt retain `reviewTupleSha256`, over the normalized
label, plist digest, load state, roots, links, files, and argument bindings.

`path-rebase` admits exactly four closed contracts; planning refuses any other
plist declared in that mode:

- `com.bot-errors.health` as both BOT ERRORS installers write it
  (`deploy/scripts/install-bot-errors-health-launchd.sh` and
  `deploy/scripts/install-bot-errors-launchd.sh`): `/usr/bin/python3` runs the
  root's `deploy/scripts/bot-errors-runner.py`, and the runner forwards
  `/usr/bin/python3` with the root's
  `deploy/scripts/bot-errors-health-check.py --daily`. Host activation reads
  this argv with the runner grammar of single-member activation
  (`parseHealthRunnerSuffix` in `scripts/lib/release-activation/plan.ts`),
  including its fixed `--log-hint`
  (`<home>/.local/state/bot-errors/logs/health.err.log`, where `<home>` is the
  planning user's home folder) and `launchd_label=com.bot-errors.health`. The
  root the runner names must equal the declared `expectCurrent` byte for byte,
  so a case variant of the path refuses, and `WorkingDirectory` must equal
  that root;
- the closed legacy `com.bot-errors.health` shell wrapper;
- the closed legacy argv of `com.whatsoup.harness-maintenance`;
- the closed legacy argv of `com.whatsoup.reply-guarantee`.

The last three are described below.

In the installer form, host activation admits only `/usr/bin/python3`, at both
interpreter positions, and that file must also pass the interpreter check of
the shared grammar (`isTrustedHealthPython`). Single-member activation
(`release:activate`) still reads the loaded health job with that grammar
alone, so its interpreter needs only to pass `isTrustedHealthPython`. Any other
health-job shape, except a `/bin/bash -c` wrapper whose script starts with a
`BOT_ERRORS_ENV_FILE=` assignment other than the expected one (below), refuses
with a detail that names the two installers: a script
run directly, the short runner form, a `/bin/sh` or `/bin/bash` script, a
`bash -c` command, another interpreter (one inside the release, or another
trusted `python3` such as one set through `BOT_ERRORS_PYTHON`), a log hint from
a non-default `BOT_ERRORS_STATE_DIR`, or a `WorkingDirectory` other than the
root. Rerun either installer with `BOT_ERRORS_REPO_ROOT` set to the job's
current root and without `BOT_ERRORS_PYTHON`, `BOT_ERRORS_STATE_DIR` or
`BOT_ERRORS_HEALTH_LABEL`, then plan again. A timer outside its contract
refuses (`legacy host auxiliary does not match reviewed path-rebase
contract`): re-render it from the repository template and declare it in
`setup-timer` mode instead.

Planning reads every path-rebase plist with a strict reader
(`scripts/lib/release-activation/strict-plist.ts`). launchd reads plists
through CFPropertyList, which also accepts binary plists, other encodings,
numeric character references and CDATA, so the reader admits only UTF-8 XML
that starts at its first byte with an XML declaration or `<plist>`, holds
exactly one root `<dict>` inside `<plist version="1.0">`, has unique keys at
every level, and has `<string>` entries in `ProgramArguments` and `<string>`
environment values. A DOCTYPE is optional, and the only one admitted is
Apple's: `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
"http://www.apple.com/DTDs/PropertyList-1.0.dtd">`, or the older
`-//Apple Computer//DTD PLIST 1.0//EN` public identifier with the same system
identifier, in double quotes with any whitespace between the tokens. Both BOT
ERRORS installers write it on one line and the timer templates on two. Any
other DOCTYPE refuses: a quoted literal can hold `>` and a whole plist,
`plutil -p` reads a plist
written inside a `SYSTEM` literal as the document, and `plutil -lint` passes
those bytes, so this reader, not `plutil -lint`, refuses them. A comment
that starts with `<!---` refuses too (`plist holds a comment that starts with
<!---`). That narrows the form; it does not fix an observed difference:
`plutil -p` ended such a comment where this reader does, but a reader that
starts its search for `-->` at the opener's second dash ends `<!--->` at once
and reads what follows. No repository writer emits either form. Among other
forms, it refuses a binary plist, a byte-order mark, a declared encoding other
than UTF-8, a numeric character reference, a CDATA section, a DOCTYPE internal
subset or entity declaration, a processing instruction other than the XML
declaration, an entity, comment, other markup or surrounding whitespace in key
text, and markup inside a value. Other comments outside a key or value are
skipped, each ending at the first `-->` after its opener. The reader does not
prove that launchd reads the same dictionary from the bytes it admits.
Planning reports the reader's refusals, like the contract, key and path
refusals in this section, under `host-aux-plist-staged:<label>`.

The root keys may only be `Label`, `ProgramArguments`, `EnvironmentVariables`,
`WorkingDirectory`, `RunAtLoad`, `KeepAlive`, `StartCalendarInterval`,
`StartInterval`, `StandardOutPath` and `StandardErrorPath`. Any other key
refuses, and the detail names it under the key rule below (`plist root key
<key> is not admitted for a path-rebase job`): for example `Program`, which
launchd runs in place of
`ProgramArguments[0]`, whether or not it equals that argument and even while
the loaded definition still matches the installed argv; `BundleProgram`;
`UserName`; or `EnableGlobbing`. Environment key names are pinned per job to
the keys some committed version of that job's repository writer set; only the
path rules below read their values:

- the health job, in both forms: `PATH`, `BOT_ERRORS_STATE_DIR`,
  `BOT_ERRORS_JID`, `BOT_ERRORS_EXPECTED_JID`, `BOT_ERRORS_SOCKET_PATH`,
  `BOT_ERRORS_SOCKET`, `BOT_ERRORS_DB`, `BOT_ERRORS_HEALTH_PROFILE` and
  `BOT_ERRORS_DISPATCHER_SERVICE`;
- harness maintenance: `PATH`, `CLAUDE_CONFIG_DIR` and
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`;
- reply guarantee: `PATH` and `CLAUDE_CONFIG_DIR`.

Any other key refuses, naming it (`environment key <key> is not admitted for
<label>`): for example `BASH_ENV`, `SHELLOPTS`, `PS4`, `DYLD_INSERT_LIBRARIES`,
`__PYVENV_LAUNCHER__`, `HOME`, or a key from another job's list. Reinstall the
health job or re-render the timer in `setup-timer` mode, as for a shape
refusal. A health job re-pinned with `install-bot-errors-health-launchd.sh
--repin-existing --runtime-manifest` sets `BOT_ERRORS_RUNTIME_MANIFEST`, which
is not in its list, so reinstall such a job before host activation. Host
planning also refuses an environment-file wrapper job re-pinned to another
release, because re-pin leaves its profile default under the release it was
installed from; reinstall it too. A re-pin back to that release clears this
refusal. A detail
names a key only when the key matches
`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`. Any other key, one that holds a path for
example, prints as `(a name outside [A-Za-z_][A-Za-z0-9_.-]{0,63}, not shown)`,
so key text cannot carry a host path into plan output or the receipt. The same
rule covers the reader's duplicate-key detail (`plist has a duplicate key
<key>`), which the outside-unit refusal also prints, and its detail for an
environment value that is not a `<string>`.

`path-rebase` changes only plist string values that are exactly the reviewed
root or a path below it, and only when the value is a shell-token path matching
`^/[A-Za-z0-9._/-]+$`, because no value can be proven never to reach a shell.
The values are the strict reader's decoded strings, so text inside a comment is
not a value. Every shell-token value, whether or not it contains the root,
must also be in closed form: `path.posix.normalize` leaves it unchanged and it
has no trailing slash, so it has no empty, `.` or `..` segment. Otherwise it
names a path other than its spelling and refuses: `<root>/../x` leaves the
root, while `<root>.bak/../<name>/x` and `<parent>/./<name>/x` name it. A field
containing a prefix-sibling path such as `<root>2/x` is retained unchanged only
when its value is such a closed-form shell-token path. Any other value that
contains the root, including a command that starts with it, is an embedded
shell-style reference and refuses. The target release lands in every rewritten
value, so a release that is not a closed-form shell-token path refuses too. The
closed-form rule covers the shell-token string values of the three legacy
contracts as well, so a legacy plist with a trailing slash or a `.`, `..` or
empty segment in a shell-token path (in `WorkingDirectory` or a log path, for
example) refuses at planning where `bfc01318` admitted it; reinstall the health
job or re-render the timer from its template. A value outside the shell-token
grammar, such as a path with a space, is not checked for closed form; it
refuses only if it contains the root. `--apply` checks the staged bytes
against the
same contract, with the target release as the root, before its first write
(`recheck-staged-path-rebase:<label>`).

For these four contracts, planning proves that the plist is in the strict form
above, that its argv is exactly the contract's, that its root keys and
environment key names are in the closed sets, that every shell-token string
value is in closed form, and that the legacy wrapper sources the environment
file in the planning user's home folder. It does not prove:

- what the release's own scripts start later;
- the contents of files in the job user's home folder that a contract names
  or an interpreter reads: the legacy wrapper's environment file, the
  maintenance guard script and the pinned node binary (all three below), and
  Python's user-site `.pth` files (`/usr/bin/python3` runs without `-I` or
  `-s`);
- environment values, including `PATH` and the data paths
  `BOT_ERRORS_HEALTH_PROFILE`, `CLAUDE_CONFIG_DIR` and
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`; the last two choose the agent
  command-line tool's configuration and credential folders, whose settings
  can start commands;
- that no folder in a rewritten path is a symlink; the path rules compare
  strings.

The three named files are bound to the planning user's home folder: the
contracts fix the guard script's and the node binary's paths under `<home>`,
and the legacy wrapper must source `<home>/.config/whatsoup/bot-errors.env`.
Writing those files, or the folders of a rewritten path, takes the job user's
own access, which, like the other same-user writers this runbook names,
planning does not detect. Environment values are not bound to any folder.

The shared-wrapper consumer proof reads installed plists only. For each
selected shared wrapper, the plists in `~/Library/LaunchAgents` whose
`ProgramArguments[0]` is that link must be exactly the declared members'
primary plists that use it, and an unreadable installed plist refuses. For
the fleet wrapper's declared link they must be exactly that auxiliary's plist;
there an unreadable plist is not counted. Loaded
definitions are not read for this proof. The loaded-domain inventory keeps
only `com.whatsoup.*` labels and `com.bot-errors.health`, which planning
proves against their installed plists or refuses; a loaded job under any
other label, for
example one bootstrapped from a plist outside `~/Library/LaunchAgents`, can
use a selected wrapper without being detected. Planning's proof that an
undeclared job or a watchdog uses no release root
(`unowned-selector:<label>`, `host-watchdog-outside-unit:<label>`) reads XML
text, so a job whose plist hides a release path in a binary or encoded form
is not detected and keeps running what it ran before; writing such a plist
needs the same user's access.

A missing link is also outside the transaction, but
an unreadable path or a non-symlink is a preflight refusal rather than evidence
that no launcher exists. A declaration with `outsideUnits` cannot use the
missing-link case today: the review `links` must still list the standard link,
and every listed link must resolve, so a missing standard link, or one whose
target does not exist, refuses every outside unit (`selected root or launcher
unavailable`) and with it the plan. A standard link that resolves to an
existing undeclared root passes that check, but it stays in the outside units'
review tuple and their no-reference checks.

The only shell-style exception is the closed, legacy
`com.bot-errors.health` host wrapper: its exact reviewed argv and wrapper shape
may carry the default `BOT_ERRORS_HEALTH_PROFILE` at
`<expect-current>/deploy/health-profiles/<profile>.json`, where the file name
matches `^[a-z][a-z0-9]{0,31}\.json$`. The grammar only keeps the name inert in
the shell wrapper; which profiles exist is host inventory, not code. Planning
changes only that default to the target release, then applies the
ordinary embedded-reference refusal to every remaining value. A malformed
wrapper, non-canonical profile path, or any additional embedded release
reference refuses. The wrapper runs `source` on
`<home>/.config/whatsoup/bot-errors.env` under `set -a`, where `<home>` is the
planning user's home folder, and its log hint and `BOT_ERRORS_STATE_DIR`
default must name `<home>/.local/state/bot-errors`. A `/bin/bash -c` wrapper
whose script starts with `BOT_ERRORS_ENV_FILE=` but not with exactly
`BOT_ERRORS_ENV_FILE=<home>/.config/whatsoup/bot-errors.env; ` refuses
(`bot-errors health legacy wrapper does not source the BOT ERRORS environment
file in the job user's home folder`), whether it names another file or spells
this one another way, quoted for example; reinstall the health job with either
installer, as for a shape refusal. The sourced file is shell
code planning does not read, and the variables it sets reach the runner
without passing the environment-key allowlist, which reads only the plist.
Both selected release roots must also be normalized absolute
shell-token paths matching `^/[A-Za-z0-9._/-]+$`; whitespace or shell metacharacters
refuse rather than being interpolated into the wrapper.

The two legacy timer contracts pin the observed installed argv.
`com.whatsoup.harness-maintenance` must be exactly
`[/bin/bash, <home>/.local/libexec/fleet-reauth/maint-ccd-guard.sh, /bin/bash,
<expect-current>/deploy/scripts/harness-maintenance.sh]`.
`com.whatsoup.reply-guarantee` must be exactly
`[<home>/.nvm/versions/node/vX.Y.Z/bin/node,
<expect-current>/deploy/hooks/drain-stuck-replies.mjs]`, optionally followed by
the sole literal `--once`. The planner rebases only the exact selected-root path
and preserves every other installed plist byte, including launchd schedule
fields and the optional-argument form. A mismatched home, node shape, guard,
hook, extra argument, or embedded selected-root reference refuses. These are
closed installed-argv validators, not a general wrapper-preservation facility.

The guard script and the pinned node executable are transitive reviewed inputs.
This path-rebase check intentionally validates their literal installed paths and
does not read, hash, execute, or resolve their symlinks; the owner must qualify
those inputs separately before a native apply.

`--apply` takes the same activation lock as `release:activate`, so a held lock
refuses before any effect. It rebuilds that proof, snapshots every database
with `quick_check`, backs up all changed plists and each shared link, then
changes the group. Before the switch it makes the `release:activate` checks: a
root-owned plist that it writes needs the pinned root helper installed, each
member's candidate refresh rollback fence must be unchanged, a sealed BOT
ERRORS health consumer must be unchanged, and the live identity must still be
what the plan read. Unlike `release:activate`, it does not check each member
release's host-built required outputs again under its lock; planning refuses
while any is missing. The identity is every shared wrapper link and the fleet
wrapper link on its planned old release, and the digest of every plist the
plan read: the member and host auxiliary plists it writes, and the fleet
wrapper and watchdog plists it only reloads. The identity is checked before any
watchdog is stopped and again immediately before the switch. Any of these
stops the activation with no selector moved: it refuses, unless a stopped
watchdog cannot be restored (for example, its plist changed while it was
stopped, or its bootstrap or kickstart failed), which ends it
`rollback-unverified` (below). A later identity check
(`verify-live-identity`) compares a digest of each plist's text on disk with
the digest this activation expects: it can find a rewrite only while the
rewrite is still on disk, and it cannot show what launchd loaded. It reloads all primary
labels before auxiliaries and verifies each primary's new pid, argv,
authenticated commit and WhatsApp connection. Any failure checks the schema
level of every member before restoration and again after quiescing the group.
A change or unreadable schema blocks restoration for the whole host; no old
member is restarted. Each member's rollback target must also still provide the
candidate's refresh rollback fence, checked before the group is stopped and
again before restoration; otherwise the rollback stops with the new release
selected (`rollback-blocked-refresh-fence`). A root-helper run that did not
confirm plist protection makes the rollback `rollback-unverified`. One private
`receipt.json` in the host backup directory records the group outcome, written
only when this run created that directory. The directory is created
exclusively: a path that already exists, such as one an earlier run made in
the same second, refuses and keeps that run's receipt unchanged. A refusal
before the directory exists prints the outcome without writing a receipt. The
exit codes are those of `release:activate`: 0 activated, 1 rolled back,
2 refused, 3 rollback unverified, 4 rollback blocked by a migration and 5
rollback blocked by the refresh rollback fence. A receipt write that fails
prints `release:activate-host: receipt-write-failed <ERRNO>` with the errno
name only (never the path or the error text). As for `release:activate`, the
exit code is unchanged, because it reports the live activation, which a lost
receipt does not change.
Schema-v2 watchdogs are quiesced before selectors move. They are restored only
after the new terminal is verified, or after every old member, auxiliary, and
host selector is verified during rollback. A migration block or an unverified
old terminal leaves them stopped and reports the non-success rollback outcome.
A watchdog whose plist no longer has its planned digest at the checks before
its bootout and bootstrap is not restored: it stays stopped and the outcome is
`rollback-unverified`, also when no selector moved, unless a migration or
refresh-fence block already set a `rollback-blocked-*` outcome. A change found
before the watchdogs are stopped refuses instead.

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
only the fixed line `release:activate: report-failed` (nothing read from the
error: its message, and even its class name, can carry text), and the
already-fixed exit code is returned; a failing stderr is ignored. The CLI
attaches one `error` listener to stdout and to stderr before any write, so an
asynchronous stream error (EPIPE once the reader has gone) skips later writes
to that stream and never changes the exit code. Every binding exec (`launchctl print`, `ps -o command=`, `ps -o lstart=`)
runs after the outcome and exit code are final, is attempted once (a timeout
or failure is `unobserved`, never retried), has its own 5 s timeout and is
killed with SIGKILL. One sample serves both observations, and it is taken only
when an observation passed with a diagnostic body, so the bounded cost is at
most 15 s, and it delays only the receipt, the event and stdout. The
tool-commit lookup (at most 5 s) follows it. Every other `launchctl`, `ps`,
`plutil` and renderer call keeps its previous behaviour, with no timeout.
These bounds cover the bounded report execs, the tool-commit lookup and the
alert helper's timeout. Synchronous receipt I/O (the file write, its fsync
and the directory fsync) is outside them: a stalled fsync blocks the process,
so it delays the event and stdout without bound. The bounds also cover the
receipt, the event and stdout only, not process exit: a
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

**What the receipt holds.** `receipt.json` (mode 0600) is a local operator
record in the activation's mode-0700 directory under the private
`--backup-dir`. The activation record already carries
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
helper's 60 s timeout, plus any time the synchronous receipt writes and their
fsyncs take, which is not bounded; `receipt.json` already holds the verdict
during the helper wait.

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
  `${BASH_SOURCE[0]}` and IGNORES `WHATSOUP_REPO_ROOT`; exporting the variable
  does nothing for these two. `release:activate` re-renders them from inside the
  new release with its `setup-timer` renderer. `deploy/setup.sh` itself refuses
  to render them from a release the bot wrapper does not already run (see
  "`deploy/setup.sh` on a release host" above).

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

Before a rollback starts a release older than the one that introduced
`agentOptions.m365Bridge.workflowAuthority`, remove `workflowAuthority` from the
instance configuration. That release refuses the key, so the old binary would not
start. It also refuses an `m365Bridge` binding on provider `openai-api` or
`anthropic-api`: return such an instance to `claude-cli`, or remove the binding, first.

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
  host's paths filled in. For the wrapper, use the guarded block below, not
  the printed `ln -sfn` line.

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
```

Then repoint the wrapper to the old release, restore the plists and start every
label, as one block. It is one subshell that stops at the first failed check,
with or without `set -e`, and prints `stop: …`. It follows the same rule as the
relink under "Helper links after an activation":

- the activation lock is absent, because this writes the wrapper outside it;
- `<backup>/symlink.before` was read, and the target it names is absolute,
  normalized and an existing regular file. It is not compared with the current
  wrapper, which still names the new release;
- the temporary link does not exist in any form;
- it renames a new link over the wrapper with `mv -fh` only after `ln -s`
  succeeds, and never runs `rm` then `ln`. If the rename fails, it removes the
  temporary link only while it still points at the target, and stops;
- it reads the wrapper back. The plists are copied and the labels bootstrapped
  only after the wrapper names the old release.

```bash
# 4. Repoint the wrapper, then 5. restore the plists and start every label.
(
  fail() { echo "stop: $*" >&2; exit 1; }
  W="$HOME/.local/bin/whatsoup"
  T="$HOME/.local/bin/.whatsoup.relink"
  LOCK="$HOME/.local/state/whatsoup/release-activation.lock"
  if [ -e "$LOCK" ] || [ -L "$LOCK" ]; then fail "$LOCK exists; confirm no activation or reconcile runs (see above)"; fi
  old="$(cat <backup>/symlink.before)" || fail "could not read <backup>/symlink.before"
  case "$old" in
    */ | *//* | */./* | */. | */../* | */..) fail "the old target is not normalized: $old" ;;
    /*) ;;
    *) fail "the old target is not absolute: $old" ;;
  esac
  [ -f "$old" ] || fail "the old target is not an existing regular file: $old"
  if [ -e "$T" ] || [ -L "$T" ]; then fail "$T already exists; inspect it"; fi
  ln -s "$old" "$T" || fail "could not create $T"
  if ! mv -fh "$T" "$W"; then
    if [ "$(readlink "$T")" = "$old" ]; then rm "$T"; fi
    fail "could not rename $T over $W; the wrapper is unchanged"
  fi
  [ "$(readlink "$W")" = "$old" ] || fail "the wrapper does not name $old"
  for label in com.whatsoup.<instance> <each aux label>; do
    cp "<backup>/$label.plist" "$HOME/Library/LaunchAgents/$label.plist" || fail "could not restore $label.plist"
  done
  for label in com.whatsoup.<instance> <each aux label>; do
    launchctl bootstrap gui/"$(id -u)" "$HOME/Library/LaunchAgents/$label.plist" || fail "could not bootstrap $label"
  done
  echo restored
)
```

After `restored`, verify from the executing process as above. If the block stops
because the temporary link exists, inspect it with `readlink`. If it is a link
you made in an earlier attempt, remove it with `rm` and run the block again;
otherwise find out what made it first.

Never leave a `-wal` or `-shm` file from the migrated database beside the
restored `bot.db`.

The restore commands that `release:activate` prints still show `ln -sfn` for
the wrapper; use the block above instead.

#### Rollback blocked by refresh-fence compatibility (exit `5`)

`deploy/claude-refresh-rollback-fence.json` is a regular, manifest-sealed
release file. A release that requires `claudeRefreshOwnerV3` records that
requirement and the capability it provides. This is a compatibility fence for
automatic rollback, not evidence that a refresh child is live or dead.

An upgrade from a legacy release is allowed: the plan reports that automatic
rollback is unavailable if verification later fails. Before the live switch,
the activating release's exact manifest commit, sealed contract digest, and
requirement are read again. A changed, malformed or unsealed requirement
refuses before live selection changes.

After a failed verification, the rollback target is checked immediately before
stopping the new instance and again after that stop, immediately before any
symlink/plist restore or bootstrapping the old release. Both checks bind the
target's planned manifest commit, contract digest, and capability. If the
target is missing, malformed, unsealed, hash-mismatched, changed, or below the
candidate requirement, the operation exits `5` with
`rollback-blocked-refresh-fence`. A failure before the stop keeps the new
instance selected and running; a failure after the stop keeps the new release
selected but does not start the old release. The result records
`refreshFenceBlockedAt` as `before-instance-stop` or `after-instance-stop`.
It neither finds nor kills refresh children; follow the retained receipt and
the release recovery runbook for manual resolution.

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

`required-output-missing` on a freshly exported release is not tampering: the
host build step (the console under `dist/`) has not run yet. Run it as described
under Dry-Run Planning; `release:activate` refuses the release until then.

All other drift findings mean the release is no longer a faithful copy of reviewed source.
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

Exit codes: `target-differs` is advisory and exits 0; the `release-currency`
finding is still emitted and printed. Real integrity drift exits 1 when its
alert is published; an `inconclusive` observation, or an alert that could not
be published, exits 2. A host that only differs from the target therefore does
not read as a failed job.

The same schedule emits integrity findings under `release-drift` and currency
findings under `release-currency`. `--clear-on-ok` clears each source only from
its own successful observation. Installing or updating the rendered job remains
a separately approved live-host mutation.

On Linux, `deploy/scripts/whatsoup-release-drift-linux.sh` runs the same
observers from `whatsoup-release-drift.service`. Its target is HTTPS by
default: the same URL as the macOS renderer's default, with
`refs/heads/main`. `WHATSOUP_RELEASE_TARGET_URL` and
`WHATSOUP_RELEASE_TARGET_REF` in the unit's environment replace them. An SSH
URL needs a key the unit can use: one that needs no agent, or an agent the unit
reaches through `SSH_AUTH_SOCK`, which a systemd user unit does not have by
default. Otherwise every currency check is inconclusive and the unit exits 2.

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
