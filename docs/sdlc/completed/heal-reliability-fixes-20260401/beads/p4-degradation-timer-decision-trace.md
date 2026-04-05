# Decision Trace: p4-degradation-timer

## FFT-01: Task Profile
- **Cue 2 fired:** Targeted fix for known defect (unwired function)
- **Decision:** REPAIR

## FFT-02: Cynefin Domain
- **Cue 4 fired:** Single file (main.ts), <10 lines changed, no new I/O, no exported API change
- **Decision:** CLEAR, security_sensitive: false

## FFT-04: Phase Configuration
- **Cue 2 fired:** profile == REPAIR
- **Decision:** Frame: SKIP, Scout: MINIMAL, Architect: SKIP, Execute: normal, AQS: resilience_only, Harden: normal

## FFT-05: Loop Depth
- **Cue 3 fired:** cynefin == CLEAR, budget assumed healthy
- **Decision:** L0 only

## FFT-08: Check Routing
- `npm run typecheck` → **Decision:** DETERMINISTIC
- `npx vitest run --pool=forks` → **Decision:** DETERMINISTIC

## FFT-09: Hardening Skip
- **Cue 2 fired:** cynefin == CLEAR, budget healthy
- **Decision:** SKIP

## FFT-10: Complexity Source
- **Cue 2 fired:** Timer wiring (framework plumbing), not novel business logic
- **Decision:** ACCIDENTAL

## FFT-12: Parallelization
- p4 ↔ p0: Different files (main.ts vs runtime.ts) → **Decision:** PARALLELIZE
- p4 ↔ p1: Different files → **Decision:** PARALLELIZE
