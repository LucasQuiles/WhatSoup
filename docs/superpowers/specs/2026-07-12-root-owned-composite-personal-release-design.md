# Root-Owned Composite Personal-Instance Release Design

Date: 2026-07-12

Status: approved direction; implementation and deployment remain evidence-gated

## Objective

Make a personal WhatSoup cutover deployable from real artifacts while preventing the service user from rewriting the code, rollback material, launch definitions, or signed control state being attested.

The release path must support private instance configuration and rendered launchd definitions without placing host data in Git. The runtime must also bind human approval identity and the exact main launch definition at the point where they become authoritative.

This design is generic. It contains no fleet host names, phone numbers, chat identifiers, account addresses, credentials, or operator-specific paths.

## Current gaps

The current Git materializer seals commit-derived code and dependencies, but the cutover plan requires a rollback config plus main, watchdog, and reply-guarantee plists inside the rollback payload. Tests insert those files manually; the production builder has no corresponding assembly input.

Additional adversarial gaps are related to the same trust boundary:

- the service user owns the sealed paths and can transiently replace checked executables;
- a selected Microsoft 365 capability can reach the physical home when `cwd` is missing;
- LID-to-phone resolution occurs at tool-use time rather than inbound admission;
- live main-job arguments are parsed but not compared with signed plist bytes;
- user-owned ancestor directories can be redirected between path checks.

## Approaches considered

### A. Root-owned composite release with a narrow installer (selected)

Build ordinary commit-derived staging as the operator, then use a small privileged installer to validate private inputs, render target-specific launch artifacts, inventory the composite payload, transfer ownership, apply read/execute ACLs for the service user, and publish into a root-owned release/control root.

This closes same-UID rewrite races at the ownership boundary while retaining a normal unprivileged runtime.

### B. Same-user hashing, locks, and rechecks

This improves accidental-drift detection but cannot prove that a malicious or compromised same-UID process did not replace executable bytes between check and use.

Rejected for the final attested cutover.

### C. Dedicated service account plus root-owned release

This provides stronger process and keychain isolation, but it requires a separate identity, service migration, and credential/session transfer design.

Deferred. The selected design keeps the existing service identity while preventing writes to deployed and control artifacts.

## Ownership and privilege boundary

The privileged component is a non-interactive, argument-validated installer/finalizer. It does not receive raw credentials, tokens, message content, or arbitrary shell commands.

It may perform only these operations under fixed root-owned prefixes:

1. open and validate one operator-created staging release;
2. open one private instance config and one non-secret render descriptor through no-follow descriptors;
3. render and validate launchd definitions;
4. assemble, inventory, fsync, and seal a new release object that does not already exist;
5. publish one direct commit-named relative symlink without replacement;
6. atomically install a signed-plan-selected config/plist set or restore its sealed rollback set;
7. report metadata-only receipts.

Release and control directories are root-owned. Files are non-writable by the service user. Executables are root-owned and executable; manifests, receipts, config, and plists are root-owned and read-only. Where private files must be read by the existing service identity, a narrow read ACL grants that UID access without granting write, ownership, ACL mutation, or directory-entry mutation. The manifest records owner, group, mode, ACL digest, flags, device, inode, size, and content digest.

The service runtime remains unprivileged. It cannot repoint the release symlink, alter launch definitions, rewrite the rollback config, replace Node/npm/wrapper bytes, or modify signed control inputs.

## Composite release inputs

The materializer distinguishes provenance instead of pretending every byte came from Git.

### Commit-derived input

- exact detached commit from the required SSH origin;
- wrapper and runtime source;
- package lock and installed dependency tree;
- generic launchd templates;
- preflight and release checker;
- pinned Node and npm executable identities.

### Target-local private input

- one schema-valid instance config, regular, uniquely linked, owner-private, and free of plaintext credentials;
- one non-secret render descriptor containing instance name, final release/config paths, launch labels, health port, working directory, and environment variable names—but no values.

The installer copies private input through descriptors, rechecks source identity after the copy, and never emits content. The composite manifest records its digest and original filesystem identity under a `target_local` provenance class.

## Deterministic assembly

After detached checkout and dependency installation, but before inventory and sealing, the finalizer:

1. validates the config through the normal shared schema and plaintext-secret prohibition;
2. writes the rollback config to a fixed payload-relative location;
3. renders the main, watchdog, and reply-guarantee plists against the final payload and wrapper paths;
4. requires exact labels, program arguments, working directories, environment key names, and loopback health endpoints;
5. runs `plutil -lint` and a structural parser over each plist;
6. inventories every child and rejects sockets, devices, writable files, external symlinks, hard links, unexpected ACLs, and host-state paths;
7. fsyncs files and directories recursively;
8. applies root ownership, immutable modes/ACLs, and any supported filesystem flags;
9. re-inventories the final bytes and metadata;
10. creates the public symlink with atomic no-replace semantics and rechecks the full inventory after publication.

The receipt binds commit, composite manifest, private-input digest, render descriptor digest, toolchain, platform/architecture, object path, public link, ownership policy, and durability result.

## Signed plan and launch proof

Candidate and rollback main definitions use the same verified plist parser already used for adjacent jobs. Observation and terminal rollback proof compare:

- plist path;
- program path;
- complete ordered `ProgramArguments` vector;
- working directory;
- release lineage;
- PID/generation and health commit.

The plan never carries an independently editable argument vector. Expected values are derived from the exact signed plist bytes referenced by its file identity.

The privileged activation step installs exact root-owned files and rechecks their identities after launchctl admission. A mismatch contains the service rather than retrying or declaring rollback active.

## Capability working-directory invariant

An instance selecting a required Microsoft 365 capability must specify an explicit private working directory. Validation rejects missing, empty, relative, symlinked-to-home, or physically home-equivalent paths before readiness, ledger initialization, MCP config writing, or socket creation.

Non-capability instances retain existing defaults unless separately migrated. This keeps the security change scoped to the capability that writes protected per-chat configuration.

## Human actor provenance

Canonical phone identity is captured at inbound admission, not recomputed when a tool later executes.

For a LID sender, admission persists:

- raw sender JID;
- canonical phone JID;
- mapping row identity/generation or equivalent immutable binding evidence;
- conversation key and inbound sequence.

Mail approval resolution uses that captured canonical identity and verifies the raw queue head still belongs to the same admitted turn. A missing, changed, ambiguous, or late-only mapping fails closed. No current mutable LID mapping can promote a previously admitted non-admin turn into an admin-authorized mutation.

Only hashes or bounded identifiers enter the durable mail ledger; raw phone values remain in the existing private message database boundary.

## Trusted input traversal

All control inputs live below root-owned prefixes. The installer authenticates every ancestor component, refuses symlinks, and holds descriptors or stable identities across reads. Final components use no-follow opens and unique-link regular-file checks. Parent identity is rechecked before publication or activation.

This replaces the impossible claim that final-component `O_NOFOLLOW` alone protects a user-owned mutable ancestor tree.

## Failure handling

Before acceptance, any validation, ownership, render, inventory, fsync, or launch-definition failure restores the sealed rollback through the privileged installer. After durable acceptance, failure is forward-only containment; it never silently reactivates code capable of repeating an accepted side effect.

Receipts are immutable and metadata-only. Unknown state remains unknown. A partially assembled object is private, unpublished, and removed only after proving it is not the public target. Existing release objects and symlinks are never replaced in place.

## Verification

The implementation must include:

- a real integration chain: materialize rollback → real release checker → signed-plan parser → controller dry-run;
- missing, malformed, symlinked, hard-linked, writable, secret-bearing, or identity-changing private input rejection;
- deterministic plist rendering and `plutil` validation;
- manifest differentiation of commit-derived and target-local bytes;
- root-owner/mode/ACL/ancestor drift rejection;
- full post-publication child inventory recheck;
- candidate and rollback main argument mismatch tests;
- missing/empty/physical-home `cwd` rejection before capability startup;
- LID mapping-flip tests proving the admitted actor cannot change;
- repeated rollback proof without another bootstrap/kickstart;
- crash injection before and after publication and acceptance;
- target-local privileged rehearsal proving the service UID can read/execute but cannot write, repoint, chmod, or alter ACLs;
- the complete repository suite, typecheck, lint, test-integrity, public-surface, and private-literal gates from the committed candidate.

The target rehearsal is required because non-root unit tests cannot prove macOS ownership, ACL, launchd, or filesystem behavior.

## Rollout

Both the known-running prior release and candidate are sealed at their final target paths. The prior release is proven compatible with the forward database before any pointer swap. The controller uses only signed plans that bind both composite manifests and the privileged installer identity.

The candidate first runs in an isolated canary. Production cutover proceeds only after exact release, account, launch, readiness, and zero-pending-outbound proofs. Old releases and backups remain until the monitored acceptance window completes.
