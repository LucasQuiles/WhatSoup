import { describe, it, expect } from 'vitest';
import {
  OWNER_BULLET,
  bulletedSection,
  modifierSuffix,
  modelModifierTags,
} from '../../../src/runtimes/agent/owner-render-format.ts';

// b28 r2a/r2d: the pure WhatsApp owner-render formatting seam. Enumerations
// render as a header line + one `• ` bullet per entry (WhatsApp narrow column:
// never a long joined single line); model modifiers are config-derived FACTS
// only (D7) — the catalog is silent for IDs it does not recognize.
describe('owner-render-format', () => {
  describe('bulletedSection', () => {
    it('renders a header followed by one bullet per item, never a joined single line', () => {
      const out = bulletedSection('Fallback chain (configured):', [
        'opencode-cli (kimi/kimi-k3)',
        'opencode-cli (glm/glm-5.2)',
      ]);
      expect(out).toBe(
        'Fallback chain (configured):\n' +
          `${OWNER_BULLET}opencode-cli (kimi/kimi-k3)\n` +
          `${OWNER_BULLET}opencode-cli (glm/glm-5.2)`,
      );
      // The pre-b28 defect: the whole chain crammed onto one ` → `-joined line.
      expect(out).not.toContain(' → ');
      expect(out.split('\n').filter((l) => l.startsWith(OWNER_BULLET))).toHaveLength(2);
    });

    it('distinct same-provider entries stay distinguishable as separate bullets (B23 discriminator preserved)', () => {
      const out = bulletedSection('Fallback chain (configured):', [
        'opencode-cli (glm-4.7)',
        'opencode-cli (kimi-k3)',
      ]);
      expect(out).toContain(`${OWNER_BULLET}opencode-cli (glm-4.7)`);
      expect(out).toContain(`${OWNER_BULLET}opencode-cli (kimi-k3)`);
    });
  });

  describe('modifierSuffix', () => {
    it('is empty for no tags', () => {
      expect(modifierSuffix([])).toBe('');
    });
    it('wraps each tag in brackets, space-separated, with a leading space', () => {
      expect(modifierSuffix(['strongest'])).toBe(' [strongest]');
      expect(modifierSuffix(['newer: claude-opus-4-8', 'strongest'])).toBe(
        ' [newer: claude-opus-4-8] [strongest]',
      );
    });
  });

  describe('modelModifierTags', () => {
    it('tags a legacy model with its newer sibling (config-derived from the ID + catalog)', () => {
      expect(modelModifierTags('claude-opus-4-5', 'claude-cli', null)).toEqual([
        'newer: claude-opus-4-8',
      ]);
    });

    it('is SILENT for an ID the catalog does not recognize (D7 honesty — never invents a fact)', () => {
      expect(modelModifierTags('kimi/kimi-k3', 'opencode-cli', null)).toEqual([]);
      expect(modelModifierTags('glm/glm-5.2', 'opencode-cli', null)).toEqual([]);
    });

    it('emits no advisory for a current model', () => {
      expect(modelModifierTags('claude-opus-4-8', 'claude-cli', null)).toEqual([]);
    });

    it('tags a deprecated model with its successor', () => {
      // claude-opus-4-0 is deprecated in the catalog, successor claude-opus-4-8.
      expect(modelModifierTags('claude-opus-4-0', 'claude-cli', null)).toEqual([
        'deprecated → claude-opus-4-8',
      ]);
    });

    it('tags a retired model with its successor', () => {
      // claude-3-opus-20240229 is retired in the catalog, successor claude-opus-4-8.
      expect(modelModifierTags('claude-3-opus-20240229', 'claude-cli', null)).toEqual([
        'retired → claude-opus-4-8',
      ]);
    });

    it('tags a provider that is a configured tier target (config-derived from nlRoutingTiers)', () => {
      expect(modelModifierTags(undefined, 'anthropic-api', { strongest: 'anthropic-api' })).toEqual([
        'strongest',
      ]);
      expect(modelModifierTags(undefined, 'claude-cli', { strongest: 'anthropic-api' })).toEqual([]);
    });

    it('combines a catalog advisory and a tier tag in order', () => {
      expect(
        modelModifierTags('claude-opus-4-5', 'anthropic-api', { strongest: 'anthropic-api' }),
      ).toEqual(['newer: claude-opus-4-8', 'strongest']);
    });
  });
});
