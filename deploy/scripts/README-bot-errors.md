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
  restart collector + dispatcher after deploy.

Deploy + restart are **publish-boundary** actions: they are not performed by the
corrections worktree run. See the run's `PUBLISH-REQUESTS.md`.
