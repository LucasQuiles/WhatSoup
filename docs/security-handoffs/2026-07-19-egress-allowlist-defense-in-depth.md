# Agent egress allowlist — defense-in-depth (QR-008 / #1607)

**Status:** shipped as opt-in (this PR). Firewall backstop = follow-up.
**Severity:** HIGH (agent-runtime security boundary).

## What was closed

QR-008 flagged that a permitted `Bash` tool call can spawn a subprocess with
**unbounded** network egress — the sandbox hook (`deploy/hooks/agent-sandbox.sh`)
gates tools/paths at the tool boundary, not the network.

This PR adds an **opt-in loopback filtering forward-proxy** (`src/runtimes/agent/egress-proxy.ts`):

- Allowlist lives in `.claude/sandbox-policy.json` as `allowedEgress: string[]`
  (single source; authored via `agentOptions.sandbox.allowedEgress`).
- The proxy starts with the instance when `allowedEgress` is a non-empty array;
  agent children get `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. HTTP forward + HTTPS
  `CONNECT` are adjudicated per request (host / host:port, case-insensitive, no
  wildcards); refusals return 403 and log `sandbox_egress_deny`.
- Fail-closed: empty/corrupt/unreadable policy denies all; a proxy that cannot
  start aborts instance start (an opted-in instance never runs unconfined).
  `WHATSOUP_SANDBOX_FAIL_OPEN=1` is the single documented escape hatch.
- Policy is re-read per request → live edits take effect without a restart.

## What is NOT confined (honest scope)

This is **defense-in-depth for proxy-aware traffic only**. Explicitly out of scope
in this layer:

1. **Raw sockets / proxy-env bypass.** A subprocess that dials a raw TCP socket, or
   unsets `*_PROXY`, is not confined. Only a host-firewall / netns backstop closes
   this — the planned follow-up, designed to consume the SAME `allowedEgress`
   source (see `egressHostAllowed()`, exported for reuse) so the two layers cannot
   diverge (the #1862 divergence lesson).
2. **IPv6 targets.** `egressHostAllowed`/`parseConnectTarget` do not yet strip
   `[...]` brackets; IPv6 hosts fail **closed** (deny / connect-fail), never a
   bypass. Bracket-aware matching is a follow-up.
3. **Hop-by-hop headers** are forwarded verbatim on the HTTP path (the upstream is
   already adjudicated-allowed, so this is proxy-correctness polish, not a
   containment gap).

## Owner action to activate

Nothing changes for any deployed instance until the owner seeds a production
`agentOptions.sandbox.allowedEgress` per instance. Recommended initial seed: the
provider API hosts the agent legitimately needs (e.g. `api.anthropic.com`) plus
any MCP/tool egress the workspace requires. Start with `log`-heavy observation
(watch `sandbox_egress_deny`) before tightening.
