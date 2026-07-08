import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkServiceUnits,
  parsePlist,
  readCanonicalNodeMajor,
  run,
  type ViolationCode,
} from '../../scripts/check-service-units.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Build a tmp repo with a .nvmrc (canonical major) and a deploy/ dir holding
 * the provided unit files (keyed by filename → contents).
 */
function makeRepo(units: Record<string, string>, nvmrc = '24.15.0'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-svc-units-'));
  writeFileSync(path.join(dir, '.nvmrc'), `${nvmrc}\n`, 'utf8');
  mkdirSync(path.join(dir, 'deploy'), { recursive: true });
  for (const [name, body] of Object.entries(units)) {
    writeFileSync(path.join(dir, 'deploy', name), body, 'utf8');
  }
  return dir;
}

const GOOD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whatsoup.reply-guarantee</string>
  <key>ProgramArguments</key>
  <array>
    <string>__HOME__/.local/bin/whatsoup-reply-guarantee-drain</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>__HOME__/Library/Logs/whatsoup/reply-guarantee.log</string>
  <key>StandardErrorPath</key>
  <string>__HOME__/Library/Logs/whatsoup/reply-guarantee.err.log</string>
</dict>
</plist>
`;

function plist(opts: {
  filename: string;
  label?: string;
  programArguments?: string[];
  extraStrings?: { key: string; value: string }[];
}): { name: string; body: string } {
  const label = opts.label ?? path.basename(opts.filename, '.plist');
  const args = opts.programArguments ?? [
    '__HOME__/.local/bin/whatsoup-reply-guarantee-drain',
  ];
  const argLines = args.map((a) => `    <string>${a}</string>`).join('\n');
  const extra = (opts.extraStrings ?? [])
    .map((e) => `  <key>${e.key}</key>\n  <string>${e.value}</string>`)
    .join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
${extra}
</dict>
</plist>
`;
  return { name: opts.filename, body };
}

const codes = (cwd: string): ViolationCode[] =>
  checkServiceUnits({ cwd, skipPlutil: true }).violations.map((v) => v.code);

describe('check-service-units guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('passes on the real committed deploy/ units (templates are defect-free)', () => {
    const result = checkServiceUnits({ cwd: repoRoot, skipPlutil: true });
    expect(result.scanned.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it('keeps agent instance units independent of graphical-session.target', () => {
    const unit = readFileSync(path.join(repoRoot, 'deploy/whatsoup@.service'), 'utf8');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/(?:Wants|After|WantedBy)=.*graphical-session\.target/);
  });

  it('reads the canonical node major from .nvmrc', () => {
    expect(readCanonicalNodeMajor(repoRoot)).toBe(24);
  });

  it('passes a canonical good plist', () => {
    const dir = makeRepo({ 'com.whatsoup.reply-guarantee.plist': GOOD_PLIST });
    expect(codes(dir)).toEqual([]);
  });

  it('fails on a Label / filename-stem mismatch (label split)', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      label: 'com.whatsoup.whatsoup-fleet',
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('label-mismatch');
  });

  it('fails on a bare /opt/homebrew/bin/node interpreter', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet-console.plist',
      programArguments: [
        '/opt/homebrew/bin/node',
        '/Users/testuser/app/console.mjs',
      ],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('bare-homebrew-node');
  });

  it('fails on an unexpanded ${VAR} in a plist <string> value', () => {
    const p = plist({
      filename: 'com.whatsoup.reply-guarantee.plist',
      extraStrings: [
        { key: 'WorkingDirectory', value: '${WHATSOUP_REPO_ROOT}' },
        {
          key: 'StandardOutPath',
          value: '${HOME}/Library/Logs/whatsoup/out.log',
        },
      ],
    });
    const dir = makeRepo({ [p.name]: p.body });
    const found = codes(dir);
    expect(found).toContain('unexpanded-var-in-plist');
  });

  it('fails on /usr/bin/env node where a pinned path is required', () => {
    const p = plist({
      filename: 'com.whatsoup.reply-guarantee.plist',
      programArguments: [
        '/usr/bin/env',
        'node',
        'deploy/hooks/drain-stuck-replies.mjs',
      ],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('env-node-where-pinned-required');
  });

  it('fails on a node path pinned to the wrong major', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      programArguments: [
        '/Users/testuser/.nvm/versions/node/v26.0.0/bin/node',
        '/Users/testuser/app/fleet.mjs',
      ],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('node-pin-mismatch');
  });

  it('fails on a Homebrew Cellar node path (unrecognized binary, closed-world)', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      programArguments: [
        '/opt/homebrew/Cellar/node/26.1.0/bin/node',
        '/Users/testuser/app/fleet.mjs',
      ],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('bare-homebrew-node');
  });

  it('fails on a /usr/bin/node system node path (closed-world)', () => {
    const dir = makeRepo({
      'whatsoup-fleet.service': `[Service]
ExecStart=/usr/bin/node /home/testuser/app/fleet.mjs
`,
    });
    expect(codes(dir)).toContain('bare-homebrew-node');
  });

  it('fails on a shell-wrapper that smuggles bare node via -c (plist)', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      programArguments: ['/bin/bash', '-c', 'node /Users/testuser/app/fleet.mjs'],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('bare-homebrew-node');
  });

  it('fails on a shell-wrapper smuggling node via -c (systemd)', () => {
    const dir = makeRepo({
      'whatsoup-fleet.service': `[Service]
ExecStart=/bin/bash -c "node /home/testuser/app/fleet.mjs"
`,
    });
    expect(codes(dir)).toContain('bare-homebrew-node');
  });

  it('fails on env-bash wrapping a wrong-major Cellar node', () => {
    const dir = makeRepo({
      'whatsoup-fleet.service': `[Service]
ExecStart=/usr/bin/env bash -c "/opt/homebrew/Cellar/node/26.0.0/bin/node app.mjs"
`,
    });
    expect(codes(dir)).toContain('bare-homebrew-node');
  });

  it('does NOT flag the whatsoup-ensure-node wrapper as a node binary', () => {
    const dir = makeRepo({
      'whatsoup-fleet.service': `[Service]
ExecStartPre=%h/.local/bin/whatsoup-ensure-node
ExecStart=%h/.local/bin/whatsoup-fleet 9099
`,
    });
    expect(codes(dir)).toEqual([]);
  });

  it('accepts a correctly-pinned nvm node path', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      programArguments: [
        '/Users/testuser/.nvm/versions/node/v24.15.0/bin/node',
        '/Users/testuser/app/fleet.mjs',
      ],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toEqual([]);
  });

  it('fails on a non-absolute ProgramArguments[0]', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      programArguments: ['relative/path/node', 'app.mjs'],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('non-absolute-path');
  });

  it('fails on a structurally invalid plist', () => {
    const dir = makeRepo({
      'com.whatsoup.broken.plist': '<plist version="1.0"><dict><key>Label</key>',
    });
    expect(codes(dir)).toContain('invalid-plist-structure');
  });

  // --- systemd units ---

  it('passes a canonical systemd unit using a wrapper specifier', () => {
    const dir = makeRepo({
      'whatsoup-reply-guarantee.service': `[Unit]
Description=drain
[Service]
Type=oneshot
ExecStart=%h/.local/bin/whatsoup-reply-guarantee-drain
`,
    });
    expect(codes(dir)).toEqual([]);
  });

  it('fails a systemd unit that execs bare homebrew node', () => {
    const dir = makeRepo({
      'whatsoup-fleet.service': `[Unit]
Description=fleet
[Service]
ExecStart=/opt/homebrew/bin/node /home/testuser/app/fleet.mjs
`,
    });
    expect(codes(dir)).toContain('bare-homebrew-node');
  });

  it('fails a systemd unit that uses /usr/bin/env node', () => {
    const dir = makeRepo({
      'whatsoup-fleet.service': `[Service]
ExecStart=/usr/bin/env node /home/testuser/app/fleet.mjs
`,
    });
    expect(codes(dir)).toContain('env-node-where-pinned-required');
  });

  it('accepts a bare install-token as a whole-path WorkingDirectory', () => {
    const { name, body } = plist({
      filename: 'com.whatsoup.reply-guarantee.plist',
      extraStrings: [{ key: 'WorkingDirectory', value: '__WHATSOUP_REPO_ROOT__' }],
    });
    const dir = makeRepo({ [name]: body });
    expect(codes(dir)).not.toContain('non-absolute-path');
  });

  it('ignores commented-out example $HOME / ${VAR} in plist comments', () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- example: sed "s|__HOME__|$HOME|g" and beware \${VAR} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whatsoup.reply-guarantee</string>
  <key>ProgramArguments</key>
  <array>
    <string>__HOME__/.local/bin/whatsoup-reply-guarantee-drain</string>
  </array>
</dict>
</plist>
`;
    const dir = makeRepo({ 'com.whatsoup.reply-guarantee.plist': body });
    expect(codes(dir)).toEqual([]);
  });

  // --- baseline ---

  it('suppresses a violation listed in the baseline', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      label: 'com.whatsoup.whatsoup-fleet',
    });
    const dir = makeRepo({ [p.name]: p.body });
    const baseline = new Set(['deploy/com.whatsoup.fleet.plist::label-mismatch']);
    const result = checkServiceUnits({ cwd: dir, skipPlutil: true, baseline });
    expect(result.violations).toEqual([]);
    expect(result.suppressed.map((v) => v.code)).toContain('label-mismatch');
  });

  it('gives distinct baseline keys to repeated violations of the same code in one file', () => {
    const p = plist({
      filename: 'com.whatsoup.reply-guarantee.plist',
      extraStrings: [
        { key: 'WorkingDirectory', value: '${WHATSOUP_REPO_ROOT}' },
        { key: 'StandardOutPath', value: '${HOME}/Library/Logs/out.log' },
      ],
    });
    const dir = makeRepo({ [p.name]: p.body });
    const result = checkServiceUnits({ cwd: dir, skipPlutil: true });
    const varViolations = result.violations.filter(
      (v) => v.code === 'unexpanded-var-in-plist',
    );
    expect(varViolations.length).toBe(2);
    // Keys must be distinct so one baseline entry cannot mask both.
    const keys = new Set(varViolations.map((v) => v.key));
    expect(keys.size).toBe(2);

    // Baselining only the first key leaves the second still reported.
    const baseline = new Set([varViolations[0].key]);
    const after = checkServiceUnits({ cwd: dir, skipPlutil: true, baseline });
    const stillVar = after.violations.filter(
      (v) => v.code === 'unexpanded-var-in-plist',
    );
    expect(stillVar.length).toBe(1);
  });

  it('catches a single-character bare shell variable ($_ / $i)', () => {
    const p = plist({
      filename: 'com.whatsoup.reply-guarantee.plist',
      extraStrings: [{ key: 'StandardOutPath', value: '$i/out.log' }],
    });
    const dir = makeRepo({ [p.name]: p.body });
    expect(codes(dir)).toContain('unexpanded-var-in-plist');
  });

  // --- parsePlist unit ---

  it('parsePlist returns null on a non-plist document', () => {
    expect(parsePlist('<html></html>')).toBeNull();
  });

  it('parsePlist extracts label and program arguments', () => {
    const shape = parsePlist(GOOD_PLIST);
    expect(shape?.label).toBe('com.whatsoup.reply-guarantee');
    expect(shape?.programArguments[0]).toContain(
      'whatsoup-reply-guarantee-drain',
    );
  });

  // --- CLI run() ---

  it('run() sets a non-zero exitCode when violations exist', () => {
    const p = plist({
      filename: 'com.whatsoup.fleet.plist',
      label: 'wrong-label',
    });
    const dir = makeRepo({ [p.name]: p.body });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = run([], dir);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });

  it('run() leaves exitCode unset on a clean repo', () => {
    const dir = makeRepo({ 'com.whatsoup.reply-guarantee.plist': GOOD_PLIST });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = run([], dir);
    expect(process.exitCode).toBeUndefined();
    expect(result.violations).toEqual([]);
    expect(result.scanned).toEqual(['deploy/com.whatsoup.reply-guarantee.plist']);
  });
});
