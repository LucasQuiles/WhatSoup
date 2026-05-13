import { describe, expect, it } from 'vitest';
import {
  FIX_COMMAND_TEMPLATES,
  resolveProposeFixFollowUp,
} from '../../src/transport/fix-commands.ts';

/**
 * Direct unit coverage for resolveProposeFixFollowUp + FIX_COMMAND_TEMPLATES.
 *
 * Spec: docs/specs/2026-05-08-whatsoup-protection-layer-design.md
 *   §6.5 — propose_fix emits a copy-pasteable command or remediation_hint.
 *   §7.4 — alert body shape: propose_fix:<command> | remediation_hint:<text>.
 *
 * The existing format-propose-fix.test.ts tests formatAlert end-to-end;
 * this file drives the resolver directly so every template key, every
 * readMode branch, and every shellQuote path has dedicated coverage.
 */

const SPEC_PATH = 'docs/specs/2026-05-08-whatsoup-protection-layer-design.md';

// ---------------------------------------------------------------------------
// resolveProposeFixFollowUp — top-level contract
// ---------------------------------------------------------------------------
describe('resolveProposeFixFollowUp', () => {
  it('returns undefined for an unknown policy key', () => {
    expect(resolveProposeFixFollowUp('totally.unknown', {})).toBeUndefined();
  });

  it('returns undefined when key is undefined', () => {
    expect(resolveProposeFixFollowUp(undefined, {})).toBeUndefined();
  });

  it('returns undefined when key is empty string', () => {
    expect(resolveProposeFixFollowUp('', {})).toBeUndefined();
  });

  it('passes an empty payload object when payload is undefined', () => {
    // credential.file_mode_widened with no payload → remediationHint (no path)
    const result = resolveProposeFixFollowUp('credential.file_mode_widened', undefined);
    expect(result).toBeDefined();
    expect(result!.fixCommand).toBeUndefined();
    expect(result!.remediationHint).toContain(SPEC_PATH);
  });
});

// ---------------------------------------------------------------------------
// FIX_COMMAND_TEMPLATES — exported map coverage
// ---------------------------------------------------------------------------
describe('FIX_COMMAND_TEMPLATES', () => {
  it('exports a non-null object', () => {
    expect(FIX_COMMAND_TEMPLATES).toBeDefined();
    expect(typeof FIX_COMMAND_TEMPLATES).toBe('object');
  });

  it('contains every expected template key', () => {
    const keys = Object.keys(FIX_COMMAND_TEMPLATES);
    const expected = [
      'alerting.self_secret_widened',
      'credential.file_mode_widened',
      'exposure.firewall_disabled',
      'credential.token_aging',
      'capability.role_violation',
      'change.new_persistence_unit',
      'change.new_application_route',
      'exposure.unauthenticated_mutation',
      'exposure.public_funnel_internal',
      'alerting.baseline_integrity_fail',
      'alerting.transport_failed',
    ];
    for (const k of expected) {
      expect(keys).toContain(k);
    }
  });
});

// ---------------------------------------------------------------------------
// Shell-fix template: credential.file_mode_widened
// ---------------------------------------------------------------------------
describe('credential.file_mode_widened', () => {
  const KEY = 'credential.file_mode_widened';

  it('emits fixCommand with chmod when path is present (default mode 0600)', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/etc/wsoup/sink.env' });
    expect(result?.remediationHint).toBeUndefined();
    expect(result?.fixCommand).toBe("chmod 0600 '/etc/wsoup/sink.env'");
  });

  it('uses expected_mode from payload (octal number 384 → 0o600 → "0600")', () => {
    // 384 decimal = 0o600 octal; readMode converts numeric value to "0600"
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/sec', expected_mode: 384 });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/sec'");
  });

  it('uses expected_mode from payload (octal number 256 → 0o400 → "0400")', () => {
    // 256 decimal = 0o400 octal
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/sec', expected_mode: 256 });
    expect(result?.fixCommand).toBe("chmod 0400 '/tmp/sec'");
  });

  it('accepts expected_mode as octal string with leading zero', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/sec', expected_mode: '0640' });
    expect(result?.fixCommand).toBe("chmod 0640 '/tmp/sec'");
  });

  it('accepts expected_mode as octal string without leading zero, prepends zero', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/sec', expected_mode: '640' });
    expect(result?.fixCommand).toBe("chmod 0640 '/tmp/sec'");
  });

  it('falls back to 0600 when expected_mode is an invalid string', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/sec', expected_mode: 'not-a-mode' });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/sec'");
  });

  it('falls back to 0600 when expected_mode is null', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/sec', expected_mode: null });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/sec'");
  });

  it('falls back to 0600 when expected_mode is a float', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/sec', expected_mode: 3.14 });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/sec'");
  });

  it('emits remediationHint (no fixCommand) when path is absent', () => {
    const result = resolveProposeFixFollowUp(KEY, {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.2');
  });

  it('emits remediationHint when path is an empty string', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '' });
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
  });

  it('emits remediationHint when path is not a string', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: 42 });
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
  });
});

// ---------------------------------------------------------------------------
// Shell-fix template: alerting.self_secret_widened
// ---------------------------------------------------------------------------
describe('alerting.self_secret_widened', () => {
  const KEY = 'alerting.self_secret_widened';

  it('emits fixCommand with chmod when path is present (default mode 0600)', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/var/lib/wsoup/.guard-secret' });
    expect(result?.remediationHint).toBeUndefined();
    expect(result?.fixCommand).toBe("chmod 0600 '/var/lib/wsoup/.guard-secret'");
  });

  it('uses expected_mode from payload (octal number)', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/secret', expected_mode: 256 });
    expect(result?.fixCommand).toBe("chmod 0400 '/tmp/secret'");
  });

  it('uses expected_mode from payload (octal string without leading zero)', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/secret', expected_mode: '600' });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/secret'");
  });

  it('uses expected_mode from payload (4-digit octal string "0700")', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/secret', expected_mode: '0700' });
    expect(result?.fixCommand).toBe("chmod 0700 '/tmp/secret'");
  });

  it('emits remediationHint when path is absent', () => {
    const result = resolveProposeFixFollowUp(KEY, {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.5');
  });
});

// ---------------------------------------------------------------------------
// shellQuote behavior — exercised via file-path templates
// ---------------------------------------------------------------------------
describe('shellQuote (exercised via credential.file_mode_widened)', () => {
  const KEY = 'credential.file_mode_widened';

  it('wraps plain paths in single quotes', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/simple/path' });
    expect(result?.fixCommand).toMatch(/^chmod 0600 '\/simple\/path'$/);
  });

  it('escapes single quotes inside the path', () => {
    // Path with a single quote: /etc/O'Brien/conf
    // shellQuote wraps in single quotes, escaping ' → '"'"'
    const result = resolveProposeFixFollowUp(KEY, { path: "/etc/O'Brien/conf" });
    expect(result?.fixCommand).toBe("chmod 0600 '/etc/O'\"'\"'Brien/conf'");
  });

  it('handles paths with spaces', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/var/lib/wsoup/my secrets/file.env' });
    expect(result?.fixCommand).toBe("chmod 0600 '/var/lib/wsoup/my secrets/file.env'");
  });

  it('handles paths with special shell characters', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/$HOME/file' });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/$HOME/file'");
  });
});

// ---------------------------------------------------------------------------
// Shell-fix template: exposure.firewall_disabled
// ---------------------------------------------------------------------------
describe('exposure.firewall_disabled', () => {
  const KEY = 'exposure.firewall_disabled';

  it('emits the real socketfilterfw command', () => {
    const result = resolveProposeFixFollowUp(KEY, {});
    expect(result?.remediationHint).toBeUndefined();
    expect(result?.fixCommand).toBe(
      'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on',
    );
  });

  it('ignores extra payload fields', () => {
    const result = resolveProposeFixFollowUp(KEY, { extra: 'ignored' });
    expect(result?.fixCommand).toBe(
      'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on',
    );
  });
});

// ---------------------------------------------------------------------------
// Non-shell (remediationHint) templates
// ---------------------------------------------------------------------------
describe('credential.token_aging', () => {
  it('returns remediationHint referencing the spec and whatsoup-guard cycle', () => {
    const result = resolveProposeFixFollowUp('credential.token_aging', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.2');
    expect(result?.remediationHint).toContain('whatsoup-guard cycle');
  });
});

describe('capability.role_violation', () => {
  it('returns remediationHint referencing the spec §4.3 and §8.1', () => {
    const result = resolveProposeFixFollowUp('capability.role_violation', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.3');
    expect(result?.remediationHint).toContain('§8.1');
  });
});

describe('change.new_persistence_unit', () => {
  it('returns remediationHint referencing the spec §4.4', () => {
    const result = resolveProposeFixFollowUp('change.new_persistence_unit', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.4');
  });
});

describe('change.new_application_route', () => {
  it('returns remediationHint referencing the spec §4.4', () => {
    const result = resolveProposeFixFollowUp('change.new_application_route', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.4');
  });
});

describe('exposure.unauthenticated_mutation', () => {
  it('returns remediationHint referencing the spec §4.1', () => {
    const result = resolveProposeFixFollowUp('exposure.unauthenticated_mutation', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.1');
  });
});

describe('exposure.public_funnel_internal', () => {
  it('returns remediationHint referencing the spec §4.1', () => {
    const result = resolveProposeFixFollowUp('exposure.public_funnel_internal', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.1');
  });
});

describe('alerting.baseline_integrity_fail', () => {
  it('returns remediationHint referencing whatsoup-guard simulate and the spec §4.5', () => {
    const result = resolveProposeFixFollowUp('alerting.baseline_integrity_fail', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain('whatsoup-guard simulate');
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§4.5');
  });
});

describe('alerting.transport_failed', () => {
  it('returns remediationHint referencing whatsoup-guard cycle and the spec §7.1', () => {
    const result = resolveProposeFixFollowUp('alerting.transport_failed', {});
    expect(result?.fixCommand).toBeUndefined();
    expect(result?.remediationHint).toContain('whatsoup-guard cycle');
    expect(result?.remediationHint).toContain(SPEC_PATH);
    expect(result?.remediationHint).toContain('§7.1');
  });
});

// ---------------------------------------------------------------------------
// readMode edge-cases — via resolveProposeFixFollowUp with path present
// ---------------------------------------------------------------------------
describe('readMode edge-cases (via credential.file_mode_widened)', () => {
  const KEY = 'credential.file_mode_widened';

  it('handles octal number 0 → "0000"', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: 0 });
    expect(result?.fixCommand).toBe("chmod 0000 '/tmp/f'");
  });

  it('handles large valid octal number 511 (0o777 decimal) → "0777"', () => {
    // 511 decimal = 0o777 octal
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: 511 });
    expect(result?.fixCommand).toBe("chmod 0777 '/tmp/f'");
  });

  it('falls back to 0600 for negative number', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: -1 });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/f'");
  });

  it('falls back to 0600 for boolean true', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: true });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/f'");
  });

  it('falls back to 0600 for an array', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: [6, 0, 0] });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/f'");
  });

  it('rejects octal string with 8 or 9 digits (invalid octal)', () => {
    // "0689" contains 8 and 9 — not valid octal, readMode returns undefined → fallback 0600
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: '0689' });
    expect(result?.fixCommand).toBe("chmod 0600 '/tmp/f'");
  });

  it('accepts 3-digit octal string without leading zero "644"', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: '644' });
    expect(result?.fixCommand).toBe("chmod 0644 '/tmp/f'");
  });

  it('accepts 4-digit octal string with leading zero "0755"', () => {
    const result = resolveProposeFixFollowUp(KEY, { path: '/tmp/f', expected_mode: '0755' });
    expect(result?.fixCommand).toBe("chmod 0755 '/tmp/f'");
  });
});
