# Decision Trace: B03-trivial-p2-fixes

## FFT-01: Task Profile
- **Cue 2 fired:** Targeted fixes for known defects (P2-17, P2-19, P2-21)
- **Result:** REPAIR

## FFT-02: Cynefin Domain
- **Cue 4 fired:** 3 files, <50 lines total, no new I/O, no exported API change
- **Result:** CLEAR

## FFT-08: Deterministic Check Routing
- `vitest-full-suite` → DETERMINISTIC
- `typecheck` → DETERMINISTIC

## FFT-10: Complexity Source
- Log message fixes + SQL chunking = framework boilerplate
- **Result:** ACCIDENTAL
