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
   whole-**DIRECTORY MANIFEST** (a canonical hash of every regular file's `[relpath, sha256]`, so a
   sibling swap is caught), the **INTERPRETER content** (`command[0]` when `interpreted`), and the
   canonical command **shape + envelope** (`timeoutMs`/`minOutputBytes`) into a **COMPOSITE**
   `resolver_digest` (round-20). `--resolver-digest` is REQUIRED and must equal that COMPOSITE. It
   **refuses** an inline/flag at the script position (`node -e …`, `perl -eCODE`), a declared artifact
   whose realpath ≠ the executing token, an `interpreted:false` MISLABEL of an interpreter (a
   `watch-resolver`→node symlink declared "direct"), in direct mode ANY token after the artifact that
   is a FLAG or does not embed `{source}` (round-21 finding 2 — `["-c","{source}"]` would run the
   inbound source as code), a `interpreted:true` command whose `command[0]` is a bare `$PATH` name
   (refused at config LOAD — an interpreter must be an explicit path) or an interpreter (or ancestor
   dir) writable by a DIFFERENT untrusted actor — world-writable, or group-writable to a group the
   process is in, unless it is a sticky dir like `/tmp` (round-21 finding 1; the interpreter is not
   staged, so a swap between hash and spawn would run unverified bytes), a symlink or non-regular entry
   in the resolver directory, an added/empty DIRECTORY after attestation (round-21 finding 3 — the
   manifest binds directory entries), a missing/unreadable artifact, or any composite mismatch. **The executor re-derives the SAME composite
   from the LIVE staged tree + shape at the drain seam and refuses on any mismatch** — a post-attest
   content swap, sibling swap, interpreter swap, OR command-shape/envelope change is caught before any
   spawn (the log names the staged files via `stagedManifestFiles` so a stray file is diagnosable) —
   then **content-addressed STAGES** the artifact's whole directory into a private root and executes the
   immutable COPY (round-20 findings 1+3; swap-proof, sibling-resolution-preserving). **The resolver
   artifact MUST live in an ISOLATED, symlink-free directory containing ONLY the resolver and its
   intentional siblings** — nothing else may be written next to it (no `.DS_Store`, editor swap file,
   `__pycache__`, log, db, or media), and the tree must be within the 64 MB staging bound, or every
   drain fails closed as `resolver_digest_mismatch`.
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

## 3. Cold-obligation activation — `capability-obligation-drain-now` (round 22, owner-authorized)

After a cold restart the incident obligations need their per-chat **session** active for the
supervisor to dispatch. `src/runtimes/agent/capability-obligation-drain-now.ts`
(`drainObligationNow`) is the gated activation CORE: it activates ONE named
`waiting_capability` obligation's session and runs one tick, fail-closed, refusing a GROUP
unless a live AS-08 approval is in force, and refusing ANY obligation with no plausible
attestation candidate (the round-22 pre-activation gate — provider/harness are the only
binding fields ignored, since they are unknowable before the session spawns; the claim's
exact-binding admission stays authoritative).

The live adapter + operator trigger were built in round 22 under an explicit owner grant
(2026-08-13). The trigger is a **same-UID drop-file**, not a new network surface or an
agent-reachable MCP tool:

```
capability-obligation-drain-now --db PATH --obligation-id N --requested-by WHO [--json] --confirm
```

Dry-run (default) previews the obligation state and the group-approval liveness and writes
nothing. `--confirm` writes `<db-dir>/capability-drain-now/<obligationId>.json`; the LIVE
instance's obligation scan (30s interval) consumes the request (rename-before-service — a
crash can lose a request, never double-service it), re-checks EVERY gate itself, activates
the session with a FRESH spawn (no checkpoint resume, no missed-message injection, no
continuation turn — the only turn that can enter is the minted obligation turn), and runs
one supervisor tick. Requests expire after 15 minutes; outcomes are recorded next to the
consumed file as `<name>.result.json`. The CLI's own gate checks are ADVISORY — the
runtime's `drainObligationNow` decides.

AE1 remains intact: proactive resume still excludes groups; the ONLY path that activates a
group session is this operator command, and only while its AS-08 approval is live. With no
request file present the runtime never activates anything (asserted by an executor-seam
test). The drop-dir itself must be a directory owned by the runtime UID with no
group/other write bit — otherwise the whole cycle is refused (`untrusted_request_dir`)
and nothing is consumed.

**Operator note — activation is one-way (r22 review):** drain-now activates the session
and runs one tick; nothing tears the session down afterwards. If the approval is revoked
right after activation, no send can occur (the claim re-validates the approval in the
same transaction), but the activated agent session lingers until the normal
sweep/lifecycle ends it. If that matters (e.g. a group you no longer want an active
agent in), restart the instance or end the session via the normal service controls after
the drain settles.

## End-to-end order

1. `capability-obligation-attest … --run-canary --confirm` (readiness attestation).
2. For a group: `capability-obligation-approve-drain … --confirm` (AS-08 approval + arm).
3. The supervisor scans → admits (attestation) → claims (fenced) → dispatches → settles.
4. (Cold restart only) `capability-obligation-drain-now … --confirm` (§3) to activate the
   named obligation's session; the same scan then drains it.

## Safety recap

- Schema-guarded, dry-run-by-default, `--json` for automation.
- No live DB write, provider call, or WhatsApp send occurs from a dry run.
- Recording an attestation and approving a group drain are owner-gated actions (H5 / AS-08);
  a live migration additionally requires the AS-01 old-binary rehearsal to pass.
- The same-UID staged-copy window (F4, incl. the EUID-owned interpreter) and the direct-mode
  positional-code residual (awk-shape) are OWNER-RATIFIED threat-model boundaries
  (2026-08-13) — documented in `docs/durability.md` §5.7, not open defects. The drain-now
  drop-file shares the same single-trusted-UID boundary.
