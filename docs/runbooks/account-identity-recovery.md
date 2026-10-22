# Account identity recovery alerts

For `claude-cli` instances with a ratified `service.expectedAccountDigest`,
`credential_identity_mismatch` reports a different account and
`credential_identity_unverifiable` reports an identity that could not be
established. The verifier observes identity; it does not repair credentials or
change the configured account. Follow the existing
[service-context identity procedure](macos-launchd-deployment.md#ratified-account-identity-in-the-service-context)
when an owner needs to correct the account.

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
