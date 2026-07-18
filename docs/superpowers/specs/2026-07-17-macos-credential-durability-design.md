# macOS Credential Durability Design

## Context

The shared credential resolver currently consults the macOS Keychain before its
private file store. A launchd process can block inside `security` when the login
Keychain cannot present UI, and a request-time credential lookup can repeat the
same warning for every health poll. macOS fleet hosts also keep a canonical
per-instance health token in a mode-0600 `tokens.env` file, while some older
launchd units duplicate that token in their environment.

This change makes the private-file and Keychain paths bounded and explicit
without weakening per-instance credential isolation.

## Resolution Contract

Unscoped `lookupCredential(service)` calls use this order:

1. The mapped process environment variable, unless `skipEnv` is set.
2. The strict private file
   `$XDG_CONFIG_HOME/whatsoup/credentials/<service>.key`.
3. The platform Keychain or `secret-tool`, including configured migration
   aliases.
4. The existing terminal OpenCode credential fallback.

User-scoped calls use this order:

1. The account-specific platform Keychain or `secret-tool` entry.
2. The mapped process environment variable when allowed.
3. The existing terminal OpenCode credential fallback.

A user-scoped lookup must never consult the unscoped `<service>.key` file. The
file has no account dimension and therefore cannot safely satisfy a
per-instance lookup.

Every synchronous `security` and `secret-tool` invocation uses a 3,000 ms
timeout and `SIGKILL` as its kill signal. This includes backend detection,
reads, writes, and deletes.

## Private Credential Files

The resolver reuses the hardened private-file primitives rather than raw
`readFileSync`, predictable temporary filenames, or unchecked `unlinkSync`.
Credential files must be regular, non-symlink files under a real private
directory; reads are bounded to 4,096 bytes and reject unsafe permissions.
Writes use an exclusive sibling temporary file, mode 0600, `fsync`, and an
atomic same-directory rename. Deletes reject symlinks and non-regular paths.

On macOS, only unscoped `writeCredential` and `deleteCredential` operations use
the dual store:

- A write updates the Keychain and then atomically mirrors the value into the
  private file. If the mirror fails after the Keychain update, the resolver
  attempts to remove any file shadow and returns a sanitized write failure.
- A delete attempts both the Keychain deletion and private-file removal. It
  reports `deleted: true` only when the Keychain delete succeeds and the file is
  absent afterward. Absence remains non-exceptional.
- User-scoped writes and deletes remain Keychain-only so one account cannot
  overwrite another account through an unscoped file.

No error or log record may include a credential value, child-process stdin, or
raw child-process payload containing the value.

## launchd Wrapper Contract

The service wrapper resolves the health token in this order:

1. An already-loaded `WHATSOUP_HEALTH_TOKEN` value.
2. The canonical per-instance
   `$XDG_CONFIG_HOME/whatsoup/instances/<instance>/tokens.env` file.
3. The account-specific canonical Keychain entry.
4. The legacy shared Keychain entry during migration.

The per-instance file is read through the existing descriptor-safe design:
bounded content, no-follow open, ownership and mode checks, file/directory
identity checks, and canonical single-assignment parsing. An unsafe existing
file fails startup without disclosing its value. A missing file proceeds to the
bounded Keychain fallback.

The macOS wrapper invokes `security` through the pinned Node runtime with a
3,000 ms timeout, `SIGKILL`, bounded output, and ignored stderr. Credential
values never appear in process arguments. Linux retains `timeout 3s` around
`secret-tool`.

The wrapper change preserves the existing startup preflight and database
compatibility ordering. The native OAuth credential-heal path is out of scope
and remains Keychain-first.

## Warning Control

The resolver records services whose primary Keychain read failure has already
been logged. It emits at most one `keyring read failed` warning per service per
process while still performing subsequent lookups and fallbacks. Backend-probe
downgrade alarms retain their existing behavior.

This is noise control only: it does not suppress service health alarms,
restart alarms, or credential lookup attempts.

## Verification

Tests must prove:

- Unscoped environment and private-file hits short-circuit Keychain access.
- User-scoped lookups remain account-specific and never read an unscoped file.
- Every `security` and `secret-tool` execution is bounded by 3,000 ms with
  `SIGKILL` where Node owns the child.
- macOS unscoped writes and deletes mirror/remove the private file, while
  scoped mutations do not.
- Partial dual-store failures return truthful sanitized results and do not
  leave an authoritative stale file in the tested cleanup path.
- Repeated failures warn once per service while distinct services each warn.
- The wrapper accepts a safe canonical `tokens.env`, rejects unsafe or malformed
  files without disclosure, short-circuits Keychain access on an environment or
  file hit, and kills a hanging macOS Keychain read within the bound.
- The focused test set is run with Vitest's fork pool, followed by typechecking,
  test-integrity scanning, repository guards, and an independent branch review.

Runtime deployment remains behind the owner hold point. One controlled restart
must produce a single PID transition, exactly one legitimate online notice,
zero duplicate or queued replays within the five-minute cooldown, an empty
outbound queue, resumed watchdog checks, and a health-token warning rate near
zero compared with the measured pre-change rate.

## Fleet Follow-Ons

After the wrapper is deployed, older macOS launchd units that duplicate the
health token in their environment should migrate to the descriptor-safe
per-instance file path. A fleet-wide stale-`.key` audit must precede enabling
file-first resolution on each host. These fleet mutations, monitoring changes,
and credential rotations remain behind their separately named owner hold
points.
