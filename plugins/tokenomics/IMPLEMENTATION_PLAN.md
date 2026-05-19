# Tokenomics v1 Implementation Plan (Thin Pilot)

**Goal:** Stop target bot's runaway token burn with the smallest set of changes that move the failure mode. The full design in `SPEC.md` is the v2+ archive; this plan implements only the seven behavioral levers that directly address the observed cause: context/tool/browser behavior. The eighth task is scaffold/manifest bookkeeping.

**Scope (v1, this plan):**

1. `ENABLE_TOOL_SEARCH=auto:5` propagation through WhatSoup's child env.
2. A minimal token-window helper reusing existing WhatSoup token-event infrastructure.
3. A local-only token watchdog with a **fixed manual ceiling**. No adaptive threshold, no rolling buckets, no forecasting.
4. Browser-loop strategy interrupt hook (with the correct top-level `hooks` wrapper).
5. Prompt composition + `instructionsPath` fail-closed-when-configured.
6. Playwright config fix (conditional: only if the host actually has `~/.config/playwright-mcp/config.json`).
7. Runbook stale-text fix.

**Out of v1 (deferred to v2 per `SPEC.md`):**

- L tokenomics doctor (cheap/full + TTL cache)
- M PostToolUse output cap
- H plugin-inheritance drift watchdog
- K full installer with hook-surface audit + rollback checkpoint framework
- Skills-disabled materialization
- Adaptive threshold + non-overlapping buckets (B6)
- Burn-rate forecasting (B7)
- Fleet launchd packaging beyond target bot

These remain in `SPEC.md` for future work.

**Execution agnostic:** This plan does not require any specific runner. Each task is self-contained TDD (failing test -> minimal code -> passing test). Suitable for a single engineer working sequentially, or a runner that dispatches one task at a time.

**Commit cadence:** The per-task `git add` / `git commit` snippets below are suggestions. The operator may batch commits or amend; treat the commit lines as optional unless explicitly directed otherwise.

**Recommended task order:** Start with **Task 2 or Task 3**, not Task 1. The scaffold task is low-risk bookkeeping; the real value lands when `child-env.ts` actually forwards `ENABLE_TOOL_SEARCH` and the token-window helper exists. Task 1 can run any time before Task 6 (when the plugin layout matters for hook registration).

**Working directory:** `<repo-root>` unless stated.

---

## Architecture validation philosophy

Tokenomics v1 is not a generic cost dashboard. It is a small deterministic control layer around target bot's agent child process. Every shipped lever must answer three questions:

1. **Measurement:** Did token pressure actually change?
2. **Enforcement:** Did the directive reach the process or hook surface that can enforce it?
3. **Failure detection:** If it did not work, where is the observable error?

**Primary measurement source:** WhatSoup's `agent_token_events` stream is the source of truth for v1. The `token-window` helper reads that database and exposes a stable JSON contract to tokenomics. `ccusage`, Claude `/usage`, `/context`, and OpenTelemetry are useful cross-checks, but they are not v1 runtime dependencies and must not drive watchdog decisions.

**Measurement accuracy rule:** A live or test measurement is trustworthy only when it can be reconciled at one boundary:

- Parser boundary: provider usage fields, including cache tokens when present, are mapped into `input_tokens` / `output_tokens`.
- Persistence boundary: the sum of `agent_token_events` for a session matches the session token totals.
- Window boundary: `token-window --window 5h` matches a direct SQLite sum over the same time range.

**Enforcement rule:** Configuration intent is not proof. v1 requires direct evidence at the enforcement point:

- `ENABLE_TOOL_SEARCH=auto:5` is valid only when it appears in the spawned agent child env, not merely in the parent launch service.
- `TOKENOMICS_CEILING` and cooldown are valid only when present in the rendered launchd plist and observed by a watchdog cycle.
- Browser-loop interruption is valid only when the `PreToolUse` hook returns the expected deny payload for the target MCP tool. `PostToolUse` cannot prevent execution and is v2-only here.
- Playwright behavior is valid only after the config file, when present, contains all three intended values.

**Impact rule:** Compare v1 to a baseline, not to intuition. Before live enablement, record at least one pre-change `token-window` sample and the current Playwright config state. After enablement, compare the same 5h token window, browser-loop denials, watchdog alerts, cooldown suppressions, and any usage-limit suppressions logged by WhatSoup.

**User-quality and performance rule:** Token reduction is not a win if it causes more retries, missed tools, lower answer quality, higher wall-clock latency, or extra operator noise. v1 is alert-only and observational except for the browser-loop `PreToolUse` interrupt. Any lever that saves tokens by making the agent less capable must be reverted, raised, or moved to v2.

**Performance impact gates:**

- Treat `ENABLE_TOOL_SEARCH=auto:5` as a candidate setting, not as assumed improvement. agent runtime documentation says tool search is on by default, and `auto:5` activates only when tool definitions exceed 5 percent of context; on smaller toolsets it may load tools upfront to reduce search round-trips. Deployment must therefore compare child env, 5h token pressure, and visible task behavior after the change instead of claiming benefit from env presence alone.
- The extra allowlisted output/context env vars must not synthesize conservative defaults. If `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`, or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` are present on target host, record their values in `DEPLOYMENT.md`; do not introduce new low caps during the pilot without an explicit rollback note.
- The token-window helper and watchdog must stay off the user path. A slow helper can delay watchdog telemetry, but it must never delay WhatsApp responses or agent turns. Live deployment records helper wall-clock time; anything over 2 seconds on target host is a performance defect to investigate before trusting 60-second launchd cadence.
- Prompt composition must avoid instruction-surface bloat. Task 5 may thread existing config instructions, but it must not add large tokenomics prose to the runtime prompt. Record composed prompt byte length in tests or deployment notes when practical, and treat unexpected growth as a regression.
- Browser-loop interruption must reduce loops without blocking legitimate browser work. The denial reason must tell the model how to recover with a different strategy; live deployment records denial count and any user-visible failed browser task. If denials correlate with incomplete user tasks, raise/disable the hook rather than preserving the threshold.
- Playwright `snapshot.mode=full` is a reliability tradeoff, not a pure token optimization. The fix is accepted only if a before/after smoke task still succeeds and does not introduce obvious output-size or latency blowups. For pages where visual context is needed, screenshots remain allowed explicitly; the fix must not remove legitimate visual inspection.
- The watchdog ceiling is not a throttle. It must never kill sessions, suppress messages, or alter provider behavior in v1. It emits telemetry and syslog alerts only.

**Research-backed decision matrix:**

- **Tool search:** Official agent runtime docs support tool search for large tool surfaces: tool definitions can consume 10-20K tokens for 50 tools, selection accuracy degrades past 30-50 loaded tools, and `auto:5` activates only when tool definitions exceed 5 percent of context. The same docs also say tool search adds one discovery round-trip and that loading everything upfront can be faster with fewer than about 10 tools. Decision: `ENABLE_TOOL_SEARCH=auto:5` is a measured candidate, not a default victory. Source: https://code.claude.com/docs/en/agent-sdk/tool-search.
- **Hooks:** Official agent runtime docs prove `PreToolUse` is the prevention surface because it runs before tool execution and can deny a tool call via `hookSpecificOutput.permissionDecision`; `PostToolUse` runs after a tool call succeeds. The docs also state synchronous hooks block execution until complete. Decision: browser-loop control stays `PreToolUse`, must remain local and bounded, and PostToolUse output cap remains v2 because it cannot prevent the expensive tool call. Source: https://code.claude.com/docs/en/hooks.
- **Telemetry:** Official agent runtime monitoring exposes `claude_code.token.usage` and cost usage metrics, but cost metrics are approximations and official billing belongs to the provider console. Decision: WhatSoup `agent_token_events` remains the v1 control input; agent telemetry and `/usage` are reconciliation aids only. Source: https://code.claude.com/docs/en/monitoring-usage.
- **Playwright:** Official Playwright MCP docs support accessibility snapshots as the default interaction substrate, with much lower token cost than screenshots, and also say vision/screenshots are needed for canvas, charts, maps, image editors, and custom widgets without accessibility coverage. Capabilities docs say fewer exposed tools lower token cost and reduce hallucinated tool calls. Decision: v1 may fix snapshot/config quality, but it must not remove screenshot/vision fallback when the task genuinely needs visual information. Sources: https://playwright.dev/mcp/snapshots, https://playwright.dev/mcp/vision-mode, https://playwright.dev/mcp/capabilities.
- **Instruction surface:** Research is mixed. One arXiv paper reports AGENTS.md can reduce median runtime and output tokens while preserving comparable completion behavior; another reports context files can reduce task success and increase inference cost when they add unnecessary requirements. Decision: Task 5 threads existing config instructions but must not add new tokenomics prose or broad requirements to the runtime prompt. Sources: https://arxiv.org/abs/2601.20404 and https://arxiv.org/abs/2602.11988.
- **Cost dynamics:** Recent agentic-coding research finds input tokens dominate cost, token use is highly variable, and higher token use does not reliably improve accuracy. Decision: the pilot optimizes input/context pressure but only accepts a lever after baseline comparison plus user-quality observation; one sample is evidence that measurement works, not proof of durable impact. Source: https://arxiv.org/abs/2604.22750.

**Adjustment rule:** If research or live evidence contradicts an assumed benefit, the plan follows the evidence. For v1 that means unsetting `ENABLE_TOOL_SEARCH`, raising/disabling the browser-loop threshold, restoring Playwright config, or leaving a lever as v2 backlog. The default response is never to add stricter caps.

**Failure model:** v1 must fail loud enough to debug but not create chat noise or corrupt state. Helper failures log to launchd stderr and skip alert/history writes. Hook infrastructure errors fail open. Missing child env propagation blocks deployment. Repeated budget alerts are suppressed by cooldown. Shared watchdog state is append-only or atomic-replace only; no v1 read-modify-write history truncation.

---

## Existing pieces to reuse (do NOT re-implement)

| File | Use |
|---|---|
| `src/runtimes/agent/session-db.ts` | Owns the `agent_token_events` table. The token-window helper reads via this module's existing query patterns; we add a new entry point, not new SQL. |
| `src/runtimes/agent/providers/budget.ts` | Existing budget-checking utilities. Read its types before writing the watchdog's input contract. |
| `src/core/metrics-collector.ts` | Hourly rollups. Confirm whether the helper can query `metrics_hourly` instead of raw events for cheaper aggregation. |
| `src/runtimes/agent/providers/child-env.ts` | The env-construction site for the spawned agent subprocess. F.8 extends its allowlist. |
| `scripts/audit-instance-plugin-coverage.ts` | Existing audit helper; v1 does not invoke it (drift watchdog deferred), but the design contract uses its shape. |

---

## Task list (8)

1. Plugin scaffold + manifest
2. F.8 - child-env allowlist extension (`ENABLE_TOOL_SEARCH` + a small set of token-related env vars)
3. F.3 - `scripts/token-window.ts` thin helper
4. F.7 - Runbook stale-text fix
5. F.2 + B5 - Prompt composition + fail-closed `instructionsPath`
6. D - Browser-loop strategy interrupt hook + `hooks.json` with top-level `hooks` wrapper
7. A (thin) - Token-budget watchdog with fixed manual ceiling + launchd plist (template rendered at install, not via shell expansion)
8. Conditional Playwright config fix

---

### Task 1: Plugin scaffold + manifest

**Files:**

- Create: `plugins/tokenomics/.claude-plugin/plugin.json`
- Create: `plugins/tokenomics/{hooks,lib,scripts,launchd,tests}/.gitkeep`
- Create: `plugins/tokenomics/tests/conftest.py`
- Test: `plugins/tokenomics/tests/test_manifest.py`

**Contract:**

`plugin.json` declares `name=tokenomics`, `version=0.1.0`, and `sourceRepo=LAB/WhatSoup/plugins/tokenomics`. The directory layout matches SPEC.md Section 2, with empty dirs for v1 components that ship and `.gitkeep` for the rest.

**Steps:**

- [ ] Write `tests/test_manifest.py` asserting the four required fields.
- [ ] Run it: `python3 -m pytest plugins/tokenomics/tests/test_manifest.py -v` (expect FAIL).
- [ ] Create the manifest + directory skeleton.
- [ ] Re-run pytest (expect PASS).
- [ ] Commit:

```bash
git add plugins/tokenomics/.claude-plugin plugins/tokenomics/hooks/.gitkeep plugins/tokenomics/lib/.gitkeep plugins/tokenomics/scripts/.gitkeep plugins/tokenomics/launchd/.gitkeep plugins/tokenomics/tests/conftest.py plugins/tokenomics/tests/test_manifest.py
git commit -m "tokenomics: scaffold plugin skeleton + manifest"
```

**conftest.py:**

```python
import pathlib, sys
PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT / "lib"))
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))
```

---

### Task 2: F.8 child-env allowlist extension (B2)

**Files:**

- Modify: `src/runtimes/agent/providers/child-env.ts` (the actual env-building site - confirm with `grep -n "child" src/runtimes/agent/providers/child-env.ts` before editing)
- Test: `tests/runtimes/agent/providers/child-env.test.ts`

**Contract:**

Extend the existing allowlist to pass through these env vars **when set in the parent**: `ENABLE_TOOL_SEARCH`, `TOKENOMICS_BOT`, `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. No synthesized defaults. Default behavior unchanged for hosts that don't set them.

**Note:** Playwright env vars are NOT in this allowlist; v1 Playwright fix is config-file only (Task 8).

**Steps:**

- [ ] Read the existing child-env builder to learn its allowlist shape.
- [ ] Write a test that constructs a parent env with all seven vars set and asserts each one appears in the child env (and that none appear when unset).
- [ ] Add an explicit regression assertion that no tokenomics env var is synthesized when unset and that unrelated secret-like vars are still stripped. This preserves the current child-env quality boundary.
- [ ] Add the seven entries to the existing allowlist set. Do not rewrite the existing surface.
- [ ] Run `npx vitest run --pool=forks tests/runtimes/agent/providers/child-env.test.ts` (expect PASS).
- [ ] Note that this is only the unit-level proof. The live deployment proof is runbook step 8: `ENABLE_TOOL_SEARCH` must be visible in the spawned agent process env.
- [ ] Commit:

```bash
git add src/runtimes/agent/providers/child-env.ts tests/runtimes/agent/providers/child-env.test.ts
git commit -m "child-env: F.8 allowlist passthrough for tokenomics env vars (B2)"
```

---

### Task 3: F.3 token-window helper

**Files:**

- Create: `scripts/token-window.ts`
- Modify: `package.json` (add `"token-window": "node --experimental-strip-types scripts/token-window.ts"` to `scripts`)
- Test: `tests/scripts/token-window.test.ts`

**Contract:**

CLI: `npm run token-window -- --instance <PATH> --window 5h --json`. Returns the v1 JSON shape from SPEC.md Section 3.A:

```json
{
  "instance": "target bot",
  "window_seconds": 18000,
  "total_tokens": 0,
  "input_tokens": 0,
  "output_tokens": 0,
  "event_count": 0,
  "sources": {"whatsoup_db": {"available": true, "earliest_ts": null, "latest_ts": null}}
}
```

`by_tool` and `estimated_cost_usd` are deliberately absent (v2). Exits non-zero if the instance directory or `bot.db` is missing.

**Implementation notes:**

- Use `node:sqlite` `DatabaseSync` with `readOnly: true` per repo pattern.
- Query: `SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COUNT(*), MIN(timestamp), MAX(timestamp) FROM agent_token_events WHERE timestamp >= unixepoch('now') - ?` with `windowSeconds` as the bind param. Column names match `session-db.ts`.
- Parse `--window <N>[smh]` strictly; reject other suffixes.

**Steps:**

- [ ] Write tests using `execFileSync` (no shell) with array args. Seed a temp `bot.db`, call the helper, assert shape.
- [ ] Include a reconciliation test: the helper's `input_tokens`, `output_tokens`, `total_tokens`, and `event_count` match a direct SQLite query over the same seeded rows/window.
- [ ] Include a cache-token fixture in that reconciliation test: mirror the existing parser fixture shape with `input_tokens=2000`, `cache_creation_input_tokens=1000`, and `cache_read_input_tokens=500`; persist the already-normalized event as `agent_token_events.input_tokens=3500`, assert the row contains `3500`, and assert the helper returns that `3500` exactly once. This guards against future helper double-counting if cache columns are added later.
- [ ] Include a lightweight performance guard: a seeded local database with at least 10,000 events returns the helper result in under 1 second on the development host. This is not a benchmark; it catches accidental table scans or per-row JavaScript aggregation.
- [ ] Run tests (expect FAIL).
- [ ] Implement `scripts/token-window.ts`. Add the `package.json` script entry.
- [ ] Re-run tests (expect PASS).
- [ ] Commit:

```bash
git add scripts/token-window.ts tests/scripts/token-window.test.ts package.json
git commit -m "token-window: F.3 thin helper for tokenomics watchdog"
```

---

### Task 4: F.7 runbook stale-text fix

**Files:**

- Modify: `docs/runbook.md` (the paragraph that still mentions Ctrl+C for stream-json stalled recovery)

**Contract:**

Replace the paragraph with the truth: stream-json stalled-recovery is a no-op; the hard active-turn watchdog at `src/runtimes/agent/session.ts:43` handles termination.

**Steps:**

- [ ] `grep -n "Ctrl+C" docs/runbook.md` and `grep -n "stalled" docs/runbook.md` to locate the line.
- [ ] Replace with: `For stream-json providers, stalled-recovery is a no-op. The hard watchdog at src/runtimes/agent/session.ts:43 handles termination after the configured active-turn budget.`
- [ ] Confirm no other stale Ctrl+C references remain.
- [ ] Commit:

```bash
git add docs/runbook.md
git commit -m "runbook: F.7 correct stream-json stalled-recovery language"
```

---

### Task 5: F.2 prompt composition + B5 fail-closed `instructionsPath`

**Files:**

- Create: `src/runtimes/agent/prompt-compose.ts` (pure function)
- Modify: `src/main.ts`, `src/runtimes/agent/runtime.ts`, `src/runtimes/agent/session.ts` (wire `configSystemPrompt` through and call `composeWithExactLineDedup` at the system-prompt build site)
- Test: `tests/runtimes/agent/prompt-compose.test.ts` (pure-function tests)
- Test: `tests/runtimes/agent/session-prompt-composition.test.ts` (integration: configSystemPrompt threading + B5 fail-closed)

**Contract:**

`composeWithExactLineDedup(sources: string[]): string` is pure: exact-line dedup only; empty/whitespace-only lines preserved verbatim. The session builds its system prompt by composing three sources in order: WhatSoup transport prelude, top-level `config.systemPrompt`, contents of `agentOptions.instructionsPath`.

**B5 policy:**

- `instructionsPath` **unset** -> source 3 omitted silently. Session boots.
- `instructionsPath` **set AND missing/unreadable** -> session refuses to start (throw with the path and the underlying error).
- `instructionsPath` **set AND readable** -> contents loaded.

Native agent runtime `CLAUDE.md` discovery is left intact (no manual append).

**Steps:**

- [ ] Write `prompt-compose.test.ts` covering: empty input, single source pass-through, ordered concat, exact-line dedup keeps first occurrence, empty lines preserved, whitespace-only never deduped, substring matches not collapsed.
- [ ] Run tests (expect FAIL: module missing).
- [ ] Create `prompt-compose.ts`. Run tests (expect PASS).
- [ ] Write `session-prompt-composition.test.ts` covering: configSystemPrompt threads end-to-end; identity line dedup across transport + configSystemPrompt; B5 fail-closed when `instructionsPath` is set but unreadable; unset `instructionsPath` boots silently.
- [ ] Add a prompt-size regression assertion for the no-extra-instructions case: measure byte length of the composed prompt string returned by `buildSystemPrompt()` or the pure composer, not tokenizer-counted tokens. Composing only the transport prelude should not grow materially beyond today's baseline. Do not add tokenomics prose to the runtime prompt.
- [ ] Run tests (expect FAIL).
- [ ] Thread `configSystemPrompt?: string` through `main.ts -> AgentRuntime -> SessionManager`. Extract a testable `buildSystemPrompt(): string` on `SessionManager` that composes the three sources and throws on configured-but-unreadable `instructionsPath` or empty composed prompt.
- [ ] Run tests (expect PASS).
- [ ] Commit:

```bash
git add src/runtimes/agent/prompt-compose.ts src/main.ts src/runtimes/agent/runtime.ts src/runtimes/agent/session.ts tests/runtimes/agent/prompt-compose.test.ts tests/runtimes/agent/session-prompt-composition.test.ts
git commit -m "agent: F.2 prompt composition + B5 fail-closed instructionsPath"
```

---

### Task 6: D browser-loop strategy interrupt + hooks.json (B1)

**Files:**

- Create: `plugins/tokenomics/hooks/browser-loop-interrupt.py`
- Create: `plugins/tokenomics/hooks/hooks.json`
- Test: `plugins/tokenomics/tests/test_browser_loop_interrupt.py`
- Test: `plugins/tokenomics/tests/test_hooks_schema.py`

**Contract:**

PreToolUse hook fires on `mcp__superpowers-chrome_chrome__use_browser`. Counts calls in a 60-second sliding window per agent session. At 8 calls, emits:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<bounded reason under 2000 chars>"
  }
}
```

and exits 0. Below threshold: exits 0 with no stdout.

**Fail-open** on any infrastructure error: parse fail, missing env, unwritable state, corrupt state. All errors go to stderr; exit 0; tool call proceeds.

**State:** `~/Library/Application Support/<bot>-tokenomics/browser-loop/<sha1[:16]>.jsonl` per session, sanitized via sha1 hash to prevent path-escape. Atomic write via tempfile + `os.replace`.

**hooks.json must use the top-level `hooks` wrapper** (B1):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__superpowers-chrome_chrome__use_browser",
        "hooks": [
          {
            "type": "command",
            "command": "TOKENOMICS_BOT=\"${TOKENOMICS_BOT:-target bot}\" python3 \"${CLAUDE_PLUGIN_ROOT}/hooks/browser-loop-interrupt.py\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The PostToolUse output-cap entry (M) is **not** registered in v1.

**Steps:**

- [ ] Write `test_hooks_schema.py` asserting: top-level `hooks` key present; PreToolUse matcher matches `mcp__superpowers-chrome_chrome__use_browser`; command string contains `TOKENOMICS_BOT` and `${CLAUDE_PLUGIN_ROOT}`; timeout is 5.
- [ ] Write `test_browser_loop_interrupt.py` covering: first call allows; seventh call allows; eighth in 60s denies with correct JSON shape; calls older than 60s do not count (seed state with stale ts); two sessions are isolated; path-like session_id is sanitized; empty stdin fails open; missing `TOKENOMICS_BOT` fails open.
- [ ] Assert the deny reason is recovery-oriented, not merely punitive: it should tell the model to stop repeating the same browser strategy and summarize/choose a different approach. This reduces user-visible task failure from blocked browser calls.
- [ ] Run both test files (expect FAIL).
- [ ] Implement the hook script and `hooks.json`. The hook bounds its `permissionDecisionReason` text to under 2000 chars without importing a heavyweight `bounded_output` module: a small inline truncation is sufficient for v1.
- [ ] Run tests (expect PASS).
- [ ] Commit:

```bash
git add plugins/tokenomics/hooks/browser-loop-interrupt.py plugins/tokenomics/hooks/hooks.json plugins/tokenomics/tests/test_browser_loop_interrupt.py plugins/tokenomics/tests/test_hooks_schema.py
git commit -m "tokenomics: browser-loop interrupt hook + hooks.json (B1 wrapper)"
```

---

### Task 7: A (thin) - token-budget watchdog with fixed ceiling + launchd plist

**Files:**

- Create: `plugins/tokenomics/scripts/token-budget-watchdog`
- Create: `plugins/tokenomics/launchd/com.tokenomics.token-budget-watchdog.plist.tmpl`
- Create: `plugins/tokenomics/scripts/render-plist.py` (small helper to render templates at install)
- Test: `plugins/tokenomics/tests/test_token_budget_watchdog.py`
- Test: `plugins/tokenomics/tests/test_render_plist.py`

**Contract:**

Watchdog script reads `TOKENOMICS_BOT`, `TOKENOMICS_INSTANCE_PATH`, `TOKENOMICS_CEILING`, `TOKENOMICS_ALERT_COOLDOWN_SECONDS` from env (set by the launchd plist). Behavior per cycle:

1. Invoke the WhatSoup token-window helper via subprocess. If exit non-zero or `sources.whatsoup_db.available != true`, log to stderr (captured by launchd) and exit 0. **No persisted STALL counter in v1** - launchd already records stderr.
2. Compute `pct = total_tokens / ceiling`. If `pct >= 0.75`, check the cooldown file `~/Library/Application Support/<bot>-tokenomics/last-alert.json`. If `now - last_alert_ts < TOKENOMICS_ALERT_COOLDOWN_SECONDS` (default `1800`, i.e. 30 min), suppress. Otherwise write a single-line alert to syslog via `syslog.LOG_WARNING` and update `last-alert.json` with `{ts}` via atomic tempfile + `os.replace`. **No notify.sh, no WhatsApp routing, no rich dedup state.**
3. Append one line to `~/Library/Application Support/<bot>-tokenomics/history.jsonl` with `{ts, window_sum, ceiling, pct}`. **Append-only.** No in-process truncation. The watchdog opens the file with `O_APPEND` and issues a single small write per cycle. Rotation is deferred to a future daily cleanup job, not v1.

**Why this is overlap-safe without an explicit lock:**

- `last-alert.json` is written via tempfile + `os.replace` (atomic on the same filesystem). If two cycles race, one wins; both can read the same prior value when checking cooldown, so the worst case is one extra syslog line  -  not corruption.
- `history.jsonl` uses `open(path, "a")` with `O_APPEND` and a single small write per cycle (under 200 bytes). On regular files this is not a POSIX guarantee (PIPE_BUF applies to pipes, not files); the per-cycle concurrency test in Task 7 is the actual proof that lines round-trip as valid JSON under simultaneous appends on the target filesystem. If the test fails on a future host, switch to advisory locking before alarming the design.
- No read-then-rewrite of shared state. The v1 design deliberately avoids truncation, ranking, or rolling-window stitching that would need a lock.

**Ceiling source:** environment variable `TOKENOMICS_CEILING`, set in the launchd plist at install time. Default `103000000` (103M tokens, the observed target bot rate-limit window) for the pilot. The operator may lower it for smoke testing or raise it once a clean baseline is observed. **No adaptive threshold, no rolling buckets, no forecasting** - those land in v2.

**launchd plist correction:** the v1 plist must NOT contain shell expansion like `<target-home>`. launchd does not run a shell. Templates use Python `string.Template` with `$USER` / `$BOT` / `$PLUGIN_ROOT` substitutions rendered at install time, producing absolute paths in the final plist.

Template:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.${BOT}.token-budget-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>${PLUGIN_ROOT}/scripts/token-budget-watchdog</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/${BOT}-tokenomics/budget-watchdog.out.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/${BOT}-tokenomics/budget-watchdog.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TOKENOMICS_BOT</key><string>${BOT}</string>
    <key>TOKENOMICS_INSTANCE_PATH</key><string>${INSTANCE_PATH}</string>
    <key>TOKENOMICS_CEILING</key><string>${CEILING}</string>
    <key>TOKENOMICS_ALERT_COOLDOWN_SECONDS</key><string>${COOLDOWN}</string>
    <key>WHATSOUP_REPO</key><string>${WHATSOUP_REPO}</string>
  </dict>
</dict>
</plist>
```

`render-plist.py` substitutes `$BOT`, `$PLUGIN_ROOT`, `$HOME`, `$INSTANCE_PATH`, `$CEILING`, `$WHATSOUP_REPO` from CLI args. No shell at runtime.

**Install (v1 manual):** the operator runs `render-plist.py` to produce a concrete plist, copies it to `~/Library/LaunchAgents/`, and `launchctl bootstrap gui/$(id -u)` it. No full installer framework in v1 - manual is fine for a 1-host pilot. The README captures the steps.

**Steps:**

- [ ] Write `test_render_plist.py` asserting: a rendered plist parses via `plistlib.loads`, has the correct `Label`, contains expected absolute paths (no `$` literals remain), and sets the four `EnvironmentVariables`.
- [ ] Write `test_token_budget_watchdog.py` covering: helper non-zero exit produces no alert and no history append; helper available=false produces no alert; below-ceiling cycle produces a history line but no syslog warning; above-ceiling cycle produces both; cooldown suppresses a second alert within the configured window; cooldown expiry allows a fresh alert; concurrent appends to history.jsonl do not corrupt lines (two threads, 50 lines each, every line round-trips as valid JSON).
- [ ] Assert the watchdog is alert-only: no code path sends WhatsApp messages, kills agent sessions, changes WhatSoup config, or writes anything outside its tokenomics state/log paths.
- [ ] Run tests (expect FAIL).
- [ ] Implement `render-plist.py` and the watchdog script. The watchdog uses a `notify_fn`/`syslog_fn` indirection to make the tests deterministic.
- [ ] Run tests (expect PASS).
- [ ] Commit:

```bash
git add plugins/tokenomics/scripts/token-budget-watchdog plugins/tokenomics/scripts/render-plist.py plugins/tokenomics/launchd/com.tokenomics.token-budget-watchdog.plist.tmpl plugins/tokenomics/tests/test_token_budget_watchdog.py plugins/tokenomics/tests/test_render_plist.py
git commit -m "tokenomics: thin v1 watchdog (fixed ceiling, syslog-only) + plist template"
```

---

### Task 8: Conditional Playwright config fix

**Files:**

- Create: `plugins/tokenomics/scripts/fix-playwright-config.py`
- Test: `plugins/tokenomics/tests/test_fix_playwright_config.py`

**Contract:**

Standalone script that:

1. Looks for `~/.config/playwright-mcp/config.json`. If absent, exits 0 with `{"changed": false, "reason": "no playwright-mcp config found"}` on stdout. **No-op on hosts that don't use Playwright MCP.**
2. If present, enforces all three intended values: `snapshot.mode = "full"`, `output.mode = "file"`, `console.level = "warning"`. If **any** of the three differ from the intended value, rewrites the file atomically (tempfile + `os.replace`) with all three set, preserving every other key. **Do not stop at the snapshot.mode check.**
3. If all three are already correct, exits 0 with `{"changed": false}`.

No env var modification in v1 (the child-env allowlist deliberately omits Playwright vars; the config file is the authoritative surface).

**Steps:**

- [ ] Write tests covering: no config file -> no-op; stale `snapshot.mode=incremental` alone -> all three rewritten; correct `snapshot.mode` but wrong `output.mode` -> all three rewritten; correct `snapshot.mode` but wrong `console.level` -> all three rewritten; all three already correct -> no-op; unrelated keys preserved across rewrites.
- [ ] Preserve operator escape hatch: if the file is absent, invalid JSON, or unwritable, the script must not create a replacement config or fail the whole deployment; it reports the condition and exits 0 for absent config, non-zero only for explicit write failure after deciding to change.
- [ ] Run tests (expect FAIL).
- [ ] Implement the script (atomic write via tempfile + `os.replace`).
- [ ] Run tests (expect PASS).
- [ ] Commit:

```bash
git add plugins/tokenomics/scripts/fix-playwright-config.py plugins/tokenomics/tests/test_fix_playwright_config.py
git commit -m "tokenomics: conditional Playwright config fix"
```

---

## Manual deployment runbook (v1, target bot)

After all eight tasks pass on the development host, deploy both the WhatSoup code changes and the plugin to target host:

1. Deploy the WhatSoup changes using the operator's normal target host update path. This must include Tasks 2, 3, 4, and 5 before any live validation can be trusted. Confirm the helper exists on target host:
   ```
   ssh target host 'cd <target-home>/LAB/WhatSoup && npm run --silent token-window -- --instance <target-home>/.config/whatsoup/instances/target bot --window 5h --json'
   ```
   Save the JSON output in the deployment notes as the pre-enable token baseline. Also record the helper wall-clock time with `/usr/bin/time -p`; if a single read-only helper call takes more than 2 seconds on target host, stop and investigate before enabling the 60-second watchdog cadence.
2. Sync the plugin (no tests, no cache):
   ```
   rsync -av --delete --exclude='tests' --exclude='__pycache__' plugins/tokenomics/ target host:<target-home>/.claude/plugins/tokenomics/
   ```
3. **Create log + state directories before any launchd bootstrap** (launchd does not reliably create parent dirs for `StandardOutPath` / `StandardErrorPath`):
   ```
   ssh target host mkdir -p <target-home>/Library/Logs/target bot-tokenomics
   ssh target host 'mkdir -p "<target-home>/Library/Application Support/target bot-tokenomics"'
   ```
4. Capture the pre-fix Playwright profile if present, then apply the conditional fix:
   ```
   ssh target host 'test ! -f <target-home>/.config/playwright-mcp/config.json || cat <target-home>/.config/playwright-mcp/config.json'
   ssh target host python3 <target-home>/.claude/plugins/tokenomics/scripts/fix-playwright-config.py
   ```
   Record the before/after result in `plugins/tokenomics/DEPLOYMENT.md`. If Playwright MCP is active, run one known-good browser smoke task before and after the change and record whether task success, tool-call count, or obvious output size/latency regressed.
5. Render the plist:
   ```
   ssh target host python3 <target-home>/.claude/plugins/tokenomics/scripts/render-plist.py \
     --bot target bot \
     --plugin-root <target-home>/.claude/plugins/tokenomics \
     --home <target-home> \
     --instance-path <target-home>/.config/whatsoup/instances/target bot \
     --ceiling 103000000 \
     --cooldown 1800 \
     --whatsoup-repo <target-home>/LAB/WhatSoup \
     --out <target-home>/Library/LaunchAgents/com.target bot.token-budget-watchdog.plist
   ```
6. Bootstrap launchd:
   ```
   ssh target host 'launchctl bootstrap gui/$(id -u) <target-home>/Library/LaunchAgents/com.target bot.token-budget-watchdog.plist'
   ```
7. Set `ENABLE_TOOL_SEARCH=auto:5` and `TOKENOMICS_BOT=target bot` in target host's WhatSoup service environment (the LaunchAgent or operator script that launches target bot  -  *not* the tokenomics watchdog plist). Restart the WhatSoup service so the F.8 allowlist actually forwards the value. Do not introduce new low output caps or simple-prompt/autocompact overrides during this pilot unless the operator explicitly records the value and rollback condition in `DEPLOYMENT.md`.
8. **Validate `ENABLE_TOOL_SEARCH` reaches the spawned agent child**, not just the parent:
   ```
   ssh target host 'ps -E -o pid,command | rg "claude" | head -5'
   ```
   For each agent subprocess pid:
   ```
   ssh target host 'ps eww -o command <pid> | tr " " "\n" | grep "^ENABLE_TOOL_SEARCH="'
   ```
   Expected: `ENABLE_TOOL_SEARCH=auto:5`. If absent, F.8 forwarding failed - investigate `src/runtimes/agent/providers/child-env.ts` before continuing. Do not paste full `ps eww` output into deployment notes; it can contain unrelated environment values.
9. Verify watchdog running:
   ```
   ssh target host 'launchctl list | grep token-budget-watchdog'
   ssh target host 'tail -f <target-home>/Library/Logs/target bot-tokenomics/budget-watchdog.out.log'
   ```
10. Smoke-test the alert path: temporarily lower `TOKENOMICS_CEILING` (re-render the plist with `--ceiling 10000000`, `launchctl bootout` + `bootstrap`), wait one cycle, observe a syslog warning, then a second cycle within 30 minutes is suppressed by cooldown. Restore the ceiling.
11. Capture a post-enable token-window sample after the watchdog and service restart have run. Compare it to the pre-enable baseline in `DEPLOYMENT.md`; do not claim impact from one sample, but do confirm the measurement path still works. Include a short operator-quality note: any failed browser task, missing tool access, slower-than-usual response, repeated retry loop, or user-visible answer degradation observed during the smoke window.

Record any deviations in `plugins/tokenomics/DEPLOYMENT.md` and commit them.

---

## Done criteria

v1 is complete when:

- [ ] All eight tasks' tests pass locally.
- [ ] Deployment runbook executed against target host without errors.
- [ ] Pre-enable baseline captured in `DEPLOYMENT.md`: token-window JSON, Playwright profile state if present, and whether the spawned agent child env had `ENABLE_TOOL_SEARCH` before the change.
- [ ] `token-window` output has been reconciled against a direct SQLite sum in tests, and one live target host sample returns `sources.whatsoup_db.available=true`.
- [ ] Live `token-window` helper wall-clock time on target host is recorded and is under 2 seconds for the 5h window.
- [ ] **`ENABLE_TOOL_SEARCH=auto:5` confirmed present in the spawned agent child env on target bot via `ps eww` (runbook step 8), not just the parent service env.**
- [ ] One observed cycle on target bot writes a history.jsonl line.
- [ ] Operator confirms the smoke-test alert reaches syslog.
- [ ] Smoke-test second cycle within cooldown is suppressed (no duplicate syslog warning).
- [ ] Deployment notes include a user-quality observation window: no new failed browser tasks, missing tool access, retry loops, response-latency regressions, or answer-quality regressions attributable to v1 controls. Any observed regression has an explicit rollback, threshold raise, or v2 deferral note.
- [ ] `git status` shows only intentional changes; no gitignored files force-added.
- [ ] `SPEC.md` and this plan are both ASCII-clean, tracked under `LAB/WhatSoup/plugins/tokenomics/`.

Anything in `SPEC.md` not implemented here is explicitly v2 backlog.
