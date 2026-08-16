# Loop-Lag Forensic Collector

Use this collector to capture content-free event-loop observations from one local WhatSoup instance. Samples are evidence for later correlation; they do not identify a blocking call by themselves.

## Preconditions

- Run as the same user that owns the instance health-token file and output directory.
- Poll only the instance's loopback HTTP port.
- Keep the token file mode `0600` in an owner-controlled directory. The collector has no literal-token flag and no environment fallback.
- Use an interval no greater than 150 seconds. The physical 360-sample ring spans about 180 seconds at the 500ms cadence, but the supported contract reserves the final ~30 seconds for jitter, request latency, and draining paginated results. Intervals above 150 seconds are treated as gap-guaranteed.

## Discover the contract

Use `--silent` so npm does not prepend its human-readable banner to the JSON stream:

```bash
npm --silent run loop-lag-samples:schema
```

The schema describes commands, effects, endpoint and record versions, and exit codes. It performs no credential read or network access.

## Capture

One snapshot:

```bash
npm --silent run loop-lag-samples -- collect \
  --instance <instance> \
  --base-url http://127.0.0.1:<port> \
  --token-file <absolute-private-token-file> \
  --output <absolute-private-jsonl-path> \
  --once --limit 160 --format json
```

Timed capture:

```bash
npm --silent run loop-lag-samples -- collect \
  --instance <instance> \
  --base-url http://127.0.0.1:<port> \
  --token-file <absolute-private-token-file> \
  --output <absolute-private-jsonl-path> \
  --interval-ms 60000 --duration-ms 900000 \
  --limit 160 --format json
```

The default artifact cap is 50 MiB. The parent is forced to mode `0700`; the JSONL file is mode `0600`. Retention keeps only complete validated records. Do not place the output in the release checkout or use the token file as the output path.

## Interpret records and exits

- `sample`: one process-incarnation sequence with monotonic and wall timestamps.
- `gap(cursor_evicted)`: required samples left the ring before capture.
- `gap(process_changed)`: the producer restarted; the collector reset to cursor zero and refetched the new incarnation.
- `gap(poll_interval_missed)`: a scheduled poll began after its next boundary.
- `poll_error`: bounded class/status/retryability only; response bodies and exception prose are excluded.
- `run_completed`: terminal counts and outcome.

Exit `0` means at least one successful poll and no gap/error. Exit `1` is partial evidence. Exit `2` is invalid or unsafe input, `3` authentication failure, `4` incompatible/unsupported endpoint, `5` no successful poll, and `6` output creation, append, retention, or finalization failure. Nonzero evidence can still contain useful samples, but it must not be described as continuous.

Inspect metadata without exposing token material or message content:

```bash
python3 -c 'import json,sys; [print(json.loads(line)["record_type"]) for line in sys.stdin if line.strip()]' \
  < <absolute-private-jsonl-path>
```

## Restart, cleanup, and custody

A later run recovers only a validated terminal cursor from the private artifact. A malformed, unsupported, unreadable, non-private, or partial prior tail fails closed before network access. Process changes and cursor eviction remain explicit gaps rather than being healed silently.

Retain the only evidence copy until correlation and owner review are complete. Cleanup is a separate operator action: first make a byte-verified private copy, then remove the original only under the owning incident's retention decision. Never delete release backups or migration rollback assets as part of collector cleanup.
