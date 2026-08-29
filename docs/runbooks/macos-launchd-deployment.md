# macOS launchd Deployment

Operator reference for running a self-hosted WhatSoup install on macOS with
`launchd`. This runbook uses placeholders for instance names, keychain names,
ports, project IDs, index names, and local paths so each deployment owns its
environment details.

For deployments that also run Pinecone-backed knowledge search, local
transcription, or vector embedding, see
`docs/runbooks/pinecone-transcription-bridge.md`.

## Assumptions

- The live checkout is an operator-owned path such as `~/LAB/WhatSoup`.
- Each instance has a config directory at
  `~/.config/whatsoup/instances/<instance>/`.
- Secret stores or service managers are the source of truth. If a wrapper is
  used, it only projects required values into the runtime process environment;
  raw values are never stored in `config.json`, plist files, shell history, or
  tracked docs.
- Memory and search settings are canonical under `memory.pinecone`.

## Security Posture

This runbook describes deployment mechanics, not the end-state credential
model. Treat environment-projection wrappers and `tokens.env` health-token
files as compatibility paths that must remain private to the operator account.
Before promoting a deployment pattern, review:

- `docs/security-review-provider-permission-inheritance-2026-04-04.md`
- `docs/specs/2026-05-08-whatsoup-protection-layer-design.md`

Those documents define the stricter direction: per-instance/provider secret
scope, no inherited broad environment for child providers, mode-restricted
secret files, and posture checks that verify presence/absence without reading
secret values.

## Shell PATH

Interactive shells may not include Homebrew's bin path. Set it before running
Node commands manually:

```bash
export PATH=/opt/homebrew/bin:$PATH
```

Launch agent plists should set the same PATH in `EnvironmentVariables`. Generated
WhatSoup instance plists also set `TMPDIR` to a per-instance directory under
`$XDG_DATA_HOME/whatsoup/tmp/<name>/` so process temp files stay out of macOS
system-cleaned `/var/folders`.

### OpenCode PATH shadows

For an unattended OpenCode provider, validate the executable resolved by the
plist PATH, not the executable resolved by an interactive shell. A local shim is
part of the provider contract: it must preserve non-TTY stdin and stdout and
must not wrap `opencode run` in `script(1)`, redirect stdin from `/dev/null`, or
move the message back into argv. Those patterns can pass an interactive GUI
test while failing under launchd or SSH.

Profiles with `expectOpenCodeFunctionalProbe` enabled exercise the selected
binary with structural arguments only, write the fixed canary message to stdin,
and require terminal JSONL. A version/help pass without this functional result
is not proof that fallback turns work. When diagnosing drift, compare the plist
PATH, the loaded job PATH, and the exact resolved executable without printing
its arguments or any credential value.

## Runtime Node

WhatSoup's default wrappers derive the pinned runtime from `.nvmrc` and enforce
the compatibility range declared in `package.json#engines.node`. On macOS hosts
without nvm, set `WHATSOUP_NODE` in the fleet and instance launchd plists to a
Node binary within that range. When the fleet process has `WHATSOUP_NODE` set,
newly generated instance plists preserve it.

Current compatibility is `>=24.0.0 <26`; Node 24 and 25 are accepted, Node 26+
is rejected by the wrappers.

Operator maintenance is packaged for launchd: `deploy/setup.sh` installs the
`whatsoup-harness-maintenance` wrapper symlink (step 3) and renders the
`com.whatsoup.harness-maintenance` / `com.whatsoup.reply-guarantee` timer
plists into `~/Library/LaunchAgents` (step 4). Setup never loads the jobs —
load them as a deployment step and verify with `launchctl print`; see the
"macOS (launchd) Maintenance Timers" section of
[docs/runbook.md](../runbook.md#2-service-management) for the load, verify,
and uninstall (`deploy/setup.sh --remove-timers`) commands.

## Services

Use one plist per WhatSoup instance plus one optional fleet plist. Optional
embedding and bridge services can run as separate plists when a deployment uses
local vector embedding or scheduled Pinecone export.

| Plist pattern | Purpose | Typical port |
| --- | --- | --- |
| `com.whatsoup.<agent-instance>.plist` | Agent runtime | instance health port |
| `com.whatsoup.<passive-instance>.plist` | Passive capture/runtime instance | instance health port |
| `com.whatsoup.whatsoup-fleet.plist` | Fleet server, health polling, proxy routing, discovery | 9099 via argv (`whatsoup-fleet <port>`); no `FLEET_PORT` env var exists |
| `com.whatsoup.<embed-service>.plist` | Optional local embed service for vector profiles | service-owned |
| `com.whatsoup.<bridge>.plist` | Optional scheduled bridge that drains `fact_export_queue` when explicitly deployed | none |

The bridge row is a deployment pattern, not evidence that a bridge is installed.
Verify the concrete plist, wrapper, logs, and target Pinecone project before
claiming queued facts are exported.

Generated instance plists set `WorkingDirectory` to the checkout containing the
running WhatSoup code. This makes relative repository health inputs, including
`.arc/arc.toml`, deterministic. Regenerate the plist when changing checkouts;
do not hand-edit it to point at a different tree.

The launcher scrubs inherited credential environment variables (provider API
keys and `WHATSOUP_HEALTH_TOKEN`) before its first subprocess, so ambient
launchd/session values cannot shadow the launcher's own keyring/file
resolution (see `tests/deploy/whatsoup-launcher-credential-scrub.test.ts`).

Example wrapper chain:

```bash
~/.local/bin/with-pinecone-env \
  ~/.local/bin/with-openai-env \
    /opt/homebrew/bin/node /path/to/WhatSoup/src/bootstrap.ts <instance>
```

Current managed plists invoke `deploy/whatsoup <instance>` directly. That
launcher scrubs inherited provider and health-token variables before the first
subprocess, then re-resolves the subset that process-level features need from
the secure store and exports it into the runtime environment (Whisper's
`OPENAI_API_KEY`, `PINECONE_API_KEY` for `knowledge_search`, chat LLM keys on
`chat` instances, and the instance health token). The guarantee is provenance —
exported values come only from the secure store, never from the inherited
environment — not absence: the exported subset is visible in the runtime's
same-UID process environment, and rotation requires an instance restart.
Config credential selector names such as
`memory.pinecone.apiKeyEnv = "PINECONE_API_KEY"` therefore resolve against
launcher-provenanced values, never ambient ones.

## Instance Configs

Per-instance configs live in `~/.config/whatsoup/instances/<instance>/`.

- `config.json` - instance schema, access mode, health port, agent options,
  memory config, and `enabled`.
- `tokens.env` - per-instance health-token mirror retained for fleet
  discovery. It contains exactly one canonical
  `WHATSOUP_HEALTH_TOKEN=<64-lowercase-hex>` assignment. Keep it a regular
  non-symlink file, mode `0600`, owned by the instance operator, and outside
  tracked paths. The instance directory must also be real, operator-owned, and
  not group- or world-writable.
- `auth/` - Baileys session credentials.
- `stdout.log`, `stderr.log` - service output when the plist redirects logs.

Do not confuse per-instance `tokens.env` with the unscoped credential mirror at
`$XDG_CONFIG_HOME/whatsoup/credentials/<service>.key`. An unscoped lookup may
use its strict `.key` file before the OS Keychain; an account-scoped lookup never
uses that file. Managed health authorization resolves the scoped Keychain item
with service `whatsoup-health-token` and account `<instance>`; direct non-managed
launches may still use the documented environment compatibility fallback.

Remove plaintext `WHATSOUP_HEALTH_TOKEN` duplication and secret-injecting
wrappers from the plist in the same controlled cutover that installs the direct
launcher. Retain the canonical per-instance `tokens.env` file because fleet
discovery still consumes it. `deploy/check-health-token-keyring.sh
<instance>` compares the file with its scoped Keychain mirror without printing
either value. A passing check does not authorize removing `tokens.env` or the
scoped Keychain entry.

Instances with `enabled: false` are skipped by fleet discovery but keep their
config and auth state on disk.

## Generated Render Options and Governed-Env Drift

Generated instance plists render two config-owned environment surfaces from the
instance `config.json` `service` block (schema:
[docs/configuration.md](../configuration.md#service-launchd-render-options)):

- `service.claudeConfigDir` → `CLAUDE_CONFIG_DIR` in `EnvironmentVariables`,
  pointing the launchd service context at a dedicated claude-cli config root
  (e.g. `$HOME/.claude-<instance>`). The block governs only which config root
  the service resolves; credentials for that root stay keychain-resident and
  are neither created nor copied by rendering.
- `service.pathPrepend` → directories prepended, in order, ahead of the
  generating shell's ambient `PATH` in the rendered service `PATH` (e.g.
  `$HOME/.local/bin` so an opencode fallback binary resolves under launchd).

Every render path — the first install after pairing and
`reconcile-launchd-restart-policy` — resolves the block through the validated
resolver (`src/fleet/launchd-render-options.ts`) and fails closed on an
unreadable or invalid `config.json`. A missing `config.json` or absent block
renders the historical byte-identical plist.

### Checking governed-env drift

The dry-run reconciler compares the fresh render against the installed plist on
the governed keys (`CLAUDE_CONFIG_DIR`, `PATH`) by key and SHA-256 value digest.
Installed bot plists carry live credentials, so values are never printed:

```bash
npm run reconcile-launchd-restart-policy -- --instance <instance>
# governed env drift: PATH mismatch expected=sha256:… observed=sha256:…
# governed env drift: CLAUDE_CONFIG_DIR missing expected=sha256:… observed=absent
# governed env: no drift            ← all-clear
```

An installed `EnvironmentVariables` dict that exists but cannot be parsed is
reported fail-closed as drift, never as "no drift".
`scripts/check-launchd-drift.sh` keeps its separate structural-only checks for
bot plists; the governed-key comparison lives in the reconciler because only
the render path knows the expected values.

### Adopting a hand-patched PATH (or claude root) into config

For a host whose bot plist was hand-patched — for example `$HOME/.local/bin`
prepended to `PATH` so a fallback provider binary resolves, or a hand-added
`CLAUDE_CONFIG_DIR` — make the patch config-owned so the next regeneration
renders it instead of destroying it:

1. Add the equivalent `service` block to
   `~/.config/whatsoup/instances/<instance>/config.json`, using absolute paths
   (the block does not expand `~`):

   ```json
   "service": {
     "pathPrepend": ["/absolute/home-dir/.local/bin"]
   }
   ```

2. Dry-run and read the governed-env report. Expect `PATH mismatch` until the
   block reproduces the hand-patched intent; once it does, the *rendered* PATH
   is the hand-patched one:

   ```bash
   npm run reconcile-launchd-restart-policy -- --instance <instance>
   ```

3. Check the installed plist for non-governed hand-added keys (credential
   environment variables). Reconciling regenerates the whole plist, so
   anything not config-owned is destroyed. Move credentials to the keychain
   ([Route B](../configuration.md#enabling-provider-fallback-on-a-new-host))
   before applying.

4. Apply with the usual bounded transaction, then run the acceptance gate from
   [Generated-instance restart-policy migration](#generated-instance-restart-policy-migration):

   ```bash
   npm run reconcile-launchd-restart-policy -- --instance <instance> --apply
   ```

5. Re-run the dry-run: `governed env: no drift` confirms the hand-patch is now
   rendered output owned by config.

## BYOK Memory Migration

Memory and search settings are canonical under `memory` in `config.json`.
Legacy fields such as `pineconeIndex` and `pineconeAllowedIndexes` are still
read at runtime, but new writes should use `memory.pinecone`.

Safe migration procedure:

```bash
cd ~/LAB/WhatSoup
npm run migrate-memory-config -- --instance <instance>
npm run migrate-memory-config -- --instance <instance> --write
```

The first command is a dry run. The second rewrites only
`~/.config/whatsoup/instances/<instance>/config.json` and creates a
`config.json.bak-*` backup. It does not touch:

- `~/.config/whatsoup/instances/<instance>/auth/`
- `~/.config/whatsoup/instances/<instance>/tokens.env`
- `~/.local/share/whatsoup/instances/<instance>/bot.db`
- provider keychains or external secret stores

That means a successful config migration should not trigger WhatsApp QR re-auth
or provider credential rotation.

Recommended Pinecone guard shape:

```json
{
  "memory": {
    "pinecone": {
      "apiKeyEnv": "PINECONE_API_KEY",
      "projectId": "<pinecone-project-slug>",
      "expectedHostSuffix": "-<pinecone-project-slug>.svc.<environment>.pinecone.io",
      "index": "<memory-index>",
      "allowedIndexes": []
    }
  }
}
```

Keep `allowedIndexes` empty unless the agent should expose `knowledge_search`.
When enabled, prefer `agentOptions.sessionScope: "per_chat"` with
`agentOptions.sandboxPerChat: true`; otherwise explicitly set
`memory.pinecone.knowledgeSearch.allowGlobalAgentSessions: true` after reviewing
the blast radius.

## Data Paths

| Concept | Path |
| --- | --- |
| Per-instance SQLite DB | `~/.local/share/whatsoup/instances/<instance>/bot.db` |
| Fleet token file | `~/.config/whatsoup/fleet-tokens.json` (`active`) |
| Fleet logs | `~/.local/share/whatsoup/fleet-{stdout,stderr}.log` |
| Instance logs | `~/.config/whatsoup/instances/<instance>/{stdout,stderr}.log` |
| Optional bridge logs | deployment-owned path, usually under `~/.local/share/whatsoup/` |

Do not create `bot.db` at the repo root or inside `~/.config/whatsoup/`.
Those are wrong tiers. `.gitignore` covers `*.db` to prevent accidental commit.

## Restart Procedures

Restart fleet only:

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.whatsoup-fleet
tail -F ~/.local/share/whatsoup/fleet-stdout.log
```

Restart one instance:

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.<instance>
tail -F ~/.config/whatsoup/instances/<instance>/stdout.log
```

Expect credential-load or runtime health logs within a few seconds. For agent
instances, a restart interrupts in-flight turns.

### Plist changes and the keychain-session hazard

`launchctl kickstart -k` restarts a job with its **already-loaded** config. After
editing a plist on disk (e.g. repointing `ProgramArguments`/`WorkingDirectory` to a
new release directory) you must reload it with `bootout` + `bootstrap`:

```bash
launchctl bootout   gui/$(id -u)/com.whatsoup.<instance>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.<instance>.plist
```

`bootout` returning does not guarantee that launchd will immediately accept the
same label again. During teardown, `bootstrap` can transiently return error 5
(`Input/output error`) even when the plist is valid. Prefer the repository
reconciler for generated instance plists:

```bash
npm run reconcile-launchd-restart-policy -- --instance <instance> --apply
```

It retries only that transient bootstrap class for a bounded interval and
restores the previous plist/job if reload still fails. Other failures—including
authorization or a wrong launchd domain—remain terminal. For a manual reload,
wait and retry `bootstrap` without editing the plist again; confirm the exact
loaded label and a new PID before declaring success.

An SSH process may be able to inspect `gui/<uid>` while lacking permission to
switch into its audit session (`launchctl asuser` can return `Operation not
permitted`). Do not treat SSH reachability as proof of GUI-session mutation
authority. If direct reconciliation is denied, run the bounded transaction from
the already logged-in GUI user session or an approved session supervisor, then
verify the loaded environment and authenticated `/health` response separately.

Hazard: a `bootout`+`bootstrap` performed **over SSH** drops the job out of the
Aqua (GUI-login) keychain *session*. For an instance whose model uses the
`with-claude-oauth-keychain` wrapper, the wrapper's `security unlock-keychain` then
fails even with the correct password, so the bot starts but is **model-degraded**:
`/health` returns HTTP 200 with `status=degraded` and
`turn_capability.model_usable=false` (WhatsApp stays connected — Baileys auth is
file-based, not keychain). Always **finish a plist change with a
`kickstart -k`**, which restarts the job *within* the now-bootstrapped GUI domain
and re-joins the keychain session so the wrapper self-unlocks from its password
file:

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.<instance>
```

### Generated-instance restart-policy migration

Generated instance plists restart both nonzero application exits and
crash-associated signals with `KeepAlive={Crashed:true, SuccessfulExit:false}`
and use a 60-second `ThrottleInterval` to bound repeated failures. This matches
the systemd failure-restart contract while preserving launchd's crash-specific
coverage and avoiding a hot respawn loop. `KeepAlive` implies an initial launch,
so new instances intentionally install their plist only after the pairing helper
has saved credentials and exited successfully.

For one existing generated plist written by an older generator, first inspect
the exact target without changing it. The command verifies the instance label
and `ProgramArguments` structural identity before it will overwrite anything;
do not use it to take over a hand-managed plist that happens to match those
fields:

```bash
npm run reconcile-launchd-restart-policy -- --instance <instance>
```

Run it as the same GUI-login user that owns the instance plist; do not use
`sudo`. The command derives both `~/Library/LaunchAgents` and its `gui/<uid>`
target from the current user.

Then apply the one-instance reload:

```bash
npm run reconcile-launchd-restart-policy -- --instance <instance> --apply
```

`--apply` atomically replaces only a plist whose stable generated structural identity
matches that instance, then runs `bootout` on the named GUI-domain service
followed by `bootstrap` and `kickstart -k`. It therefore interrupts and
starts/restarts the named instance. The command is deliberately strict: if it
cannot boot out the existing service, or if `bootstrap` or `kickstart` fails,
it restores the prior plist and reports failure. It does not pre-probe whether
the job is loaded. Because it performs the same reload sequence, the preceding
SSH keychain-session hazard applies; run the acceptance check below after every
`--apply`. If a prior manual stop left the job unloaded, explicitly reload the
existing plist before retrying:

```bash
domain="gui/$(id -u)"
plist="$HOME/Library/LaunchAgents/com.whatsoup.<instance>.plist"
launchctl bootstrap "$domain" "$plist"
launchctl kickstart -k "$domain/com.whatsoup.<instance>"
```

Do not turn this per-instance command into a fleet-wide loop.

**Acceptance gate after any restart of a keychain-backed instance: confirm
`turn_capability.model_usable=true`, not just health HTTP 200** (which is true even
while degraded):

```bash
curl -s --fail-with-body http://127.0.0.1:<port>/health | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d["status"], d["turn_capability"]["model_usable"])'
```

If an instance is found model-degraded, run the bounded, fail-closed remediation
helper (it re-probes `/health` and, while degraded, issues `kickstart -k` up to a
bounded number of times, exiting non-zero to escalate if it cannot recover):

```bash
deploy/scripts/whatsoup-keychain-heal.sh --label com.whatsoup.<instance> --port <port>
```

Last-resort escalation if `whatsoup-keychain-heal.sh` exits 1 (still degraded): the
login keychain itself needs unlocking from the GUI session context — open a GUI
Terminal on the host (e.g. via RustDesk) and run
`security unlock-keychain ~/Library/Keychains/login.keychain-db`, then re-run the
heal helper. The wrapper sets `security set-keychain-settings` (no idle/sleep
relock) on each successful start, so once unlocked it should stay accessible while
the bot user is logged in.

## Health Signals

| Surface | Healthy signal | Where to check |
| --- | --- | --- |
| Fleet | `fleet scan complete`; expected instance count | fleet stdout log |
| Agent instance | runtime health stats | instance stdout log |
| Passive/chat instance | credential save or message-processing logs, no repeated auth errors | instance stdout log |
| Disabled instances | `fleet scan: skipping disabled instance` | fleet stdout log |

Fleet emits health-poller warnings when a polled instance is unreachable. If the
instance is intentionally offline, set `enabled: false` and bounce fleet.

`GET /health` includes `event_loop.discontinuity_count`, a saturating,
process-local count of monotonic scheduling gaps above 10 seconds. Such gaps
reset the retained lag window and are not themselves starvation samples.
Exactly 10 seconds remains a retained sample; local starvation still requires a
full window whose nearest-rank p95 is strictly greater than 250 ms.

For a release that changes loop-lag evidence, do not restore automated
supervision until all of these canary checks pass:

1. Measure the authenticated `/health` body and require fewer than 65,536 bytes.
2. Request `/health/event-loop-samples?after=0&limit=160` with the scoped token
   and require fewer than 32 KiB plus schema `health.event-loop-samples.v1`.
3. Rehearse one local collector capture using the private token-file path and a
   private output path; require a `run_completed` record and interpret any
   nonzero exit as incomplete evidence.
4. After restart, require a real served turn before interpreting whether local
   starvation cleared. Startup model usability and an idle health response do
   not reproduce the affected traffic condition.

See [Loop-Lag Forensic Collector](loop-lag-forensic-collector.md) for invocation,
retention, cursor gaps, and exit semantics.

## Worktree Discipline

- Run tests from the same checkout used by the plist unless deliberately
  validating a staging checkout.
- Keep generated artifacts under ignored `artifacts/` paths.
- Keep auth, token, DB, and keychain material outside the repo.

## Auto-Login Hosts Cannot Serve Keychain Reads

An auto-login host (`autoLoginUser` set, FileVault off) never unlocks the user's
login keychain: the unlock is derived from an interactively typed login password,
and `/etc/kcpassword` bypasses that step. The first keychain read after boot
therefore raises a `SecurityAgent` password prompt on the console — which nobody
is there to answer — and the caller blocks until the prompt is dismissed.

Symptoms, in the order they usually surface:

- `security` processes accumulate, all in `S` state, none exiting.
- A `SecurityAgent.bundle` process is running under the console user.
- Unrelated `security` calls from *other* users on the host also hang, because a
  pending console prompt serialises the authorization path.

Consequences for deployment:

- **Treat the keychain as unavailable on auto-login hosts.** Per-instance
  `tokens.env` is the supported credential path there; see
  `deploy/generate-health-tokens.sh`.
- **Every credential-store probe must be bounded** — see
  `deploy/lib/bounded-exec.sh`. Note `timeout(1)` does not exist on stock macOS,
  so a bare `timeout 3s security ...` is not a fix.
- Recovery without console access: kill the pending `SecurityAgent` and hung
  `security` processes, then
  `security unlock-keychain /Users/<user>/Library/Keychains/login.keychain-db`.
  This must be repeated after every boot, which is why the code path may not
  depend on it.

## Known Limits

- Generated instance plists use `KeepAlive -> {Crashed: true, SuccessfulExit:
  false}` + `ThrottleInterval 60` (#2682): any non-zero exit relaunches, with a
  60s floor between relaunches. A plist generated before that fix is
  `Crashed`-only — clean exits do not auto-restart until it is regenerated.
- WhatSoup does not migrate keychain entries. BYOK config selects environment
  variable names; wrappers or service managers remain responsible for exporting
  those variables.
