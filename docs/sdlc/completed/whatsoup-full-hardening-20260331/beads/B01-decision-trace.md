# Decision Trace: B01-fix-test-failures

## FFT-01: Task Profile
- **Cue 2 fired:** Targeted fix for failing tests (known defect in test mocks/assertions)
- **Result:** REPAIR

## FFT-02: Cynefin Domain
- **Cue 4 fired:** Test files only, <50 lines expected, no new I/O, no exported API change
- **Result:** CLEAR

## FFT-08: Deterministic Check Routing
- `vitest-full-suite` → DETERMINISTIC (`npx vitest run`)
- `typecheck` → DETERMINISTIC (`npx tsc --noEmit`)

## FFT-10: Complexity Source
- Test mock updates and assertion alignment = framework boilerplate
- **Result:** ACCIDENTAL
