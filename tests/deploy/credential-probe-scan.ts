import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// The credential-store probe scanner used by credential-probe-boundedness.test.ts.
// It lives in its own module so that test file stays under the 2,000-line cap.

/**
 * Every tracked shell file, repo-wide — not just deploy/. A new script anywhere
 * that reaches for a credential store has to be bounded too, and scoping the
 * scan to one directory would let that regression land silently.
 */
export function trackedShellFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => f.endsWith('.sh') || f === 'deploy/whatsoup');
}

/**
 * Matches `security`/`secret-tool` in *command position* — start of line, or
 * after a pipe/`&&`/`;`/subshell open. Occurrences inside echoed help text and
 * comments sit mid-line and are correctly ignored.
 *
 * The optional `timeout`/`gtimeout` prefix catches the shape bounded by hand,
 * `timeout 3s secret-tool …`, where the `timeout` and not the credential command
 * holds command position. That shape fails on a host without `timeout(1)`, and a
 * bare `timeout` only sends SIGTERM, so it must route through
 * `whatsoup_run_bounded` too.
 */
const COMMAND_POSITION =
  /(?:^|[|&;(]|\bthen\b|\bdo\b|\bif\b|\belif\b|!)\s*(?:(?:timeout|gtimeout)(?:\s+[^\s;|&()]+)*\s+)?(security|secret-tool)\s/;

/**
 * True when the character at `index` sits inside a quoted string of the command
 * context it executes in. `$(` opens a command substitution whose contents run as
 * a separate command, so quoting inside it does not depend on the surrounding
 * line: in `value="$(timeout 3s secret-tool …)"` the credential command holds
 * command position inside the substitution, although a plain count of the quotes
 * before it sees the assignment's opening `"`. Inside single quotes `$(` is
 * literal text, so it does not open a substitution there.
 */
function insideQuotedString(code: string, index: number): boolean {
  let single = false;
  let double = false;
  let subst = 0;
  for (let i = 0; i < index; i++) {
    const ch = code[i];
    const opensSubst = ch === '(' && code[i - 1] === '$';
    if (subst > 0) {
      if (opensSubst) subst += 1;
      else if (ch === ')') subst -= 1;
    } else if (single) {
      if (ch === "'") single = false;
    } else if (double) {
      if (ch === '"') double = false;
      else if (opensSubst) subst += 1;
    } else if (ch === "'") single = true;
    else if (ch === '"') double = true;
    else if (opensSubst) subst += 1;
  }
  return subst === 0 && (single || double);
}

/** Lines of `file` that call `security` or `secret-tool` without `whatsoup_run_bounded`. */
export function unboundedProbes(file: string): string[] {
  const findings: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const code = line.replace(/^\s*#.*$/, '');
    const match = COMMAND_POSITION.exec(code);
    if (!match) return;
    // A match sitting inside a quoted string is data/help text, not a call.
    // A `timeout 3s` prefix can put the command name after the regex anchor, so
    // the quote state is measured at the command name itself.
    const commandIndex = match.index + match[0].indexOf(match[1]);
    if (insideQuotedString(code, commandIndex)) return;
    // `command -v security` only asks whether the binary exists; it cannot block.
    if (/command\s+-v\s+(security|secret-tool)\b/.test(code)) return;
    if (code.includes('whatsoup_run_bounded')) return;
    findings.push(`${file}:${index + 1}: ${line.trim()}`);
  });
  return findings;
}
