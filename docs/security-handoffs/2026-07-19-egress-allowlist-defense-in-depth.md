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
- The proxy starts with the instance when `allowedEgress` is a **present** array
  — including `[]`, which is deny-all (F1): a present-but-empty allowlist runs
  the proxy and denies every host. Only an absent/undefined `allowedEgress`
  skips the proxy (the documented opt-out). Agent children get
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (both UPPER and lower case — curl reads
  lowercase `http_proxy` for plain HTTP, F4). HTTP forward + HTTPS `CONNECT` are
  adjudicated per request (host / host:port, case-insensitive, no wildcards);
  refusals return 403 and log `sandbox_egress_deny`.
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
4. **The policy file is trusted, and the agent may be able to write it (F7).** The
   proxy re-reads `.claude/sandbox-policy.json` on every request to support live
   edits. That file lives **inside the agent's workspace**. If the sandbox
   `allowedPaths` grant the agent write access to its own `.claude/` (or the
   workspace root), a compromised/adversarial agent can append its own host to
   `allowedEgress` and self-authorize egress on the very next request — the
   containment boundary is only as strong as the file's write protection.
   **Operators MUST keep `.claude/sandbox-policy.json` out of the agent's
   writable `allowedPaths`.** A future hardening should relocate the policy
   outside the agent-writable tree (or sign/verify it); until then this is an
   operator responsibility, not a guarantee the proxy enforces.

## Owner action to activate

Nothing changes for any deployed instance until the owner seeds a production
`agentOptions.sandbox.allowedEgress` per instance. Recommended initial seed: the
provider API hosts the agent legitimately needs (e.g. `api.anthropic.com`) plus
any MCP/tool egress the workspace requires. Start with `log`-heavy observation
(watch `sandbox_egress_deny`) before tightening.
