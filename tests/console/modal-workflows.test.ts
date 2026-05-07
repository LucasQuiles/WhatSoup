/**
 * Modal workflows — structural tests for AddLineWizard and RelinkModal.
 * Verifies lazy-load compatibility and export shapes.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// AddLineWizard
// ---------------------------------------------------------------------------

describe('AddLineWizard', () => {
  it('is a default export (lazy-loadable)', async () => {
    const mod = await import('../../console/src/components/AddLineWizard.tsx');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// RelinkModal
// ---------------------------------------------------------------------------

describe('RelinkModal', () => {
  it('is a default export (lazy-loadable)', async () => {
    const mod = await import('../../console/src/components/RelinkModal.tsx');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------

describe('ConfirmDialog', () => {
  it('is a default export', async () => {
    const mod = await import('../../console/src/components/ConfirmDialog');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Validation helpers used by wizards
// ---------------------------------------------------------------------------

describe('phone validation', () => {
  it('exports normalizePhoneInput and validatePhone', async () => {
    const mod = await import('../../console/src/lib/validation');
    expect({
      normalizePhoneInput: typeof mod.normalizePhoneInput,
      validatePhone: typeof mod.validatePhone,
    }).toEqual({
      normalizePhoneInput: 'function',
      validatePhone: 'function',
    });
  });

  it('normalizePhoneInput strips non-numeric chars except +', async () => {
    const { normalizePhoneInput } = await import('../../console/src/lib/validation');
    const result = normalizePhoneInput('+1 (555) 000-1234');
    expect(result).toMatch(/^\+?\d+$/);
  });

  it('validatePhone accepts valid E.164 numbers', async () => {
    const { validatePhone } = await import('../../console/src/lib/validation');
    expect(validatePhone('+15550001234')).toBe(true);
  });

  it('validatePhone rejects empty strings', async () => {
    const { validatePhone } = await import('../../console/src/lib/validation');
    expect(validatePhone('')).toBe(false);
  });

  it('fails closed for malformed runtime phone values', async () => {
    const { normalizePhoneInput, validatePhone } = await import('../../console/src/lib/validation');
    expect(normalizePhoneInput(null)).toBe('');
    expect(normalizePhoneInput(undefined)).toBe('');
    expect(normalizePhoneInput(5550001234)).toBe('15550001234');
    expect(validatePhone(null)).toBe(false);
    expect(validatePhone(undefined)).toBe(false);
  });
});
