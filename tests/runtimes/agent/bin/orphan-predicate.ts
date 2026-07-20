// Portable orphan predicate, shared between the fake-provider fixture (which
// plain `node` runs — the pinned node type-strips .ts imports natively) and
// its lifecycle suite. Extracted so the Linux-subreaper claim is
// unit-testable from macOS, where orphans always reparent to pid 1 and an
// integration test cannot distinguish this predicate from the old
// `process.ppid === 1` check it replaces (B25 2a).
//
// A process's ppid changes only when its parent dies: the kernel reparents
// it to init (pid 1) OR to the nearest child-subreaper (systemd --user — the
// fleet's Linux deploy-gate environment; docker-init; CI shims). So "ppid
// CHANGED from its startup value" is the portable orphan signal — the old
// `ppid === 1` form never fired under a subreaper. `currentPpid === 1`
// additionally covers the startup race where the parent died before the
// startup ppid was recorded (init/launchd never legitimately spawns the
// fixture); under a subreaper that same race falls through to the TTL
// backstop, which is the documented last line either way.
export function isOrphaned(startupPpid: number, currentPpid: number): boolean {
  return currentPpid !== startupPpid || currentPpid === 1;
}
