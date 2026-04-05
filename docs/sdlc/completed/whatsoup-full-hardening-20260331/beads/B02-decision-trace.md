# Decision Trace: B02-chatruntime-send-retry

## FFT-01: Task Profile
- **Cue 2 fired:** Targeted fix for known defect (P1-11 audit finding)
- **Result:** REPAIR

## FFT-02: Cynefin Domain
- **Cue 4:** No — touches runtime.ts, adds retry logic, new async pattern
- **Cue 5:** No — single file change with test
- **Default:** COMPLICATED

## FFT-08: Deterministic Check Routing
- `vitest-full-suite` → DETERMINISTIC
- `typecheck` → DETERMINISTIC

## FFT-10: Complexity Source
- Send retry with durability integration = real business logic, data loss prevention
- **Result:** ESSENTIAL
