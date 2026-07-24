import { describe, it, expect } from 'vitest';
import { renderBrandLevel, renderEffortLevel, renderModelLevel } from '../../../src/runtimes/agent/model-drilldown-render.ts';
import { nativeReasoningControl } from '../../../src/runtimes/agent/reasoning-control.ts';

describe('model-drilldown-render (Slice 2 pure level renderers)', () => {
  describe('renderBrandLevel', () => {
    it('renders a numbered brand menu with entries in the SAME order as the numbering', () => {
      const { text, entries } = renderBrandLevel([
        { brand: 'Claude', provider: 'claude-cli' },
        { brand: 'OpenCode', provider: 'opencode-cli' },
      ]);
      expect(text).toContain('*Pick a provider:*');
      expect(text).toContain('1. Claude');
      expect(text).toContain('2. OpenCode');
      expect(text).toContain('_Reply /model N_');
      // entries mirror the numbering: index 0 = "1.", tagged 'brand'.
      expect(entries).toEqual([
        { kind: 'brand', label: 'Claude', brand: 'Claude', provider: 'claude-cli' },
        { kind: 'brand', label: 'OpenCode', brand: 'OpenCode', provider: 'opencode-cli' },
      ]);
    });

    it('marks the current brand with (current)', () => {
      const { text } = renderBrandLevel(
        [{ brand: 'Claude', provider: 'claude-cli' }, { brand: 'OpenAI', provider: 'openai-api' }],
        'OpenAI',
      );
      expect(text).toContain('2. OpenAI (current)');
      expect(text).not.toContain('1. Claude (current)');
    });

    it('renders an empty menu (no rows) when there are no brands', () => {
      const { text, entries } = renderBrandLevel([]);
      expect(entries).toEqual([]);
      expect(text).toContain('*Pick a provider:*');
      expect(text).not.toMatch(/^\d+\. /m);
    });
  });

  describe('renderModelLevel', () => {
    it('renders a numbered model menu for the brand, entries mirroring the numbering', () => {
      const { text, entries } = renderModelLevel('OpenCode', 'opencode-cli', ['kimi/kimi-k3', 'glm/glm-5.2']);
      expect(text).toContain('*OpenCode — pick a model:*');
      expect(text).toContain('1. kimi/kimi-k3');
      expect(text).toContain('2. glm/glm-5.2');
      expect(text).toContain('_Reply /model N_');
      expect(entries).toEqual([
        { kind: 'model', label: 'kimi/kimi-k3', provider: 'opencode-cli', model: 'kimi/kimi-k3' },
        { kind: 'model', label: 'glm/glm-5.2', provider: 'opencode-cli', model: 'glm/glm-5.2' },
      ]);
    });

    it('marks the current model with (current)', () => {
      const { text } = renderModelLevel('OpenCode', 'opencode-cli', ['kimi/kimi-k3', 'glm/glm-5.2'], 'glm/glm-5.2');
      expect(text).toContain('2. glm/glm-5.2 (current)');
      expect(text).not.toContain('1. kimi/kimi-k3 (current)');
    });

    it('retired up-nav: the footer never advertises /model back', () => {
      const { text } = renderModelLevel('Claude', 'claude-cli', ['claude-opus-4-8']);
      expect(text).not.toContain('/model back');
    });
  });

  describe('renderEffortLevel (Slice 3)', () => {
    const control = nativeReasoningControl('claude-cli', 'claude-opus-4-8')!;

    it('renders one row per level then a "Default (no override)" row LAST, entries mirroring the numbering', () => {
      const { text, entries } = renderEffortLevel('claude-opus-4-8', 'claude-cli', control);
      expect(text).toContain('*claude-opus-4-8 — reasoning effort:*');
      expect(text).toContain('1. Highest');
      expect(text).toContain('2. High');
      expect(text).toContain('3. Medium');
      expect(text).toContain('4. Low');
      expect(text).toContain('5. Default (no override)');
      expect(text).toContain('_Reply /model N_');
      expect(entries).toEqual([
        { kind: 'effort', label: 'Highest', provider: 'claude-cli', model: 'claude-opus-4-8', effort: 'xhigh' },
        { kind: 'effort', label: 'High', provider: 'claude-cli', model: 'claude-opus-4-8', effort: 'high' },
        { kind: 'effort', label: 'Medium', provider: 'claude-cli', model: 'claude-opus-4-8', effort: 'medium' },
        { kind: 'effort', label: 'Low', provider: 'claude-cli', model: 'claude-opus-4-8', effort: 'low' },
        { kind: 'effort', label: 'Default (no override)', provider: 'claude-cli', model: 'claude-opus-4-8', effort: null },
      ]);
    });

    it('marks the current effort level with (current)', () => {
      const { text } = renderEffortLevel('claude-opus-4-8', 'claude-cli', control, 'high');
      expect(text).toContain('2. High (current)');
      expect(text).not.toContain('5. Default (no override) (current)');
    });

    it('marks "Default (no override)" (current) when there is no effort override', () => {
      const { text } = renderEffortLevel('claude-opus-4-8', 'claude-cli', control, null);
      expect(text).toContain('5. Default (no override) (current)');
      expect(text).not.toContain('1. Highest (current)');
    });
  });
});
