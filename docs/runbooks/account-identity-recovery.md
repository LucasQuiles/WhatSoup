# Account identity recovery alerts

For `claude-cli` instances with a ratified `service.expectedAccountDigest`,
`credential_identity_mismatch` reports a different account and
`credential_identity_unverifiable` reports an identity that could not be
established. The verifier observes identity; it does not repair credentials or
change the configured account. Follow the existing
[service-context identity procedure](macos-launchd-deployment.md#ratified-account-identity-in-the-service-context)
when an owner needs to correct the account.

Startup and model-recovery checks inspect credential stores without copying or
deleting credentials. A matching account digest does not authorize a credential
copy. For a non-default credential store, the detector reads the selected keychain
service and reports a second plaintext store without changing it. The CLI probe
separately establishes usability.

The default plaintext-store reader accepts at most 1 MiB through the shared
private-file observation. It requires current-user ownership and private file
and parent permissions, rejects symlink ancestors, hard links and nonregular
files, and checks file identity through the read. Unsafe or changed files return
`skipped-error`; this is inconclusive detection, not proof that the second store
is absent. A missing file remains an ordinary absent-store result. The detector
does not repair permissions, rewrite credentials or change the CLI's own reader.

Serving turns, identity checks and diagnostic/model probes preserve both
`CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. A defined secure-storage
setting takes precedence, including an empty value that selects the CLI default.
Keep these settings consistent in the instance's service environment. A duplicate
store warning requires an operator decision; it does not perform account repair.

The detector refuses to inspect the default credential store, which can belong to
the operator or another job. It returns `skipped-no-config-dir` without reading
either store when neither selector is set or the secure-storage override is empty,
even if `CLAUDE_CONFIG_DIR` names an instance directory. This result supplies no
duplicate-store evidence. Identity and usability probes still use the configured
CLI default. Duplicate-store detection requires a nonempty instance-specific
credential-store selector in the service environment.

A new matching verification attempts a durable BOT ERRORS clear for each pending
identity source. Each process starts with both sources pending so incidents from
a prior process can recover. A successful outbox write retires only that source;
a failed write remains pending until a later matching verification retries it.
Partial success therefore retries only the outstanding source. A new mismatch or
unverifiable result makes its source pending again.

The identity receipt and the recovery publication have separate outcomes. A
`match` in health or the `account identity verified` log proves the observed
identity matched the configured digest; it does not prove the clear was queued
or delivered. Clears are requested with `requireDurableOutbox`, so they write
the outbox directly and never fall back to the legacy helper or the
`WHATSOUP_ALERT_SINK` capture file. A failed clear write produces the existing
`bot-errors strict clear outbox write failed` warning. Any result other than
`true` from an injected clear port, including an undefined return, leaves the
source pending. Durable queuing still does not prove WhatsApp delivery; the
dispatcher owns delivery acknowledgement.

If health reports a match while an identity incident remains open, inspect the
outbox write warning and dispatcher receipts before declaring recovery. Once the
outbox can accept writes, the next ordinary matching identity verification
retries the pending clear. Cached health evidence does not trigger a retry;
an in-flight, failed, or unverifiable probe cannot resolve the incident. A restart
re-arms both sources and still requires a new match. Shutdown, disabled identity
verification, and a different provider do not clear identity incidents.

The retry schedule is the existing startup, manual, and periodic identity probe
seam. This recovery bookkeeping adds no timer, no credential mutation, and no
new account-selection authority. It does not change the existing identity
receipt freshness policy.

Identity freshness uses the scheduled probe deadline and its bounded execution
grace, including while the fired periodic usability probe is still pending.
Clearing the timer when it fires must not shorten that deadline to the idle
30-minute limit. A probe that exceeds the deadline and grace still makes the
old identity receipt stale; a returned mismatch is reported immediately.
