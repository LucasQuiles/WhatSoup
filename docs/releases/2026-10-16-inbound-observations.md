# 2026-10-16 Inbound Non-Admission Observations

## Public surface additions

- Diagnostic `GET /health` responses now include `inbound_observations` with
  `counts`, `alerts`, and `recorder_failures`. These content-free, process-local
  counters reset on restart. Counts distinguish the closed transport and ingest
  reasons documented in the [runbook](../runbook.md#4-health-endpoint).
  The four `transport.*` reasons cover Baileys only; `ingest.*` reasons
  cover messages reaching the shared ingest path. Twilio, Signal and iMessage
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
  for one minute; a later observation can retry after that interval. There is no
  background retry timer. Log attempts are separately limited to once per reason
  every 15 minutes, while the observation counters continue to increment.
- A persistence failure can occur after the message row was written. Its
  observation therefore leaves retention unknown and does not journal or
  replay the message. Recording does not change admission or recovery.
