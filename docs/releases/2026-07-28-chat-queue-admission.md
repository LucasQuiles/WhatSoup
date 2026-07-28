# 2026-07-28 Chat Queue Admission

## Public surface additions

- Chat `GET /health` responses now include
  `runtime.chat.queue_admission.rejected_total` and `unowned_total`.
  Both values are identifier-free, process-local cumulative counters that reset
  on restart. `unowned_total > 0` degrades health because at least one
  capacity rejection could not be matched to and terminalized against its
  processing inbound row.

## Behavioral changes

- `ChatRuntime.handleMessage()` now returns a bounded admission receipt after it
  observes the real per-chat queue decision. The receipt distinguishes accepted
  work from `queue_full` rejection; it does not claim that admitted processing
  or reply delivery has completed.
- A rejected message with a matching processing inbound row is terminalized as
  `queue_full` before the runtime returns `durableDisposition: "failed"`.
  Missing, stale, mismatched, already-terminal, or write-failed inbound
  ownership fails closed and degrades Chat runtime health.
- Capacity shedding still sends no automatic overload reply and does not retry
  inside the saturated queue. The existing per-chat memory bound and cross-chat
  fairness remain unchanged.
