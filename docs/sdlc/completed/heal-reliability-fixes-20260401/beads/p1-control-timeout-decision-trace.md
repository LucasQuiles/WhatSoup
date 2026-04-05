# Decision Trace: p1-control-timeout

## FFT-01: Task Profile
- **Cue 2 fired:** Targeted fix for known defect (unbounded control session)
- **Decision:** REPAIR

## FFT-02: Cynefin Domain
- **Cue 4 fired:** Single file (runtime.ts), <20 lines changed, no new I/O, no exported API change
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
- Timeout behavior correctness → **Decision:** LLM_AGENT

## FFT-09: Hardening Skip
- **Cue 2 fired:** cynefin == CLEAR, budget healthy
- **Decision:** SKIP

## FFT-10: Complexity Source
- **Cue 2 fired:** Timer wiring, not novel business logic
- **Decision:** ACCIDENTAL

## FFT-12: Parallelization
- p1 ↔ p0: Both modify runtime.ts → **Decision:** SERIALIZE (p1 runs after p0)
- p1 ↔ p4: Different files → **Decision:** PARALLELIZE
