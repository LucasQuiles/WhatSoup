# target bot Tokenomics Pilot - Design Specification

Date: 2026-05-19
Status: Locked design, ready for implementation
Scope: target bot pilot, designed for fleet portability
Primary host: target host / target user / target bot

## Summary

The target bot install hit its first agent session limit during the initial production run. The audit showed the dominant problem was not output volume or answer length. It was repeated input context: long agent sessions, browser tool loops, inherited plugin and skill surfaces, and instruction overhead being carried through every turn.

This design adds a `tokenomics` plugin and a small set of WhatSoup changes to observe, forecast, and interrupt token-heavy patterns without reducing answer quality. The pilot is conservative by default: no model downgrade, no prompt truncation, no session kill, no automatic MCP disable, and no automatic mutation of bot config when a threshold is crossed.

The design uses target bot as the first deployment target, but all artifacts are parameterized by bot name, instance path, and lab root so fleet bot, fleet bot, fleet bot, and other fleet bots can adopt the same package later.

### Architecture-Level Validation Philosophy

`IMPLEMENTATION_PLAN.md` is the thin v1 pilot plan. This `SPEC.md` remains the broader design archive for v2+ components. When the two documents differ, the implementation plan governs v1 behavior; this spec explains the larger architecture and backlog.

Tokenomics is evaluated as a control system, not as a prose guideline. Each shipped control has three required surfaces:

1. **Measurement surface:** the place where impact is counted.
2. **Enforcement surface:** the process, hook, env, config, or launchd boundary where the directive becomes active.
3. **Failure surface:** the log, return code, state file, or test assertion that makes non-enforcement visible.

For v1, WhatSoup's `agent_token_events` stream is the primary measurement source. The token-window helper is the only runtime contract tokenomics consumes. Claude `/usage`, `/context`, OpenTelemetry exports, and tools such as `ccusage` are secondary reconciliation aids; they are not authoritative watchdog inputs in v1.

Measurement accuracy is established by reconciling three boundaries:

- Provider usage parsing includes cache tokens when present and emits normalized input/output counts.
- Session totals match the sum of persisted token events for that session.
- A 5-hour token-window result matches the equivalent direct SQLite query over `agent_token_events`.

Enforcement is established only at the boundary that can actually apply the directive:

- Env directives are proven in the spawned agent child process, not merely in the parent service environment.
- launchd directives are proven in the rendered plist and by an observed watchdog cycle.
- Hook directives are proven by event-specific payload shape and behavior. A `PreToolUse` hook can prevent tool execution; a `PostToolUse` hook can only alter what Claude sees after execution and is not a prevention control.
- Config-file directives, such as the Playwright profile, are proven by the resulting file contents.

Impact is measured against a baseline. The target bot pilot should capture a pre-enable token-window sample, current Playwright profile, and current child-env state, then compare post-enable 5-hour token totals, browser-loop denials, watchdog alerts, cooldown suppressions, and provider usage-limit suppressions.

Efficiency is subordinate to user quality. A lower token count is not successful if it causes missing tools, extra retries, slower useful responses, blocked legitimate browser work, incomplete answers, or additional operator noise. v1 controls are alert-only except for the targeted browser-loop `PreToolUse` interrupt. Any v1 lever that saves tokens by making target bot less capable must be reverted, relaxed, or deferred to v2.

External research is treated as a decision input, not as proof that a lever works on target bot. Official agent runtime docs support tool search for large tool surfaces but also state it adds an initial discovery round-trip and can be slower than upfront loading for small toolsets. Claude hook docs support `PreToolUse` as the prevention surface and `PostToolUse` as after-the-fact context. Playwright MCP docs support snapshots for token-efficient interaction while preserving screenshots/vision for visual tasks. Agent-instruction research is mixed, so v1 avoids adding new broad prompt requirements. Live enforcement proof and user-quality observation govern deployment.

Failure handling must be debuggable without creating WhatsApp noise. Helper failures log and skip alert/history writes. Hook infrastructure failures fail open. Missing child-env propagation blocks deployment. Budget alerts are cooldown-limited. v1 shared state uses append-only writes or atomic replacement only; stateful locking, rotation, forecasts, and adaptive thresholds belong to v2 unless a v1 task explicitly says otherwise.

## Section 1 - Scope And Boundaries

### In Scope

1. A rolling 5-hour token-budget watchdog, alert-only, defaulting to 75 percent of the current adaptive threshold.
2. Burn-rate forecasting that estimates minutes to 75 percent and 100 percent of the current threshold.
3. A per-instance plugin profile using `agentOptions.enabledPlugins`.
4. A per-bot disabled-skills profile materialized as `~/.claude/skills-disabled/<skill-name>` touch files.
5. A browser-loop strategy interrupt after repeated `use_browser` calls in a short window.
6. Hook-message compaction that preserves every allow, confirm, and block decision while reducing repeated prose.
7. agent CLI tool-surface controls exposed through config, default no-op.
8. Prompt composition wiring: WhatSoup transport prelude plus top-level `systemPrompt` plus `instructionsPath`, with exact-line dedup. Native agent runtime discovery of `CLAUDE.md` remains intact.
9. A WhatSoup-owned token-window helper as the data contract between WhatSoup and tokenomics.
10. Instruction-surface bloat gates for `MEMORY.md`, `CLAUDE.md`, and `instructionsPath`.
11. A runbook correction for the stale Ctrl+C recovery text. Stream-json stalled recovery is a no-op; the hard watchdog handles hard stops.
12. A tokenomics doctor preflight that audits hooks, Playwright config, tool-search env, search toolchain, instruction surface sizes, MCP count, browser plugin type, plugin allowlist explicitness, skill-disable count, and the inventory of relevant agent runtime env caps.
13. A PostToolUse output-cap interception lane (default-off, opt-in) that caps oversized tool outputs and spills full content to a local cache without entering context.
14. A Playwright environment profile correction that replaces the stale `incremental` snapshot mode with `full`, and sets `output-mode=file` and `console-level=warning`.
15. An installer baseline check that requires `rg` on `PATH`.
16. A plugin manifest at `tokenomics/.claude-plugin/plugin.json` declaring `name`, `version`, and `sourceRepo`.
17. A per-bot overlap lock (`watchdog.runlock`) shared by A and H to prevent concurrent-cycle state corruption.

### Out Of Scope

1. Auto-compaction. Already landed locally and on target host.
2. Explicit conversation-model propagation. Already landed locally and on target host.
3. Routing simple turns to Haiku or any other model downgrade. Excluded because quality is the priority.
4. Aggressive context truncation. Excluded because it can remove useful working state.
5. `--resume` / `--continue` audit. Deferred to v2.
6. Per-tool attribution schema migration. Deferred to v2.
7. Pricing constants and estimated cost output. Deferred to v2.
8. `ccusage` cross-checking. Interface prepared in v1, implementation deferred to v2.
9. `/context` as a runtime source. It is only a manual validation step because it has no stable JSON contract.

### Quality Boundary

The pilot may alert, log, forecast, and request a strategy change. It must not silently reduce model quality or remove tool access. The only synchronous intervention is the browser-loop strategy interrupt, and that hook fails open on infrastructure errors.

## Section 2 - Components

### Tokenomics Plugin

The new plugin lives at:

```text
~/.claude/plugins/tokenomics/
```

It contains:

```text
.claude-plugin/
  plugin.json
hooks/
  hooks.json
  browser-loop-interrupt.py
  posttooluse-output-cap.py
scripts/
  token-budget-watchdog
  plugin-drift-watchdog
  context-overhead-report
  tokenomics-doctor
  install-tokenomics
launchd/
  com.<bot>.token-budget-watchdog.plist
  com.<bot>.plugin-drift-watchdog.plist
  com.<bot>.tokenomics-browser-state-clean.plist
lib/
  bounded_output.py
  context_overhead.py
  overlap_lock.py
tests/
```

The plugin owns components A, B, D, E, G, H, I, K, L, and M:

- A: token-budget watchdog
- B: launchd plist templates
- D: browser-loop strategy interrupt
- E: bounded-output formatters
- G: per-bot state layout
- H: plugin-inheritance drift watchdog
- I: context-overhead wrapper
- K: fail-closed installer and hook-surface audit
- L: tokenomics doctor preflight and runtime diagnostic
- M: PostToolUse output-cap interception lane (default-off)

### Outside The Plugin

Component C is per-instance config:

- `agentOptions.enabledPlugins`
- `agentOptions.tokenomics`
- `disabled-skills.json`

Component F is a WhatSoup patch set:

- agent CLI argv forwarding
- Prompt composition wiring
- `scripts/token-window.ts` and npm script
- runbook doc fix

Component J is workflow-only:

- `instruction-hierarchy-maintenance`
- `session-distill`
- manual `/context` validation

## Section 3 - Data Flow And Interfaces

### A. Token Watchdog Cycle

launchd starts `tokenomics/scripts/token-budget-watchdog` every 60 seconds. The watchdog does not query WhatSoup's SQLite schema directly. It calls a WhatSoup-owned helper:

```bash
npm run token-window -- --instance <INSTANCE_PATH> --window 5h --json
```

The helper returns:

```json
{
  "instance": "target bot",
  "window_seconds": 18000,
  "total_tokens": 48150000,
  "input_tokens": 47300000,
  "output_tokens": 850000,
  "event_count": 2847,
  "sources": {
    "whatsoup_db": {
      "available": true,
      "earliest_ts": 1747700000,
      "latest_ts": 1747710000
    }
  }
}
```

V1 intentionally omits `by_tool` and `estimated_cost_usd`. Those fields are v2 extensions and must not be required by the watchdog.

If the helper exits non-zero, or if `sources.whatsoup_db.available` is false, the watchdog increments persisted STALL state and skips the budget alert path.

### Threshold State

Adaptive threshold state is private to tokenomics:

```text
~/Library/Application Support/<bot>-tokenomics/threshold.json
```

The initial target bot bootstrap value is `103000000` tokens, based on the first observed rate-limit window. The absolute floor is `40000000`.

Threshold calculation:

```text
if rolling_history.length < 7:
  threshold = max(mean(rolling_history), 103000000, 40000000)
else:
  threshold = max(mean(last_7_windows), 40000000)
```

If `agentOptions.tokenomics.manualCeiling` is set, it overrides the adaptive threshold. Learned runtime state stays in `threshold.json`; bot config holds operator intent, not learned values.

### Cycle Record

Every successful cycle appends to `history.jsonl`:

```json
{
  "ts": 1747700000,
  "window_sum": 47300000,
  "threshold": 103000000,
  "pct": 0.459,
  "burn_rate_tokens_per_min": 158000,
  "projected_minutes_to_75_pct": 192,
  "projected_minutes_to_100_pct": 350,
  "overhead": {
    "available": true,
    "static_overhead_tokens": 12345,
    "source": "~/.claude/context_overhead.py",
    "breakdown": []
  }
}
```

Burn rate uses linear regression over the last `N` cycle records, default `N=5`. Forecasting is skipped if there are fewer than 3 records or if the sampled records cross a 5-hour boundary reset.

Budget alert:

- Fires when `pct >= agentOptions.tokenomics.alertPct`.
- Default alert percent is `0.75`.
- Default cooldown is `1800` seconds.

Forecast alert:

- Fires when `projected_minutes_to_75_pct <= forecastWindowMinutes`.
- Default forecast window is `30` minutes.
- Default forecast cooldown is `1800` seconds.
- Uses a distinct alert signature from the budget alert.

### Config Shape

```json
{
  "agentOptions": {
    "tokenomics": {
      "notifyVia": "local",
      "alertPct": 0.75,
      "cooldownSeconds": 1800,
      "forecastWindowMinutes": 30,
      "forecastCooldownSeconds": 1800,
      "manualCeiling": null,
      "toolSearchThreshold": "auto:5",
      "instructionSurfaceBudget": {
        "memoryMdMaxBytes": 24576,
        "claudeMdMaxBytes": 16384,
        "instructionsPathMaxBytes": 32768
      },
      "playwrightProfile": {
        "snapshotMode": "full",
        "outputMode": "file",
        "consoleLevel": "warning",
        "imageResponses": "default"
      },
      "outputCap": {
        "enabled": false,
        "capBytes": 10240,
        "dedupRepeatedLines": true,
        "cacheRetentionHours": 24
      },
      "doctor": {
        "blockInstallOnRedFindings": true,
        "warnInCycleOnYellow": true
      }
    }
  }
}
```

`notifyVia` allowed values:

- `local`: syslog plus JSONL only. This is the v1 default.
- `whatsapp`: call `~/LAB/lib/notify.sh`, then fall back to syslog.

`toolSearchThreshold` allowed values:

- `auto`
- `auto:N`
- `off`

The installer writes `ENABLE_TOOL_SEARCH` into the relevant launchd environment. The target value for the pilot is:

```xml
<key>ENABLE_TOOL_SEARCH</key>
<string>auto:5</string>
```

This must be verified in live testing because the variable only helps if it is inherited by the WhatSoup-spawned agent subprocess. If it is not inherited, the install target moves to the WhatSoup service environment.

### D. Browser-Loop Strategy Interrupt

The browser guard is a strategy interrupt, not a permanent block. It fires on 8 `mcp__superpowers-chrome_chrome__use_browser` calls in a 60-second sliding window, scoped by agent session.

`tokenomics/hooks/hooks.json` (the top-level wrapper key `hooks` is required by the agent runtime plugin hook schema; see `LAB/ClaudeHooks/scripts/validate-plugin-hooks-schema.py` for the validator):

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
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "TOKENOMICS_BOT=\"${TOKENOMICS_BOT:-target bot}\" python3 \"${CLAUDE_PLUGIN_ROOT}/hooks/posttooluse-output-cap.py\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The PostToolUse entry belongs to component M and is registered but inert when `agentOptions.tokenomics.outputCap.enabled` is `false` (the v1 default).

State file:

```text
~/Library/Application Support/<bot>-tokenomics/browser-loop/<sha1_session_id[:16]>.jsonl
```

Allow path:

- Exit 0.
- No stdout JSON.

Deny path:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "8 browser calls in 60 seconds. Pause and state a new strategy before continuing. Options: API call, captured file read, script, raw CDP, or one user gesture."
  }
}
```

The reason should also tell the agent to inspect auto-captured `.md`, `.html`, screenshot, and console artifacts before requesting another extraction when those files exist.

Failure policy:

- stdin parse failure: fail open
- `TOKENOMICS_BOT` unset: fail open
- state directory or file error: fail open
- corrupt state file: reset local state and continue
- formatter import failure: fail open
- unhandled exception: fail open
- hook timeout: treated as non-blocking by agent runtime hook runtime and must be tested live

### E. Bounded Output

`tokenomics/lib/bounded_output.py` exposes pure formatters:

```python
format_budget_alert(payload, max_chars=2000) -> str | None
format_forecast_alert(payload, max_chars=2000) -> str | None
format_drift_alert(payload, max_chars=2000) -> str | None
format_interrupt(payload, max_chars=2000) -> str
```

Lane budget:

```text
header: 200
key_fields: 800
evidence: 800
exits: 200
total: 2000
```

Dedup and cooldown state is caller-owned and stored in `dedup-cache.json`. Interrupts are never dedup-suppressed because every denied tool call needs a reason.

### F. WhatSoup Patch Set

F.1 - agent CLI argv forwarding:

- Add `agentOptions.cli`.
- Validate all values at config load.
- Forward `--tools`, `--allowedTools`, `--disallowedTools`, `--strict-mcp-config`, and `--no-chrome` only when explicitly set.
- Default is no behavior change.

F.2 - Prompt composition:

- Thread top-level `config.systemPrompt` through `main.ts -> AgentRuntime -> SessionManager`.
- Compose:
  1. generated WhatsApp transport prelude
  2. top-level `systemPrompt`
  3. `agentOptions.instructionsPath` contents
- Use exact-line dedup only.
- Do not normalize, rewrite, or section-dedup instructions.
- Preserve empty lines.
- `instructionsPath` policy:
  - When unset: no source 3, no warning, session boots normally.
  - When explicitly configured and missing or unreadable: refuse session start (fail-closed). An operator-referenced instruction file is load-bearing; silently dropping it is a quality regression. See Blocking Clarification B5.
- Empty composed prompt refuses session start.
- Native `CLAUDE.md` discovery is left to agent runtime.

F.3 - Token-window helper:

- Add `scripts/token-window.ts` plus an npm script.
- WhatSoup owns the DB schema and token aggregation contract.
- Tokenomics consumes the JSON shape and does not read `agent_token_events` or `metrics_hourly` directly.

F.7 - Runbook fix:

- Correct the stale Ctrl+C recovery language in `docs/runbook.md`.
- Actual stream-json stalled recovery is no-op plus hard watchdog.

F.8 - Child-env allowlist extension:

- Extend `buildBaseChildEnv` (or equivalent) to passthrough `ENABLE_TOOL_SEARCH`, `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, and `TOKENOMICS_BOT`.
- Each var passes through only when set in the parent env; missing values do not synthesize defaults.
- Default behavior unchanged for hosts that do not set these vars.
- Playwright MCP env vars are handled by the installer/config-file path, not by WhatSoup child-env passthrough in v1.
- See Blocking Clarification B2.

Deferred:

- F.4 `--resume` / `--continue` audit
- F.5 per-tool attribution schema migration
- F.6 pricing constants and cost estimates

### H. Plugin Drift Watchdog

The drift watchdog runs daily via launchd `StartCalendarInterval`, default 09:00 local. It runs the plugin coverage audit, compares against `plugin-coverage.json`, and alerts only on net-new inherited plugin keys.

First run writes the snapshot and does not alert.

### I. Context Overhead

Context overhead uses a layered source strategy:

1. Host `~/.claude/context_overhead.py` when present.
2. Vendored `tokenomics/lib/context_overhead.py` fallback.
3. Manual `/context` validation in Section 5 only.

The runtime output shape is:

```json
{
  "available": true,
  "static_overhead_tokens": 12345,
  "source": "~/.claude/context_overhead.py",
  "breakdown": [
    {
      "path": "<target-home>/LAB/CLAUDE.md",
      "bytes": 12000
    }
  ]
}
```

The vendored fallback estimates token cost from instruction file byte sizes and reports the per-file breakdown so bad measurements are debuggable.

### J. Instruction Surface And Skills

Install-time hard gates:

```text
MEMORY.md: 24576 bytes
CLAUDE.md: 16384 bytes
instructionsPath: 32768 bytes
```

If a file exceeds budget, the installer exits with `EX_INSTRUCTION_BLOAT=77` and prints the offending files plus remediation:

```text
Run instruction-hierarchy-maintenance, run session-distill, trim manually, then reinstall.
```

`--allow-bloat` can override the gate, but must log a warning.

Skill surface:

- Audit `~/.claude/skills` and plugin-shipped skills.
- Record active skills and estimated context cost.
- Materialize per-bot `disabled-skills.json` into `~/.claude/skills-disabled/<skill-name>` touch files.

The pilot uses both explicit plugin allowlisting and explicit skill disablement.

### L. Tokenomics Doctor

`tokenomics/scripts/tokenomics-doctor` is a structured-JSON diagnostic, callable independently of the installer. It emits one record per check with `{name, status, value?, advice?}` where `status` is `ok`, `warn`, or `fail`.

Check matrix:

```text
hooks_loaded             - any PreToolUse hooks active across surfaces
context_overhead_available - host ~/.claude/context_overhead.py importable
playwright_snapshot_mode  - value is full or none, not the stale incremental
playwright_output_mode    - prefer file
playwright_image_responses - omit is advisory for non-visual workflows
playwright_console_level  - prefer warning or higher
tool_search_env           - ENABLE_TOOL_SEARCH not explicitly false; warn if ANTHROPIC_BASE_URL set
search_toolchain          - rg present in PATH; fd, rga, ast-grep recommended
instruction_surface_sizes - CLAUDE.md, MEMORY.md, instructionsPath against configured budgets
mcp_server_count          - advisory threshold of 5 or more servers
browser_plugin_type       - distinguishes superpowers-chrome vs playwright
enabledPlugins_explicit   - agentOptions.enabledPlugins is an explicit map, not absent
skills_disabled_count     - touch-file count under ~/.claude/skills-disabled
env_caps_inventory        - records BASH_MAX_OUTPUT_LENGTH, MAX_MCP_OUTPUT_TOKENS,
                            CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS,
                            CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT,
                            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
```

Behavior contracts:

- K calls the doctor in `--full` mode before activation. Any `fail` record blocks install. The installer exits with `EX_DOCTOR_RED_FINDING=80` and prints the failing check list.
- A's cycle calls the doctor in `--cheap` mode at process start, with a 5-minute on-disk TTL cache at `~/Library/Application Support/<bot>-tokenomics/doctor-last-report.json`. If the cached report is fresher than the TTL and `--cheap` mode applies, the cycle reuses it.
- Check classification:
  - **Cheap (per-cycle, included in `--cheap`):** `enabledPlugins_explicit`, `tool_search_env`, `env_caps_inventory`, `instruction_surface_sizes` (stat only, no read).
  - **Heavy (install + daily, included in `--full` only):** `hooks_loaded` (scans all 3 surfaces), `context_overhead_available` (imports module), `playwright_*` (reads config JSON and queries running MCP), `search_toolchain` (PATH probes), `mcp_server_count`, `browser_plugin_type`, `skills_disabled_count` (filesystem walk).
- A daily launchd job runs `tokenomics-doctor --full` and refreshes the cached report. Both A and H read the cached report; neither runs heavy checks per cycle.
- The doctor never mutates configuration. It only reports.

### M. PostToolUse Output Cap

M is a PostToolUse interception lane that caps oversized tool outputs before they enter context. It is registered at install time but inert when `agentOptions.tokenomics.outputCap.enabled` is `false` (the v1 default).

**Matcher scope (v1):** `Bash` only.

Rationale: `updatedToolOutput` must match the per-tool output shape that agent runtime expects. Built-in `Bash` has a documented public shape: `{stdout, stderr, interrupted, isImage}`. `Read`, `Grep`, and `mcp__*` tool outputs have either undocumented or tool-specific shapes; emitting a raw string for them would be silently ignored or break the hook contract. Extending M to other tools requires a documented per-tool handler shape and is deferred to v2.

When enabled, the hook:

1. Reads the PostToolUse JSON payload from stdin. The tool output is in the `tool_response` field per the agent runtime hook contract (see `https://code.claude.com/docs/en/hooks`).
2. Verifies `tool_name == "Bash"`. Any other tool exits 0 unmodified (defensive guard in case the matcher is broadened by user error or future v2 work).
3. Reads `tool_response.stdout` and `tool_response.stderr`. Computes combined byte length.
4. If `len(stdout) + len(stderr) <= capBytes` (default `10240`), exits 0 unmodified.
5. Otherwise:
   - Computes `sha256(stdout + "\n---STDERR---\n" + stderr)[:16]` and spills the full original payload (both streams) to `~/Library/Application Support/<bot>-tokenomics/output-cache/<hash>.txt` with atomic write.
   - Dedupes consecutive repeated lines within each stream, replacing runs with `[... <N> repeated lines ...]`.
   - Builds truncated summaries: first 50 lines plus last 20 lines plus byte total plus cache path, per stream.
   - Emits the replacement on stdout preserving the Bash output shape:

   ```json
   {
     "hookSpecificOutput": {
       "hookEventName": "PostToolUse",
       "updatedToolOutput": {
         "stdout": "<truncated stdout summary plus cache path>",
         "stderr": "<truncated stderr summary or empty string>",
         "interrupted": false,
         "isImage": false
       }
     }
   }
   ```

   The `interrupted` and `isImage` fields are passed through from the original `tool_response` when present; otherwise defaulted to `false`.

Failure policy:

- Any error path returns the original output unmodified (fail open).
- Cache directory full, write race, hook timeout, or JSON parse failure all preserve the original output.

Retention: a daily launchd job removes cache files with mtime older than `cacheRetentionHours`.

The pilot ships M disabled. Operator flips `outputCap.enabled` per bot after reviewing L's `env_caps_inventory` to confirm no existing workflow assumes raw outputs.

### Playwright Profile (Component C extension)

Playwright MCP exposes two configuration surfaces: a JSON config file (typically passed via `--config <path>`) and environment variables. The relevant target bot host wrapper passes `--config ~/.config/playwright-mcp/config.json`, and that file currently contains `"snapshot": {"mode": "incremental"}`, which is stale.

The installer therefore touches **both** surfaces and verifies precedence at activation:

1. **Config-file edit** (primary, when the config path is detectable from the host wrapper):
   - Read `~/.config/playwright-mcp/config.json` (or the equivalent path resolved from the wrapper).
   - Set `snapshot.mode = "full"`, `output.mode = "file"`, `console.level = "warning"`.
   - Write atomically via temp file + rename.
   - Preserve any keys the installer doesn't manage.

2. **Environment variables** (defense-in-depth, also written into the relevant launchd or WhatSoup-service env):

   ```text
   PLAYWRIGHT_MCP_SNAPSHOT_MODE=full
   PLAYWRIGHT_MCP_OUTPUT_MODE=file
   PLAYWRIGHT_MCP_CONSOLE_LEVEL=warning
   # image-responses=omit gated by workflow; visual workflows keep default
   ```

3. **Precedence check at install time**: L's doctor confirms the running MCP picks up the intended values. If config-file and env disagree and the running mode is still `incremental`, install fails with `EX_DOCTOR_RED_FINDING=80`.

Operator can override via `agentOptions.tokenomics.playwrightProfile`. Source: Playwright MCP configuration (`https://playwright.dev/mcp/configuration/options`).

### G. State Layout

```text
~/Library/Application Support/<bot>-tokenomics/
+-- threshold.json
+-- history.jsonl
+-- last-generated-alert.json
+-- last-delivered-alert.json
+-- plugin-coverage.json
+-- dedup-cache.json
+-- stall-state.json
+-- doctor-last-report.json
+-- watchdog.runlock          # per-bot overlap lock used by A and H
+-- lock-skip.log             # append-only log of skipped invocations from overlap-lock losers
+-- browser-loop/
|   +-- <sha1[:16]>.jsonl
+-- output-cache/
|   +-- <sha256[:16]>.txt
+-- STALL.flag
```

The state directory survives reinstall and rollback unless the installer created it and it is empty.

## Section 4 - Error Handling And Fallbacks

### STALL State

STALL counters are persisted, not kept in memory, because launchd starts a new watchdog process each cycle.

`stall-state.json`:

```json
{
  "components": {
    "budget-watchdog": {
      "consecutive_failures": 0,
      "first_failure_ts": null,
      "last_failure_ts": null,
      "last_error": null
    },
    "drift-watchdog": {
      "consecutive_failures": 0,
      "first_failure_ts": null,
      "last_failure_ts": null,
      "last_error": null
    }
  }
}
```

On component success:

- reset `consecutive_failures` to 0
- clear timestamps and error
- remove `STALL.flag` if no component is stalled
- do not emit a recovery alert

On component failure:

- increment `consecutive_failures`
- preserve `first_failure_ts`
- update `last_failure_ts` and `last_error`
- at exactly 3 consecutive failures, write `STALL.flag` and emit one stall alert

SQL errors, schema drift, missing DB, unreadable DB, helper non-zero exit, and helper unavailable results all increment STALL. They do not create budget alerts.

### Alert Delivery

Alert records:

- `last-generated-alert.json`: most recent alert payload before delivery
- `last-delivered-alert.json`: most recent alert that reached a sink

Delivery logic:

1. Format alert.
2. If formatter returns `None`, stop.
3. Write `last-generated-alert.json`.
4. If `notifyVia == "whatsapp"`, try `~/LAB/lib/notify.sh`.
5. If not delivered, try syslog.
6. If delivered, write `last-delivered-alert.json` and advance cooldown.
7. If not delivered, do not advance cooldown. The next cycle retries if the condition remains true.

`notifyVia == "local"` never calls `notify.sh`.

### Fail-Open And Fail-Closed Policy

Hook path:

- D fails open.
- Infrastructure failure must not block real browser work.

Watchdog path:

- A and H fail soft.
- Observation gaps are recorded through STALL.
- Spurious token alerts are avoided.

Installer path:

- K fails closed.
- Unknown state means no install.
- Rollback removes only installer-created files recorded in `.install-checkpoint.json`.

WhatSoup runtime:

- Optional prompt sources fail soft.
- Empty composed system prompt fails closed.

### Installer Hook-Surface Audit

K checks all known hook surfaces before activation:

1. `~/.claude/settings.json`
2. `~/LAB/.claude/hookify.*.local.md`
3. other plugin `hooks.json` files

If any other surface already registers a `PreToolUse` matcher for `mcp__superpowers-chrome_chrome__use_browser`, the installer exits with `EX_HOOK_CONFLICT=78` and prints the conflicting path.

### Installer Search-Toolchain Baseline

K verifies the local search toolchain before activation:

- `rg` (ripgrep) must be on `PATH`. Absence exits `EX_MISSING_TOOLCHAIN=79`.
- `fd`, `rga`, and `ast-grep` are recommended. Absence emits a warning but does not block.
- `ugrep` is optional and unblocked.

This protects the bot from quietly degrading to slow `grep` paths that bloat tool-output context. target host fails this gate at first install until `rg` is provisioned.

### Installer Doctor Gate

K invokes L's `tokenomics-doctor` before any file is materialized. Any `fail` record exits `EX_DOCTOR_RED_FINDING=80` with the failing record list. `warn` records are surfaced but do not block.

### Plugin Manifest

The installer requires `tokenomics/.claude-plugin/plugin.json` with at minimum:

```json
{
  "name": "tokenomics",
  "version": "0.1.0",
  "description": "Token budget watchdog, browser-loop interrupt, instruction-surface gates, and observability for WhatSoup bot instances.",
  "sourceRepo": "LAB/WhatSoup/plugins/tokenomics"
}
```

The `sourceRepo` field records where the canonical tracked source lives so the installed plugin can be reconciled against version control. The pilot canonical source is `LAB/WhatSoup/plugins/tokenomics/`, a tracked directory inside the WhatSoup repository alongside `scripts/` and `docs/`. The installer copies (or symlinks during development) from that path into `~/.claude/plugins/tokenomics/` on each target host.

### Explicit Non-Goals Under Failure

The system must not:

- mutate `enabledPlugins` automatically
- downgrade models
- kill live sessions on browser loops
- truncate prompts or context automatically
- silently disable MCP servers
- post to WhatsApp unless `notifyVia` is explicitly set to `whatsapp`

## Section 5 - Testing And Validation

Tests live in two places:

- WhatSoup-side tests in the repo's top-level `tests/` layout.
- Tokenomics plugin tests in `~/.claude/plugins/tokenomics/tests/`.

### 5.1 Browser Hook Tests

Required cases:

1. First browser call in window allows.
2. Seventh call in 60 seconds allows.
3. Eighth call in 60 seconds denies with `permissionDecision: "deny"` and a non-empty reason under 2000 chars.
4. Calls spread over more than 60 seconds do not deny.
5. Session IDs are isolated.
6. Session IDs with path-like or invalid characters are hashed before filename use.
7. Empty stdin fails open.
8. Malformed JSON fails open.
9. Missing or empty `TOKENOMICS_BOT` fails open.
10. Unwritable state directory fails open.
11. Corrupt state file resets local state and allows the current call.
12. Concurrent writers keep valid JSONL using `fcntl.flock` plus atomic replace.
13. Hook timeout is tested under real agent runtime and is non-blocking.
14. Missing `bounded_output` import fails open.
15. Deny payload schema matches the agent runtime hook contract.

### 5.2 Watchdog Tests

Required cases:

1. Cold start creates `threshold.json` with bootstrap threshold.
2. Below threshold produces no alert.
3. Above threshold produces `last-generated-alert.json`, delivers, and updates `last-delivered-alert.json`.
4. Same signature inside cooldown is suppressed.
5. Same signature after cooldown is emitted.
6. Token-window helper non-zero increments STALL.
7. `whatsoup_db.available=false` increments STALL.
8. Three consecutive failures create `STALL.flag` and one stall alert.
9. Success after stall resets state and removes `STALL.flag`.
10. Threshold math uses bootstrap while fewer than 7 windows exist.
11. Threshold math drops to rolling mean after 7 windows, with 40M floor.
12. Delivery failure writes generated alert but not delivered alert and does not advance cooldown.
13. `notifyVia=whatsapp` calls `notify.sh` and falls back to syslog.
14. `notifyVia=local` never calls `notify.sh`.
15. Plugin drift detects net-new inherited keys.
16. Plugin drift with no change produces no alert.
17. Plugin drift first run writes snapshot and does not alert.
18. Budget formatter is pure and bounded.
19. Drift formatter is pure and bounded.
20. Interrupt formatter is pure, bounded, and never dedup-suppressed.
21. Forecast on stable burn rate is accurate within 10 percent.
22. Forecast with fewer than 3 records produces null fields and no alert.
23. Forecast skips samples crossing a 5-hour boundary reset.
24. Forecast alert fires when projected minutes to 75 percent is inside the configured window.
25. Forecast and budget alerts use independent signatures.
26. Two simultaneous watchdog invocations: one runs, the other exits 0 and appends a `lock_held` record to `lock-skip.log` (NOT `history.jsonl`); the loser does not touch any lock-protected file (B8).
27. `rolling_history` is built from non-overlapping wall-clock-anchored 5-hour buckets, not per-cycle samples (B6).
28. Forecast skips samples with negative delta (B7).
29. Forecast applies exponential decay so a long quiet tail reports a decayed rate, not the pre-quiet rate (B7).

### 5.3 WhatSoup Integration Tests

Required cases:

1. `composeWithExactLineDedup` empty input returns empty string.
2. Single source passes through unchanged.
3. Multiple sources with no overlap concatenate in order.
4. Exact duplicate lines keep the first occurrence and drop later occurrences.
5. Identity lines repeated between transport and instructions keep the first occurrence.
6. Empty lines are preserved.
7. Whitespace-only lines are treated as empty and not deduped.
8. Missing `configSystemPrompt` omits that source.
9. Unset `instructionsPath` omits source 3 silently and boots (no warning, omission is normal when not configured).
10. Explicitly configured `instructionsPath` that exists and is readable loads its contents into source 3.
11. All prompt sources empty refuses session start.
12. Invalid `agentOptions.cli` values are rejected.
13. Empty CLI arrays do not emit empty flags.
14. Undefined `agentOptions.cli` leaves argv unchanged.
15. Token-window helper output matches the watchdog contract.
16. Empty token window returns zero totals with `available=true`.
17. Missing instance exits non-zero with a clear error.
18. Top-level `systemPrompt` is threaded from config through `AgentRuntime` to `SessionManager`.
19. Token-window npm script output has no v2-only required fields.
20. Explicitly configured `instructionsPath` that is missing or unreadable refuses session start (B5 fail-closed when configured).
21. Unset `instructionsPath` still passes through with no warning (omission is normal when not configured).
22. `buildBaseChildEnv` forwards every B2 allowlisted env var when set in the parent process; omits each when unset (no synthesized defaults).

### 5.4 Installer Tests

Required cases:

1. Clean install creates files, plists, and checkpoint.
2. Conflict in `settings.json` exits `EX_HOOK_CONFLICT=78`.
3. Conflict in another plugin `hooks.json` exits 78.
4. Conflict in hookify rules exits 78.
5. Partial install failure rolls back only installer-created files.
6. Reinstall preserves existing `history.jsonl` and `threshold.json`.
7. Rollback preserves pre-existing state directory.
8. Rollback removes state directory only if this install created it and it is empty.
9. launchd plist load failure rolls back later steps.
10. Permission errors return named exit codes.
11. Oversized `MEMORY.md` exits `EX_INSTRUCTION_BLOAT=77`.
12. Oversized `CLAUDE.md` exits 77.
13. `--allow-bloat` proceeds and logs a warning.
14. Installed plist contains the configured `ENABLE_TOOL_SEARCH` value.
15. `disabled-skills.json` materializes touch files under `~/.claude/skills-disabled/`.
16. Missing `rg` on PATH exits `EX_MISSING_TOOLCHAIN=79`.
17. Doctor `fail` record exits `EX_DOCTOR_RED_FINDING=80` with diagnostic list.
18. Doctor `warn` records surface in stdout but install proceeds.
19. `tokenomics/.claude-plugin/plugin.json` present with `name`, `version`, and `sourceRepo` populated.
20. Stale `PLAYWRIGHT_MCP_SNAPSHOT_MODE=incremental` is rewritten to `full` (when host uses Playwright MCP).
21. `hooks.json` validates against the plugin hook schema with the top-level `hooks` wrapper.

### 5.5 Doctor And Output-Cap Tests

Required cases:

1. Doctor `--json` shape matches the consumer contract (one record per check, status ok/warn/fail).
2. Doctor flags `PLAYWRIGHT_MCP_SNAPSHOT_MODE=incremental` as `fail`.
3. Doctor flags missing `rg` as `fail`.
4. Doctor flags MEMORY.md over budget as `fail`.
5. Doctor flags `enabledPlugins` absent or empty as `warn` (sparse inheritance is the default; allowlisting is opt-in).
6. Doctor `env_caps_inventory` reports actual values of the five named env vars.
7. Output cap default-off behavior: 50 KB Bash output passes through unmodified.
8. Output cap enabled on Bash: 50 KB combined stdout+stderr is spilled to cache; `updatedToolOutput` is an object with keys `stdout`, `stderr`, `interrupted`, `isImage` (NOT a raw string).
9. Output cap enabled with `tool_name != "Bash"`: hook exits 0 unmodified even if the matcher is misconfigured (defensive guard).
10. Output cap dedup: 100 identical lines within a single stream collapse to one line plus marker.
11. Output cap preserves `interrupted` and `isImage` fields from the original `tool_response`.
12. Output cap fail-open: forced hook crash preserves original output.
13. Output cap cache write race: two concurrent identical outputs do not corrupt the cache file.
14. Output cap retention sweep removes files older than `cacheRetentionHours`.
15. Output cap matcher in installed `hooks.json` is exactly `"Bash"` (not the broader v0 placeholder).

### 5.6 Fleet-Scale Read-Only Validation

Run without installing tokenomics on fleet bot or fleet bot:

1. Token-window helper returns within 2 seconds against large histories.
2. Underlying query plan uses the timestamp index and avoids full scans.
3. Adaptive threshold simulation over 7 windows settles near observed mean.
4. Plugin drift audit completes within 30 seconds.
5. Hook hot-path benchmark p99 is under 500 ms over 1000 synthetic calls.
6. Dedup cache remains below 100 KB over 30 days of synthetic alerts.
7. `history.jsonl` rotation keeps files bounded near 1 MB.
8. Forecast computation on fleet bot and fleet bot history does not blow up or false-alert on steady state.

### 5.7 Manual Live Tests

Required before target bot deployment:

1. Real `use_browser` calls hit the eighth-call strategy interrupt and the agent changes tactic.
2. Low `manualCeiling` on a test instance produces a local budget alert.
3. Broken test DB produces three-cycle STALL and writes `STALL.flag`.
4. Injected hook sleep confirms timeout is non-blocking under agent runtime.
5. `notifyVia=whatsapp` produces an admin WhatsApp alert through `notify.sh`. This is optional for v1 because the default is local.
6. Operator runs `/context` manually and confirms the output is in the same order of magnitude as `overhead.static_overhead_tokens`.

### Exit Criteria

The pilot is ready for target bot when:

- 5.1.1 through 5.1.15 pass.
- 5.2.1 through 5.2.29 pass.
- 5.3.1 through 5.3.22 pass.
- 5.4.1 through 5.4.21 pass.
- 5.5.1 through 5.5.15 pass.
- 5.6 fleet-scale validation passes read-only.
- 5.7.1 through 5.7.4 and 5.7.6 pass under supervision.
- Every test in the Blocking Clarifications section maps to at least one of the test cases above and passes.

5.7.5 is optional for v1 because WhatsApp alerts are config-gated and disabled by default.

## Blocking Clarifications Before Implementation

The following points must be resolved in the spec and reflected in tests before any implementation work begins. Each one maps to at least one test case so that an implementation cannot quietly drift from the agreed contract.

### B1. Hook manifest shape

The agent runtime plugin hook schema requires a top-level `hooks` wrapper. The correct shape is `{"hooks": {"PreToolUse": [...], "PostToolUse": [...]}}`. A flat `{"PreToolUse": [...]}` at the top of `hooks.json` will fail validation. Section 3 shows the correct shape.

- Maps to test 5.4.21 (`hooks.json` validates against the plugin hook schema with the top-level `hooks` wrapper).

### B2. `ENABLE_TOOL_SEARCH` propagation through WhatSoup child environment

Setting `ENABLE_TOOL_SEARCH=auto:5` in a launchd plist only helps if WhatSoup forwards it into the spawned agent subprocess. WhatSoup's `buildBaseChildEnv` currently allowlists a fixed set of env vars and does NOT pass `ENABLE_TOOL_SEARCH` through. A launchd-plist-only patch will be silently dropped.

Required (added to F as F.8):

- F.8 - Env allowlist extension:
  - Locate WhatSoup's child-env construction (typically `src/core/child-env.ts` or equivalent; verify against current source at implementation time).
  - Extend the allowlist to include: `ENABLE_TOOL_SEARCH`, `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, and `TOKENOMICS_BOT`.
  - Each var is passed through only when set in the parent env; missing values do not synthesize defaults.
  - Default behavior unchanged for hosts that do not set these vars.
  - Do not forward `PLAYWRIGHT_MCP_*` through `buildBaseChildEnv` in v1; Playwright MCP mode changes are installed and verified through the plugin/config-file surface.

- Maps to test 5.4.14 (installed plist contains the configured value), a new test 5.3.22 (`buildBaseChildEnv` forwards every allowlisted var when set in parent env; omits when unset), and a new live-validation step under 5.7: confirm `ENABLE_TOOL_SEARCH` appears in the spawned agent process environment using `ps -E` or `/proc` equivalent.

### B3. Plugin source-of-truth path plus `.claude-plugin/plugin.json`

The plugin must declare itself via `tokenomics/.claude-plugin/plugin.json` and record a tracked source path. Without this the installed plugin cannot be reconciled against version control, and `claude plugin` tooling will not discover it correctly. Packaging sets the `sourceRepo` field at build time.

- Maps to test 5.4.19 (`tokenomics/.claude-plugin/plugin.json` present with required fields).

### B4. `enabledPlugins` is sparse inheritance, not a true allowlist

`agentOptions.enabledPlugins` is a sparse map. Keys not present inherit from the global plugin set. Setting `{}` does not isolate the instance. A true allowlist requires:

- Listing every intended plugin with `true` or `false`.
- Periodic drift detection via component H against a tokenomics-private snapshot.
- L's `enabledPlugins_explicit` doctor check warning when the map is empty or absent.

The pilot ships an explicit map for target bot and an L check that warns when the map is sparse.

- Maps to test 5.5.5 (Doctor flags absent or empty `enabledPlugins` as `warn`) and 5.2.15 (Plugin drift detects net-new inherited keys).

### B5. `instructionsPath` failure policy

If `agentOptions.instructionsPath` is explicitly configured and the file is missing or unreadable, the v1 default behavior must be fail-closed for that instance (refuse session start) rather than fail-soft (log warning and omit). The rationale is that an instruction file referenced by an operator is load-bearing; silently dropping it is a quality regression.

The spec previously described fail-soft. This clarification overrides that. Section 3.F is updated implicitly by this clarification.

- Maps to a new test in 5.3: missing `instructionsPath` when explicitly configured refuses session start (not "logs warning and boots").

### B6. Non-overlapping bucket semantics for the adaptive threshold

The 5-hour rolling window must use non-overlapping buckets when recording completed windows into `rolling_history`. If each cycle samples the trailing 5 hours every 60 seconds and feeds those samples into `rolling_history` indiscriminately, the rolling mean inflates by approximately 300x.

Concretely:

- The 60-second cycle samples the trailing 5 hours for the live `pct` check. That value never enters `rolling_history`.
- `rolling_history` is appended only when a 5-hour bucket aligned to a wall-clock anchor completes. The anchor is the watchdog's first-run timestamp or a configurable bucket offset.
- The history file records `{bucket_start_ts, bucket_end_ts, total_tokens, event_count}` per bucket.

- Maps to test 5.2.10 and 5.2.11 (threshold math): tests must build `rolling_history` from non-overlapping buckets, not from per-cycle samples.

### B7. Forecast must skip negative deltas and decay

Linear regression on raw `window_sum` deltas will overreact when:

- A 5-hour boundary causes `window_sum` to drop (negative delta).
- A long quiet period decays the burn rate.

Required:

- Skip any sample with a negative delta.
- Apply exponential decay to the rolling burn rate so a stale sample does not dominate.
- Recompute from scratch after any detected 5-hour boundary reset.

- Maps to test 5.2.23 (Forecast skips samples crossing a 5-hour boundary reset) and a new case: forecast on a sequence ending in a long quiet period reports a decayed burn rate, not the pre-quiet rate.

### B8. Per-bot overlap lock

A and H both touch the same per-bot state directory. If launchd starts a second instance while the first is still running (slow cycle, stuck DB, locked file), state corruption is possible.

Required:

- Both A and H acquire `~/Library/Application Support/<bot>-tokenomics/watchdog.runlock` via `flock` with a non-blocking try.
- If the lock is held, the second invocation exits 0 immediately and appends a single `{ts, component, pid, reason: "lock_held"}` line to `~/Library/Application Support/<bot>-tokenomics/lock-skip.log` plus a syslog `info` line. It does NOT write to `history.jsonl`, `threshold.json`, `stall-state.json`, or any other lock-protected file.
- The lock implementation lives in `tokenomics/lib/overlap_lock.py`.

- Maps to test 5.2.26 (new): two simultaneous watchdog invocations result in exactly one cycle execution; the other exits 0 with `lock_held` warning.

The losing invocation **must not** write to shared state. `history.jsonl` is owned by the cycle-execution path and requires the lock. The lock-skip record goes to:

```text
~/Library/Application Support/<bot>-tokenomics/lock-skip.log
```

This is an append-only single-writer-per-process file with `O_APPEND` semantics. One line per skipped invocation: `{ts, component, pid, reason: "lock_held"}`. The loser also emits a syslog `info` line. No state corruption is possible because the losing process never touches `history.jsonl`, `threshold.json`, `stall-state.json`, or any other lock-protected file.

## V2 Backlog

1. Add `ccusage` as a secondary token source under `sources.ccusage_jsonl`.
2. Add per-tool attribution and `by_tool` output.
3. Add pricing constants and `estimated_cost_usd`.
4. Audit `--resume` and `--continue` behavior.
5. Add restart-required detection for MCP/plugin set changes.
6. Add fleet dashboard reads from tokenomics state without mutating bot config.
7. Evaluate community context-doctor style measurement as a replacement for the vendored byte proxy.
8. Extend M output-cap to additional tools (`Read`, `Grep`, MCP outputs) once each tool's `updatedToolOutput` shape is documented and a per-tool handler is implemented. v1 ships Bash-only.
