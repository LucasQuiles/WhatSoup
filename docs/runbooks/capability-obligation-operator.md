# Capability-Obligation Replay — Operator Runbook

Operator procedures for the capability-obligation replay feature (the delivery-vs-fulfillment
repair: a managed-loop capability refusal that was echo-settled into silence is turned into a
durable, replayable obligation the supervisor drains through the normal per-chat pipeline).

This runbook covers the **operator front-door commands** only. The scanner/claim/dispatch
supervisor is autonomous; these commands supply the two things it cannot mint for itself: a
capability **attestation** (readiness) and, for a group, a **drain approval** (authorization).

> **Holds.** Every command here defaults to a dry run and never migrates a live database.
> Recording an attestation, approving a group drain, and any live migration remain
> owner-gated (H5 / AS-08 / AS-01). Nothing in this runbook has been executed against a live
> instance. The `--json` flag is available on each command for machine-readable output.

## Prerequisites

- Run from the **release whose schema matches the target instance** — each command refuses
  unless the database is at exactly `CURRENT_SCHEMA_MIGRATION` (it never migrates).
- Node pinned to `24.15.0`; invoke via the repo's pinned-node wrapper.
- The binding facts (host, runtime user, release SHA, provider, contract version, skill
  identity, media root) must match what the **live supervisor** builds, or the recorded
  attestation will never admit a real obligation. `--config PATH` (the instance
  `agentOptions.capabilityObligations` block) is cross-checked against your flags and the
  command refuses on any binding mismatch.

## 1. Produce a capability attestation — `scripts/capability-obligation-attest.ts`

Without an admissible attestation the supervisor admits nothing and every obligation parks.
This command derives the live binding and records ONE attestation **iff** a bounded,
non-sending resolver canary passes.

- **Dry run (default):** derives the binding + digest, records nothing. With `--config` it
  additionally proves the binding matches the instance config.
- **Record:** `--run-canary --confirm --config PATH --probe-source SOURCE --receipt-out PATH --resolver-digest DIGEST`.

Before recording, the command is **fail-closed** on three observations (hardened round 18):

1. **media-root readability** — refuses unless the binding's media root is a readable directory.
2. **resolver-artifact verification (mandatory, EXPLICIT, content+shape)** — the resolver artifact is
   declared on `execution`: `resolverArtifactPath` (the code file) + `interpreted` (true ⇒ `command[0]`
   is an interpreter and the artifact is `command[1]`; false ⇒ `command[0]` is the artifact). The
   command sha256s **that declared file** (by realpath), requires its realpath to BE the token that
   executes — NEVER inferred from argv (round-18 finding 1) — and folds that content hash with the
   canonical command shape into a **COMPOSITE** `resolver_digest`. `--resolver-digest` is REQUIRED and
   must equal that COMPOSITE (round-19 findings 1+2). It **refuses** an inline/flag at the script
   position (`node -e …`, `perl -eCODE`), a declared artifact whose realpath ≠ the executing token,
   an `interpreted:false` MISLABEL of an interpreter (a `watch-resolver`→node symlink declared "direct"),
   a missing/unreadable artifact, or any composite mismatch. **The executor re-derives the SAME composite
   from the LIVE artifact + shape at the drain seam and refuses on any mismatch** — a post-attest content
   swap OR command-shape change is caught before any spawn — then executes a same-directory **hardlink
   PIN** of the verified bytes (path-swap-proof, sibling-resolution-preserving; an unpinnable directory
   fails closed).
3. **evidence preservation, durable + no-clobber, before admission** — the probe's stdout/stderr
   digests + byte counts + exit/signal + observed-source digest are written to the `--receipt-out`
   file, which is **fsynced, read-back-verified, and published NO-CLOBBER (`link()`) BEFORE the
   attestation row is admitted** — so an admissible row implies its receipt was durable first, and
   a second run to the SAME path is REFUSED rather than overwriting the first's evidence (round-18
   finding 2; use a fresh `--receipt-out` per run). The receipt records probe evidence only; it
   does not assert admission (admission = the `capability_attestations` row carrying this `nonce`).

The canary also owns a **process group** (`detached`) and SIGKILLs it on timeout AND on clean
exit, so a resolver that forks a grandchild (yt-dlp → ffmpeg) cannot leave it to land a side
effect after the outcome is reported.

**NARROW CLAIM (read this).** A passing canary attests ONLY that the observed installed
resolver, run against `sha256(probeSource)`, exited 0 within bound and produced ≥
`minOutputBytes` on stdout. It is **not** proof of semantic processing — a bounded probe
cannot establish that. Per the design spec §3.3 the fulfillment proof is the D6 execution
receipt + the normal-delivery chain, not the canary.

> The attestation ROW has no probe-evidence columns; adding them needs migration 58, which
> bumps `CURRENT_SCHEMA_MIGRATION` **inside the attestation binding** — invalidating every
> computed digest and reopening AS-01. Evidence therefore lives in the `--receipt-out` file,
> correlated to the row by `nonce`, not in the row. This is deliberate, not an oversight.

## 2. Approve + arm a group drain — `scripts/capability-obligation-approve-drain.ts`

Group obligations sit in `waiting_approval` until a destination-specific, digest-bound owner
approval (AS-08). This command records the approval AND drives the sole
`waiting_approval → waiting_capability` transition in **one atomic store transaction**
(`recordAndConsumeGroupDrainApproval`, round-17 finding 3) so one operator action arms the
drain with **no orphan-approval window** — a failure rolls back both the approval row and the
state flip together. Dry run (default) records nothing.

```
capability-obligation-approve-drain --db PATH --obligation-id N --release-sha SHA \
  --provider P --skill-name N --skill-digest D --probe-version PV --canary-id CID \
  --media-root PATH --manifest-digest MD --drain-run-id ID --approver WHO \
  --valid-seconds N [--dep k=v ...] --confirm
```

On `--confirm` the obligation reaches `waiting_capability`. **Claimability still additionally
requires a fresh admissible attestation** (step 1) — "armed" is not "will drain". The
supervisor then claims (single-flight, fenced) and dispatches through the normal pipeline.

## 3. Cold-obligation activation — NOT WIRED (owner-gated)

After a cold restart the incident obligations need their per-chat **session** active for the
supervisor to dispatch. `src/runtimes/agent/capability-obligation-drain-now.ts`
(`drainObligationNow`) is the gated activation CORE: it activates ONE named
`waiting_capability` obligation's session and runs one tick, fail-closed, refusing a GROUP
unless a live AS-08 approval is in force.

**Its `activateSession` port has no live adapter and no operator trigger.** Activating a real
group session is the AE1-sensitive act (a resumed group session can emit unsolicited
messages bypassing the sibling filter), so the live adapter is left for an owner-authorized
change with its own review. The precise gap (round-18 correction): there is **no deterministic,
operator-triggered cold-drain path**. A DM obligation MAY still resume opportunistically via a
fresh checkpoint or the chat's next natural inbound; a GROUP obligation cannot (AE1). The missing
piece is a deterministic operator command to drain a NAMED cold obligation on demand — a named
acceptance blocker, not a supported path.

## End-to-end order

1. `capability-obligation-attest … --run-canary --confirm` (readiness attestation).
2. For a group: `capability-obligation-approve-drain … --confirm` (AS-08 approval + arm).
3. The supervisor scans → admits (attestation) → claims (fenced) → dispatches → settles.
4. (Cold restart only) session activation — **owner-gated, not yet wired** (§3).

## Safety recap

- Schema-guarded, dry-run-by-default, `--json` for automation.
- No live DB write, provider call, or WhatsApp send occurs from a dry run.
- Recording an attestation and approving a group drain are owner-gated actions (H5 / AS-08);
  a live migration additionally requires the AS-01 old-binary rehearsal to pass.
