# Decision Trace: p0-zombie-sessions

## FFT-01: Task Profile
- **Cue 2 fired:** Targeted fix for known bug (zombie session accumulation)
- **Decision:** REPAIR

## FFT-02: Cynefin Domain
- **Cue 4 fired:** Single file (runtime.ts), <20 lines changed, no new I/O, no exported API change
- **Decision:** CLEAR, security_sensitive: false

## FFT-04: Phase Configuration
- **Cue 2 fired:** profile == REPAIR
- **Decision:** Frame: SKIP, Scout: MINIMAL, Architect: SKIP, Execute: normal, AQS: resilience_only, Harden: normal

## FFT-05: Loop Depth
- **Cue 3 fired:** cynefin == CLEAR, budget assumed healthy (first task in this area)
- **Decision:** L0 only (runner self-check, auto-advance)

## FFT-08: Check Routing
- `npm run typecheck` → **Decision:** DETERMINISTIC (binary pass/fail)
- `npx vitest run --pool=forks` → **Decision:** DETERMINISTIC (binary pass/fail)
- Session lifecycle correctness → **Decision:** LLM_AGENT (requires reasoning about state machine behavior)

## FFT-09: Hardening Skip
- **Cue 2 fired:** cynefin == CLEAR, budget healthy
- **Decision:** SKIP

## FFT-10: Complexity Source
- **Cue 1 fired:** Fixing session lifecycle state machine (essential complexity — state ownership bug)
- **Decision:** ESSENTIAL

## FFT-12: Parallelization
- p0 ↔ p1: Both modify runtime.ts → **Decision:** SERIALIZE (p0 first, p1 second)
- p0 ↔ p4: Different files (runtime.ts vs main.ts) → **Decision:** PARALLELIZE
