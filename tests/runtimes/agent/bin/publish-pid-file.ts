// Atomic PID-file publication, shared between the fake-provider fixture
// (which plain `node` runs — the pinned node type-strips .ts imports
// natively) and its lifecycle suite.
//
// The readiness race this closes (B25 2b, observed on the Node 24 CI lane):
// the fixture published its pid file with a bare writeFileSync, so a reader
// polling `existsSync` could observe the created-but-not-yet-written inode
// and JSON.parse would die on "Unexpected end of JSON input". Readiness must
// come from the PUBLICATION side, not the reader: write a sibling temp file
// and renameSync over the target. POSIX rename within one directory is
// atomic, so `existsSync(target) === true` guarantees complete, parseable
// content — the reader needs no retry loop, and a strict parse stays a real
// failure signal instead of being retried into silence.
import { writeFileSync, renameSync } from 'node:fs';

export function publishPidFile(pidFile: string, contents: string): void {
  const tmp = `${pidFile}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, pidFile);
}
