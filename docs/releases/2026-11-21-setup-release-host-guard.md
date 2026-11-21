# `deploy/setup.sh` on a release host

`deploy/setup.sh` used to repoint `~/.local/bin/whatsoup`, and on macOS
re-render the timer plists, to whatever tree it ran from. On a host whose bot
runs a release export, that moved the bot at its next restart without
`release:activate`'s checks, backup and rollback. This is a behaviour change to
the stable `deploy:setup.sh` surface.

## Behaviour changes

Once `~/.local/bin/whatsoup` exists, step 3 and, on macOS, step 4 exit `2`
unless this tree is the one the wrapper already runs, reached through the path
it names, or both trees are git checkouts. A wrapper that does not resolve to
an existing `deploy/whatsoup` is refused too. The first check runs before the
preflight; each step checks again when it starts. A first install with no
wrapper is not affected.

Each `~/.local/bin` link is now replaced by renaming a new link over it. A
directory at a link name is refused, and each link is read back.

## Public surface additions

- `--skip-wrappers`, `--wrappers-only`, `--timers-only` and `--npmrc-only`
  select steps 3, 4 and 5. With any of the last three, step 2 (dependencies),
  step 6 (console build) and step 7 (key check) do not run; the preflight and
  step 1 always run. `--wrappers-only` and `--skip-wrappers` cannot be combined.
- `--switch-release-tree` (Linux only, default run only) switches a host whose
  wrapper resolves to another tree to this tree on purpose, printing the old and
  new wrapper target and the rollback command first. On Linux, where
  `release:activate` refuses, it replaces the plain default run that switched
  trees before this change.

## Migration

- macOS: move a release host with `release:activate`, then run
  `deploy/setup.sh --wrappers-only` from the active release to move the helper
  links.
- Linux: add `--switch-release-tree` to the setup run that switches trees. The
  procedure, with the units to stop and the checks after, is in
  [release-deployment.md](../runbooks/release-deployment.md#switching-a-linux-host-to-another-tree).
- A release exported before this change has neither the guard nor the flags. Its
  `setup.sh` rejects them as unknown options, and its plain default run switches
  the host without any check.
