// Mock node:process BEFORE importing the module under test so `arch.ts`'s
// `import { arch } from "node:process"` binds to our controllable value.
// Hoisted so the vi.mock factory (hoisted above imports) can reference it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { archState } = vi.hoisted(() => ({ archState: { value: 'x64' as string } }));

vi.mock('node:process', () => ({
  get arch() {
    return archState.value;
  },
}));

import { getArchBinSuffix, getArchLabel, getPlatformArch } from '../../src/lib/arch.ts';

describe('arch utilities', () => {
  beforeEach(() => {
    archState.value = 'x64';
  });

  describe('getArchBinSuffix', () => {
    it('returns -arm64 for arm64', () => {
      archState.value = 'arm64';
      expect(getArchBinSuffix()).toBe('-arm64');
    });

    it('returns -arm64 for aarch64', () => {
      archState.value = 'aarch64';
      expect(getArchBinSuffix()).toBe('-arm64');
    });

    it('returns -x64 for x64', () => {
      archState.value = 'x64';
      expect(getArchBinSuffix()).toBe('-x64');
    });

    it('returns -x64 for x86_64', () => {
      archState.value = 'x86_64';
      expect(getArchBinSuffix()).toBe('-x64');
    });

    it('returns -ia32 for ia32', () => {
      archState.value = 'ia32';
      expect(getArchBinSuffix()).toBe('-ia32');
    });

    it('returns -loong64 for loong64', () => {
      archState.value = 'loong64';
      expect(getArchBinSuffix()).toBe('-loong64');
    });

    it('returns -riscv64 for riscv64', () => {
      archState.value = 'riscv64';
      expect(getArchBinSuffix()).toBe('-riscv64');
    });

    it('returns -ppc64 for ppc64', () => {
      archState.value = 'ppc64';
      expect(getArchBinSuffix()).toBe('-ppc64');
    });

    it('returns -s390x for s390x', () => {
      archState.value = 's390x';
      expect(getArchBinSuffix()).toBe('-s390x');
    });

    it('degrades gracefully to "" for an unknown architecture', () => {
      archState.value = 'mips';
      expect(getArchBinSuffix()).toBe('');
    });
  });

  describe('getArchLabel', () => {
    it('normalises arm64/aarch64 to "arm64"', () => {
      archState.value = 'arm64';
      expect(getArchLabel()).toBe('arm64');
      archState.value = 'aarch64';
      expect(getArchLabel()).toBe('arm64');
    });

    it('normalises x64/x86_64 to "x86_64"', () => {
      archState.value = 'x64';
      expect(getArchLabel()).toBe('x86_64');
      archState.value = 'x86_64';
      expect(getArchLabel()).toBe('x86_64');
    });

    it('returns "ia32" for ia32', () => {
      archState.value = 'ia32';
      expect(getArchLabel()).toBe('ia32');
    });

    it('passes through loong64/riscv64/ppc64/s390x unchanged', () => {
      for (const value of ['loong64', 'riscv64', 'ppc64', 's390x']) {
        archState.value = value;
        expect(getArchLabel()).toBe(value);
      }
    });

    it('falls back to the raw arch string for an unknown architecture', () => {
      archState.value = 'mips';
      expect(getArchLabel()).toBe('mips');
    });
  });

  describe('getPlatformArch', () => {
    it('maps arm64/aarch64 to the Homebrew/Linux "aarch64" convention', () => {
      archState.value = 'arm64';
      expect(getPlatformArch()).toBe('aarch64');
      archState.value = 'aarch64';
      expect(getPlatformArch()).toBe('aarch64');
    });

    it('maps x64/x86_64 to the POSIX "x86_64" convention', () => {
      archState.value = 'x64';
      expect(getPlatformArch()).toBe('x86_64');
      archState.value = 'x86_64';
      expect(getPlatformArch()).toBe('x86_64');
    });

    it('falls back to the raw arch string for an unmapped architecture', () => {
      archState.value = 'ia32';
      expect(getPlatformArch()).toBe('ia32');
    });
  });
});
