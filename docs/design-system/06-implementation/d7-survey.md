# D7 Pre-Investigation Survey — deterministic viewport + computed-box tooling

Spike snapshot (2026-06-12) feeding the D7 A0 packet. Verdict: GO.

- Tooling: vitest 3.2.6 with @vitest/browser already in the lockfile; @playwright/test
  not installed (trivial add, Node 24-compatible); CI (quality.yml, ubuntu) can run
  headless. No scripted browser tests exist anywhere today — all browser QA is manual
  session work whose observations are the durable record (qa-hardening fallback rule).
- RECOMMENDATION (labeled): @vitest/browser + playwright provider; browser tests in
  their own subtree with the browser environment pragma; single runner, shared
  conventions, deterministic with single-worker; ~+50MB CI footprint, +30–60s runtime.
- Proof obligations it closes: DD-10 computed-box ≥24px for every interactive primitive
  incl. the removable-Pill pseudo-element hit area (getBoundingClientRect +
  elementFromPoint); the drawer 900px container-query flip; the viewport matrix
  390/768/1024/1280/1440 + short-height per surface; focus-ring visibility.
- D7 packet must define: which assertions are per-primitive vs per-surface; dev-server
  lifecycle ownership (vitest browser mode can own it); flake policy (no arbitrary
  sleeps; findBy* queries); and the rule that browser tests UPGRADE the existing
  class-contract tests' honesty labels rather than replacing them.
