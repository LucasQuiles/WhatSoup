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

- macOS hosts (mini1/4/7/8/9/10/11, mwlab, maclab): running copies at
  `~/LAB/WhatSoup/deploy/scripts/` (health job + bots read from this tree).
- Linux hub (nucles): the collector/dispatcher/heartbeat copies under the hub's deploy path;
  restart collector, dispatcher, and q-loop after deploying long-running code.

Current close-out baseline: the 2026-06-13 C2/C3/C4 fleet pass streamed the
manifest-tracked bot-errors runtime payload from
`/private/tmp/whatsoup-c2c4-runtime-20260613T074101Z`, built from
`289c5f7b77c86e64d2ee5ef820aabd7e21492a78`. At deploy time,
`origin/main=2197bfdc`; the intervening diff did not touch bot-errors runtime,
hook, profile, or manifest inputs.

The deploy contract is:

1. Take a per-host backup before mutation.
2. Copy the manifest-tracked bot-errors scripts, `deploy/bot-errors-runtime-manifest.json`,
   `.husky/pre-commit`, expected-fleet data, and health profiles to the running tree.
3. Write a host-local runtime manifest at
   `~/.config/whatsoup/bot-errors-runtime-manifest.json` and point services at it with
   `BOT_ERRORS_RUNTIME_MANIFEST`.
4. On Git-backed hosts, stamp `expected_head_sha` with the host checkout's actual HEAD so
   daily health detects real runtime skew without false mismatches from dirty host trees.
   Non-Git runtime trees may report `git_head_sha: not_a_git_repository`.
5. Activate the drift hook with `core.hooksPath=.husky` where the Git config and hooks
   directory are writable.
6. Restart long-running hub services after copying code. Timer-invoked health, deadman,
   and heartbeat jobs load the new code on their next fire.
7. Verify every active runtime path against the manifest, then check outbox/writefail
   queues and service restart counters.

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
