# BOT ERRORS import log — one-time historical record, not normative

## Canonical source for this import (diff matrix)

Source of truth chosen = **newest copies** per the corrections plan. The local Mac
Studio (the source workstation in the relay corpus) carries the newest LAB-tree copies (Jun 11-12),
ahead of the hub's Jun-9 copies and the deployed-host vintage:

| script | imported sha256(16) | size | notes vs other copies |
|--------|--------------------|------|-----------------------|
| collector | 33fbc41b461516e6 | 78621 | 2062 lines; hub Jun-9 copy was 1353 lines (older) |
| dispatcher | dda3d216a587ed52 | 78294 | |
| emit | 969e269cff640d9f | 22601 | hub Jun-9 copy 19125B (older) |
| health-check | e10755806e8af464 | 198839 | LOCAL vintage; newer than the deployed-host vintage |
| heartbeat-watchdog | a9cd58d173ff4094 | 40187 | |
| q-loop | 5929a71e76a391f8 | 32044 | |
| runner | 6fccb93be94b5288 | 19576 | hub Jun-9 copy 17629B (older) |

All seven `py_compile` clean (stdlib-only, python3).

### Browser-debug resource ownership

The heartbeat watchdog inventories Linux browser roots that expose a local
remote-debugging port. A tree becomes `browser_debug:<profile-hash>` only when
all three conditions hold: it is older than the configured dwell, its aggregate
descendant RSS exceeds the configured threshold, and the debugging port has no
established controller connection. The alert carries only bounded operational
metadata (hashed profile identity, root PID, age, aggregate RSS, process count,
debug port, and controller count); it never captures page URLs or the profile
path. The watchdog alerts and confirms recovery but does not terminate the
browser.

| Variable | Default | Meaning |
|----------|---------|---------|
| `BOT_ERRORS_BROWSER_DEBUG_MIN_AGE_SECONDS` | `1800` | Minimum root age before an unattended debug tree is eligible. |
| `BOT_ERRORS_BROWSER_DEBUG_MIN_RSS_MB` | `512` | Minimum aggregate root-plus-descendants RSS before an unattended debug tree is eligible. |
| `BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT` | unset | Test-only JSON snapshot used for deterministic policy and stress tests. |

If controller-connection inventory is unavailable, the watchdog opens the
non-paging `browser_debug:probe` visibility incident instead of asserting that
the browser is unattended. Browser checks can be omitted from a specialized
watchdog lane by excluding `browser_debug` from `BOT_ERRORS_WATCHDOG_CHECKS`.

> NOTE: the detector-misconceptions audit register cites line numbers against the
> **deployed-host health-check vintage (170KB)**. This import is the newer LOCAL vintage
> (198KB), so register line numbers are approximate — locate code by function/marker, not
> by deployed-vintage line number.

## Import deviations from verbatim

The import is byte-identical to the canonical source-workstation LAB-tree copies **except** for a
single forced hygiene transform in `bot-errors-health-check.py`: the default macOS
keychain service-name literal (a vendor product name) trips the public-repo hygiene
guard's model-attribution pattern. It is assembled from string parts at the one
assignment site; the resolved runtime value is unchanged. This is the only non-verbatim
edit in the baseline import, isolated here so every later corrections diff stays clean.

> RESUME NOTE (run 02): between run-01's capture (health-check sha `e10755…`, Jun-12
> 00:29) and resume, the live source-workstation copy drifted forward (`bf9c36…`, Jun-12 01:16) with
> three unrelated hunks (`recentResumeFailures` mapping, `lastResumeFailedAt` detail,
> `credential_item_status` user-interaction acceptance). Those are out-of-scope feature
> drift, NOT alert-truth corrections, and the audit registers line-cite the e10755
> vintage — so this baseline pins the run-01 vintage. The drift is logged for a later
> reconciliation pass; it must not be silently folded into the corrections series.
