# Release Snapshot Deployment

Status: active

This runbook defines the source-controlled release-snapshot workflow. It is a
contract for planning, reviewing, and verifying a release. It is not approval to
mutate a live host.

## Boundaries

- A source PR merge proves source durability only. It does not update any live
  release directory, plist, service, or WhatsApp runtime.
- A release re-cut is a separate live operation. It needs named approval in the
  current turn before touching a release directory or service manager.
- The dry-run planner does not copy files, edit launchd plists, restart
  services, delete old snapshots, send WhatsApp messages, or emit live alerts.
- Hot-patched release snapshots are evidence. They are not canonical source.

## Snapshot Manifest

Every new release snapshot must have a manifest named
`.whatsoup-release-manifest.json` at the release root. The manifest records:

- `schemaVersion`
- source ref and commit
- release path
- build timestamp
- mutable-path exclusions
- rollback snapshot path
- tracked file paths, byte sizes, and SHA-256 hashes

Mutable paths are excluded from code-drift comparison because they are expected
to differ between a source tree and a running release. Examples include
`node_modules/**`, logs, SQLite databases, auth directories, local artifacts,
and the release manifest itself.

## Dry-Run Planning

Generate a deterministic plan before a re-cut:

```bash
npm --silent run release:snapshot -- \
  --release-root "$HOME/LAB" \
  --source-ref HEAD \
  --json
```

The plan enumerates:

- rollback preparation
- release directory creation
- each tracked file copy
- manifest write path
- the approval boundary for launchd/service mutation

The planner has no apply mode. If an operator turns the plan into live actions,
that live step must be approved separately and should preserve instance config,
auth, logs, DBs, token files, and keychain material outside the release tree.

## Drift Detection

Use the manifest to compare a release snapshot against the source commit used
to build it. A code edit inside a release snapshot is drift. Mutable state under
the manifest's exclusion list is not code drift.

Run the check in read-only mode:

```bash
npm --silent run release:snapshot -- \
  --check-release "$HOME/LAB/WhatSoup-release-<commit>" \
  --json
```

The command exits `0` when the release matches its manifest and exits nonzero
when files are missing, changed, or unexpectedly present. It reads the manifest
from `.whatsoup-release-manifest.json` inside the release by default; use
`--manifest /absolute/path/to/manifest.json` only when auditing an archived
manifest separately from its release directory.

Drift findings mean the release is no longer a faithful copy of reviewed source.
They do not by themselves authorize deleting the release or replacing it. Decide
whether to port the lesson back to source, re-cut from merged source, or roll
back to the prior release path.

## Live Acceptance

After a separately approved re-cut:

1. Capture the source commit, release path, and manifest path.
2. Repoint the service manager only after rollback is prepared.
3. Restart the target service.
4. Capture `/health`.
5. Send a scoped live turn only if approved.
6. Confirm no raw provider diagnostic text is sent to a user.
7. Confirm fallback/health behavior for a bogus model only if that mutation is
   separately approved.
8. Revert any temporary config change and confirm health recovery.

Until this acceptance is complete, do not claim the live instance is protected by
new source changes.
