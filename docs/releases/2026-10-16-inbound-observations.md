# 2026-10-16 Inbound Non-Admission Observations

## Public surface additions

- Diagnostic `GET /health` responses now include `inbound_observations` with
  `counts`, `alerts`, and `recorder_failures`. These content-free, process-local
  counters reset on restart. Counts distinguish the closed transport and ingest
  reasons documented in the [runbook](../runbook.md#4-health-endpoint).
  The four `transport.*` reasons cover Baileys only; `ingest.*` reasons
  cover ordinary inbound message persistence and journal failures before dispatch.
  Outbound self-echoes are excluded from both transport and ingest observations.
  Intercepted control-peer messages are excluded from ingest observations;
  transport observations occur before that interception. Storage failures on
  either ingest path remain in the error log; control-message processing
  continues after a control-message storage failure. Zero ingest counters therefore do not prove those writes succeeded.
  Twilio, Signal and iMessage
  do not currently count or alert on an absent inbound callback. Zero transport
  counters do not establish complete admission across those adapters.
- A count records an observed local non-admission attempt, not a unique lost
  message or upstream delivery outcome. Transport redelivery can count again;
  database-recognized duplicates do not. The counters remain advisory and do
  not change `status`, `status_reasons`, or `degradation_causes`.

## Behavioral changes

- `transport.no_consumer` and `ingest.store_failed` emit warning alerts under
  the fixed sources `inbound_no_consumer` and `inbound_store_failed`.
  An accepted emission suppresses repeated alerts for that reason for
  15 minutes on the monotonic clock. Failed or thrown emissions suppress retries
  for one minute, counted from the end of the failed attempt; a later
  observation can retry after that interval. There is no
  background retry timer. The recorder's own log lines are separately limited to
  once per reason every 15 minutes, while the observation counters continue to
  increment; the shared alert emitter still logs one warning for each failed
  outbox write.
- With the default dispatcher settings each source keeps one open warning card.
  Later events of that source are absorbed into it until the next reminder
  (6 hours, then doubling up to 24 hours). Neither source sends a clear; after a
  quiet day the card is closed and reported in the consolidated age-out digest,
  which does not prove that a message was recovered.
- A stored message whose journal call threw is counted as
  `ingest.stored_not_admitted`. The throw proves that dispatch did not go on, not
  that the journal insert failed, so a journal row may still exist for recovery.
- A persistence failure can occur after the message row was written. Its
  observation therefore leaves retention unknown and does not journal or
  replay the message. Recording does not change admission or recovery.
