// Shared fake `timeout`/`gtimeout` for the deploy tests that exercise
// `whatsoup_run_bounded`'s timeout/gtimeout branches.
//
// It mirrors the real GNU timeout argv shape —
// `timeout [--version] [-k <grace>] <duration> <command...>` — and collapses to
// just the wrapped command after consuming the timeout args (it does not bound;
// actual bounding is covered by credential-probe-boundedness.test.ts). Here the
// fake only needs to let the wrapped commands reach their log/ledger targets.
//
// Why this is shared: this body was copy-pasted at 4 sites across 2 files (3 in
// whatsoup-health-token-wrapper.test.ts, 1 in install-host-dependencies.test.ts).
// When `whatsoup_run_bounded` began passing `-k <grace>` (#3318), each single-shift
// copy had to be taught the new `-k <grace>` pair independently — the installer
// stub and the wrapper stubs were fixed in separate commits, and a missed copy
// tried to exec the grace duration (`30s: command not found`, exit 127). One
// helper makes the next change to the timeout argv shape a single edit.
//
// Callers keep their own write-convention (shebang, mode) and platform-specific
// name (`timeout` on Linux, `gtimeout` on Darwin); this returns only the body.

export function fakeTimeoutBody(): string {
  return [
    // `--version` answers host-capabilities.sh's `whatsoup_probe_capability`
    // probe, which runs `"$CAP_PATH" --version` for the `timeout` capability.
    'if [ "${1:-}" = "--version" ]; then printf "%s\\n" "timeout (GNU coreutils) 9.7"; exit 0; fi',
    // Log the full `$*` BEFORE any shifting so log assertions can pin the exact
    // `-k` grace and duration that reached the wrapped command. Guarded on
    // LOG_PATH: only the health-token-wrapper probes export it; the installer
    // env does not, and an unguarded `>> "$LOG_PATH"` would be a bash redirection
    // error there.
    `if [ -n "\${LOG_PATH:-}" ]; then printf 'timeout %s\\n' "$*" >> "$LOG_PATH"; fi`,
    'if [ "${1:-}" = "-k" ]; then shift 2; fi',
    'shift',
    'exec "$@"',
  ].join('\n');
}
