import { describe, expect, it } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

describe('Vitest filesystem isolation', () => {
  it('routes HOME and XDG roots into a worker-owned temporary directory', () => {
    const isolatedHome = process.env['WHATSOUP_VITEST_HOME'];
    const isolatedTempRoot = process.env['WHATSOUP_VITEST_TEMP_ROOT'];

    expect(isolatedHome).toBeTruthy();
    expect(isolatedTempRoot).toBeTruthy();
    expect(isAbsolute(isolatedHome!)).toBe(true);
    expect(relative(realpathSync(isolatedTempRoot!), realpathSync(isolatedHome!))).not.toMatch(/^\.\.(?:\/|$)/);
    expect(process.env['HOME']).toBe(isolatedHome);
    expect(homedir()).toBe(isolatedHome);
    expect(process.env['XDG_CONFIG_HOME']).toBe(join(isolatedHome!, '.config'));
    expect(process.env['XDG_DATA_HOME']).toBe(join(isolatedHome!, '.local', 'share'));
    expect(process.env['XDG_STATE_HOME']).toBe(join(isolatedHome!, '.local', 'state'));
    expect(process.env['XDG_CACHE_HOME']).toBe(join(isolatedHome!, '.cache'));
    expect(process.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(existsSync(join(isolatedHome!, '.whatsoup-vitest-home'))).toBe(true);
  });
});
