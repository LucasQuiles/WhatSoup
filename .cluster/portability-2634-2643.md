# Portability Cluster: ps-flags + signal-name abstraction

## Cluster Members
- **#2634** — portability: non-portable shell shebangs and ps flags in deploy scripts
  - **Remaining scope**: ps-flags component (shebang component was fixed by merged PR #2636)
  - Deploy scripts use non-portable `ps` command flags (e.g., `ps aux` BSD/GNU differences)
- **#2643** — portability: signal-name abstraction for cross-platform child process management
  - 7 call sites use hardcoded POSIX signal strings (`SIGKILL`, `SIGTERM`) in `child.kill()` calls
  - Requires abstraction layer to decouple from POSIX-specific signal API

## Related PRs
- **#2631** — feat(fitness): portability enforcement rules (provides ESLint DETECTION via `portability.hardcoded-signal-name` rule; does not provide the ABSTRACTION this cluster implements)

## Implementation Plan
1. **ps-flags abstraction (#2634 remaining scope)**:
   - Create `src/lib/portability/ps-flags.ts` — platform-aware ps command builder
   - Replace hardcoded `ps aux` / `ps -eo` calls in deploy scripts with abstracted helper
   - Add tests for BSD/macOS and GNU/Linux ps flag compatibility

2. **Signal-name abstraction (#2643)**:
   - Create `src/lib/portability/signals.ts` — platform-agnostic signal constants
   - Replace 7 hardcoded `SIGKILL`/`SIGTERM` string literals with abstracted constants
   - Wire into the enforcement framework (#2631) as the remediation path for `portability.hardcoded-signal-name`

## Coverage
This draft PR establishes cluster coverage for issues #2634 and #2643, which had no
prior active closing directive after PR #2636's directives were stripped at merge
(shebang component only). The detection framework from #2631 identifies the patterns;
this cluster implements the actual fixes.
