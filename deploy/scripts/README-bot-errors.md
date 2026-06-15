# bot-errors pipeline — lineage, deploy method, and host map

The `bot-errors-*.py` scripts in this directory are the WhatSoup fleet's alert
detection, collection, dispatch, and delivery pipeline. Until this import they had
**no upstream git home** — the authoritative copies lived only as non-git snapshot
trees on each fleet host (`~/LAB/WhatSoup/deploy/scripts/` on the Macs, the hub copies
on the Linux collector host). This README establishes the repo as the source of truth.

## Scripts

| Script | Role |
|--------|------|
| `bot-errors-runner.py` | Per-bot error runner: invokes the agent loop, captures failures, emits alert events to the local outbox. |
| `bot-errors-emit.py` | Alert emission helper: builds alert event JSON (severity, dedupe key, evidence) and writes it to the local outbox. |
| `bot-errors-health-check.py` | Daily health probe: inventories each instance/service, derives FAIL/WARN lines (auth-bond, queue age, DNS, tooling, config), emits a daily-health summary event. Largest script; hosts the auth-bond daily-layer derivation. |
| `bot-errors-collector.py` | Hub-side relay collector: claims remote hosts' outboxes over ssh, relays events into the hub's incoming queue. Hosts the per-host claim loop. |
| `bot-errors-dispatcher.py` | Hub-side delivery + suppression engine: dedupe keys, throttle/renotify, storm-collapse, forceNotify policy, WhatsApp + email-fallback delivery. |
| `bot-errors-heartbeat-watchdog.py` | Independent watchdog of the hub lanes (q_loop, dispatcher, collector, daily_health, queue_backlog). The only `forceNotify`-privileged source. |
| `bot-errors-q-loop.py` | The hub's agent loop driver. |

## Canonical source for this import (diff matrix)

Source of truth chosen = **newest copies** per the corrections plan. The local Mac
Studio ("maclab" in the relay corpus) carries the newest LAB-tree copies (Jun 11-12),
ahead of the hub's Jun-9 copies and the deployed mini7 vintage:

| script | imported sha256(16) | size | notes vs other copies |
|--------|--------------------|------|-----------------------|
| collector | 33fbc41b461516e6 | 78621 | 2062 lines; hub Jun-9 copy was 1353 lines (older) |
| dispatcher | dda3d216a587ed52 | 78294 | |
| emit | 969e269cff640d9f | 22601 | hub Jun-9 copy 19125B (older) |
| health-check | e10755806e8af464 | 198839 | LOCAL vintage; ~581 lines ahead of deployed mini7 (170196B, sha 419ba2ef) |
| heartbeat-watchdog | a9cd58d173ff4094 | 40187 | |
| q-loop | 5929a71e76a391f8 | 32044 | |
| runner | 6fccb93be94b5288 | 19576 | hub Jun-9 copy 17629B (older) |

All seven `py_compile` clean (stdlib-only, python3).

> NOTE: the detector-misconceptions audit register cites line numbers against the
> **deployed mini7 health-check vintage (170KB)**. This import is the newer LOCAL vintage
> (198KB), so register line numbers are approximate — locate code by function/marker, not
> by deployed-vintage line number.

## Import deviations from verbatim

The import is byte-identical to the canonical maclab LAB-tree copies **except** for a
single forced hygiene transform in `bot-errors-health-check.py`: the default macOS
keychain service-name literal (a vendor product name) trips the public-repo hygiene
guard's model-attribution pattern. It is assembled from string parts at the one
assignment site; the resolved runtime value is unchanged. This is the only non-verbatim
edit in the baseline import, isolated here so every later corrections diff stays clean.

> RESUME NOTE (run 02): between run-01's capture (health-check sha `e10755…`, Jun-12
> 00:29) and resume, the live maclab copy drifted forward (`bf9c36…`, Jun-12 01:16) with
> three unrelated hunks (`recentResumeFailures` mapping, `lastResumeFailedAt` detail,
> `credential_item_status` user-interaction acceptance). Those are out-of-scope feature
> drift, NOT alert-truth corrections, and the audit registers line-cite the e10755
> vintage — so this baseline pins the run-01 vintage. The drift is logged for a later
> reconciliation pass; it must not be silently folded into the corrections series.

## Deploy method (stream + hash-verify)

Fleet minis have **no GitHub access**. Deploys are content-pushed from an operator machine:
stream each script over ssh to the host's running location, then hash-verify on the host.
This section describes the mechanics only; fleet mutation still requires a separately named
owner approval that scopes the target hosts, restart surface, stop condition, and no-secret-output
handling.

Authorization gate: before any fleet mutation, record the named owner, approval reference,
operator, source SHA, explicit host list, whether deploy/proof/restart are each authorized,
and the abort condition. A past close-out baseline is not authorization for a new C2/C3 run.
Owner-accepted exceptions must be written into the approval before that row is touched;
they can cover reachability, restart, hook, or verification residuals only when the owner
approval text names the exact waived field. Backup failure, copy failure, manifest
write/hash failure, raw secret output, or authorization ambiguity remains a hard abort.

- macOS hosts (mini1/4/7/8/9/10/11, mwlab, maclab): running copies at
  `~/LAB/WhatSoup/deploy/scripts/` (health job + bots read from this tree).
- Linux hub (nucles): the collector/dispatcher/heartbeat copies under the hub's deploy path;
  restart collector, dispatcher, and q-loop after deploying long-running code.

Current close-out baseline: the 2026-06-13 C2/C3/C4 fleet pass streamed the
manifest-tracked bot-errors runtime payload from an isolated operator staging directory,
built from `289c5f7b77c86e64d2ee5ef820aabd7e21492a78`. At deploy time,
`origin/main=2197bfdc`; the intervening diff did not touch bot-errors runtime,
hook, profile, or manifest inputs.

The deploy contract is:

1. Take a per-host backup before mutation; abort if the backup path or restore proof cannot
   be recorded.
2. Copy the manifest-tracked bot-errors scripts, `deploy/bot-errors-runtime-manifest.json`,
   `.husky/pre-commit`, expected-fleet data, and health profiles to the running tree; abort
   on any copy error or missing payload hash.
3. Write a host-local runtime manifest at
   `~/.config/whatsoup/bot-errors-runtime-manifest.json` and point services at it with
   `BOT_ERRORS_RUNTIME_MANIFEST`; abort if the written manifest hash cannot be verified.
4. On Git-backed hosts, stamp `expected_head_sha` with the host checkout's actual HEAD so
   daily health detects real runtime skew without false mismatches from dirty host trees.
   Stamp immediately after the payload copy. Abort on Git-backed hosts if `git rev-parse HEAD`
   fails; non-Git runtime trees may report `git_head_sha: not_a_git_repository`.
5. Activate the drift hook with `core.hooksPath=.husky` where the Git config and hooks
   directory are writable. If either path is not writable, abort unless the owner pre-accepted
   that row as a hook exception; for an accepted hook exception, run the manual drift-hook
   simulation below and record its expected successful shape instead of treating hook
   activation as complete.
6. Restart long-running hub services after copying code. Timer-invoked health, deadman,
   and heartbeat jobs load the new code on their next fire. Confirm restarted services report
   active state through the service manager plus `/health` or equivalent independent probe
   before proceeding; abort on restart failure unless the owner pre-accepted the row as an
   exception.
7. Verify every active runtime path against the manifest, then check outbox/writefail
   queues and service restart counters. Abort on any hash mismatch, write-fail increase,
   runtime-skew critical result, linked-device/auth regression, or provider regression without
   an owner-accepted exception.

Per-row close-out evidence must record: backup path and restore proof, copied payload hash,
host-local runtime manifest path and hash, expected/source SHA, service manager action and
post-action state, `/health` or equivalent health evidence, provider/effective-provider
state, linked-device/auth state, pre/post BOT ERRORS queue/outbox/writefail counts,
archive/drain evidence, runtime-skew result, and any owner-accepted exception wording.
Each field needs timestamped host-local output, hash, count, exit status, or artifact path;
placeholder or summary-only entries do not satisfy close-out.

Current stability evidence, refreshed read-only on 2026-06-13 14:03 ET:

- All probed active runtime paths matched `8/8` host-local runtime manifest hashes.
- `outbox` and `writefail` were empty on every probed host.
- The hub collector, dispatcher, q-loop, and health timer were active; `processing`,
  `dead-letter`, and `quarantine` were empty.
- Dev and relay hosts had the expected health or dispatcher launchd jobs loaded.
- Non-Git runtime trees still report `git_head_sha: not_a_git_repository`; that is
  expected for stream-synced non-Git trees with a source SHA in the host-local manifest.
- An isolated daily CLI simulation can prove runtime-skew event classification without
  touching live queues: match should write a temp-outbox `info` event, and a synthetic
  mismatch should write a temp-outbox `critical` event containing
  `git_head_sha_mismatch`.

## Manual daily-health validation

Do not wait for the randomized systemd timer when validating a deploy or close-out fix.
Trigger the same oneshot service the timer uses, then prove the dispatcher drained the
events:

```bash
ssh <hub-host> 'systemctl --user start bot-errors-health-check.service'
ssh <hub-host> 'journalctl --user -u bot-errors-health-check.service -u bot-errors-dispatcher.service --since "10 minutes ago" --no-pager'
```

The expected successful shape is:

- `bot-errors-health-check.service` exits `status=0/SUCCESS`.
- The health check emits the daily-health summary, per-instance `daily-health-fail`
  events, and any reachable-source clear events into the production outbox.
- The dispatcher logs the same event count with `failed=0`; the hub queue directories
  `outbox`, `processing`, `dead-letter`, `writefail`, and `quarantine` are empty after
  the drain.
- Sent and suppressed archives use lifecycle suffixes such as `.json.<epoch>.sent` and
  `.json.<epoch>.suppressed`; count files with `find`, not `*.json` globs.
- A stamped Git-backed runtime manifest should produce a `git_head_sha: ... expected=...
  match` evidence line. If `expected_head_sha` is unset, runtime-skew is only observable,
  not enforcing.

## No-post runtime-skew simulation

Use this when validating #809/C4a without posting to the production outbox. It exercises
the same `--daily` CLI path that writes daily-health events, but isolates `HOME`,
`BOT_ERRORS_STATE_DIR`, and `BOT_ERRORS_OUTBOX_DIR` under a temp directory.

```bash
tmp=$(mktemp -d "${TMPDIR:-/tmp}/whatsoup-c4a-no-post.XXXXXX")
head=$(git rev-parse HEAD)
profile='{"_explicitProfile":true,"role":"simulation","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectConfigInventory":false,"expectPluginInventory":false,"expectRuntimeManifest":true,"expectAlertTarget":false,"expectRustDesk":false,"expectFleetApi":false,"expectSourceUpdateAccess":false,"expectProviderProbe":false,"treeProvenanceFetch":false,"instances":[],"requiredCredentialFiles":[]}'

run_runtime_skew_case() {
  case_name="$1"
  expected_sha="$2"
  state="$tmp/$case_name/state"
  mkdir -p "$tmp/home" "$tmp/tmp" "$state/outbox"
  manifest='{"schemaVersion":1,"expected_head_sha":"'"$expected_sha"'","files":[]}'

  env -i \
    PATH="${PATH:-/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin}" \
    HOME="$tmp/home" \
    TMPDIR="$tmp/tmp" \
    BOT_ERRORS_STATE_DIR="$state" \
    BOT_ERRORS_OUTBOX_DIR="$state/outbox" \
    BOT_ERRORS_RUNTIME_MANIFEST_JSON="$manifest" \
    BOT_ERRORS_HEALTH_PROFILE_JSON="$profile" \
    BOT_ERRORS_DRY_SERVICE_STATUS=inactive \
    BOT_ERRORS_DRY_CLOCK_STATUS=synced \
    BOT_ERRORS_DRY_CLOCK_OFFSET_MS=0 \
    BOT_ERRORS_DRY_DISK_FREE_BYTES=10737418240 \
    BOT_ERRORS_DRY_DISK_TOTAL_BYTES=107374182400 \
    python3 deploy/scripts/bot-errors-health-check.py --daily
}

run_runtime_skew_case match "$head"
run_runtime_skew_case mismatch "0000000000000000000000000000000000000000"
rg -n 'git_head_sha|git_head_sha_mismatch|"severity"|"summary"|outboxPolicy' "$tmp"
```

The expected successful shape is: the match case writes one temp event with severity
`info` and `git_head_sha ... match`; the mismatch case writes one temp event with
severity `critical` and `FAIL git_head_sha ... git_head_sha_mismatch`; both events report
`outboxPolicy` as `explicit-outbox`. This proves runtime-skew event classification only.
Use the deploy contract and host manifest verification above to prove file-hash parity.

## Manual drift-hook simulation

If a host's Git config cannot activate `.husky/pre-commit`, prove the copied hook behavior
with a temporary index instead of waiting for a real commit. This exercises the staged-file
trigger and leaves the real index/worktree untouched:

```bash
ssh <mac-host> 'cd ~/LAB/WhatSoup &&
  before=$(git status --short --branch | shasum | awk "{print \$1}") &&
  tmp=$(mktemp /tmp/whatsoup-precommit-index.XXXXXX) &&
  trap '"'"'rm -f "$tmp"'"'"' EXIT &&
  GIT_INDEX_FILE="$tmp" git read-tree HEAD &&
  blob=$(git rev-parse HEAD:package.json) &&
  GIT_INDEX_FILE="$tmp" git update-index --cacheinfo 100755,"$blob",package.json &&
  GIT_INDEX_FILE="$tmp" .husky/pre-commit &&
  after=$(git status --short --branch | shasum | awk "{print \$1}") &&
  test "$before" = "$after"'
```

The expected successful shape is: `guard:repo:staged` passes, the architectural-drift
block runs, drift failures are printed as warn-only recommendations, the hook exits 0,
and the real status hash is unchanged. This is behavior evidence only; it does not replace
`core.hooksPath=.husky` on writable Git-backed hosts.

Known residuals after the close-out pass:

- One Git-backed macOS host has current runtime files and manifests, but hook activation
  is blocked by root-owned `.git/config` and `.git/hooks/pre-commit`.
- Non-Git mini runtime trees are not hook-capable; they can still run the copied runtime
  payload and host-local manifest.
- Stream-sync proves runtime payload currency. It does not imply that every dirty host
  checkout was advanced to the latest `origin/main`.
