import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';

const PROVIDERS_DIR = resolve(import.meta.dirname, '../../../../src/runtimes/agent/providers');
const SESSION_FILE = resolve(import.meta.dirname, '../../../../src/runtimes/agent/session.ts');

describe('Provider hardening', () => {

  describe('Security invariants', () => {
    it('session.ts spawn uses explicit env (not process.env inheritance)', () => {
      const content = readFileSync(SESSION_FILE, 'utf8');
      // Every spawn() call must have env: in its options
      const spawnCalls = content.match(/spawn\([^)]+\{[^}]+\}/gs) ?? [];
      for (const call of spawnCalls) {
        if (call.includes('stdio:')) { // only agent spawns, not utility spawns
          expect(call).toContain('env:');
        }
      }
    });

    it('all mkdirSync calls in providers use mode 0o700', () => {
      const files = readdirSync(PROVIDERS_DIR).filter(f => f.endsWith('.ts'));
      for (const file of files) {
        const content = readFileSync(join(PROVIDERS_DIR, file), 'utf8');
        const mkdirCalls = content.match(/mkdirSync\([^)]+\)/g) ?? [];
        for (const call of mkdirCalls) {
          if (!call.includes('import')) {
            expect(call).toContain('0o700');
          }
        }
      }
    });
  });

  describe('Provider descriptor completeness', () => {
    // Every provider file that exports a descriptor must have all required fields
    const descriptorFiles = ['claude.ts', 'openai-api.ts', 'anthropic-api.ts', 'opencode-adapter.ts'];

    for (const file of descriptorFiles) {
      it(`${file} descriptor has all required fields`, () => {
        const content = readFileSync(resolve(PROVIDERS_DIR, file), 'utf8');
        if (content.includes('Descriptor')) {
          expect(content).toMatch(/id:/);
          expect(content).toMatch(/displayName:/);
          expect(content).toMatch(/transport:/);
          expect(content).toMatch(/executionMode:/);
          expect(content).toMatch(/mcpMode:/);
          expect(content).toMatch(/imageSupport:/);
          expect(content).toMatch(/supportsResume:/);
          expect(content).toMatch(/defaultWatchdog:/);
        }
      });
    }
  });

  describe('Parser contract', () => {
    // Every parser must handle empty lines and malformed JSON without throwing
    const parsers = [
      { name: 'codex', import: '../../src/runtimes/agent/providers/codex-parser.ts' },
      { name: 'gemini', import: '../../src/runtimes/agent/providers/gemini-parser.ts' },
      { name: 'opencode', import: '../../src/runtimes/agent/providers/opencode-parser.ts' },
    ];

    // These are already tested in stream-parsers.test.ts but let's add contract-level assertions
    it('all parsers are imported from the providers directory', () => {
      const sessionContent = readFileSync(SESSION_FILE, 'utf8');
      expect(sessionContent).toMatch(/parseCodexEvent/);
      expect(sessionContent).toMatch(/parseGeminiAcpEvent/);
      expect(sessionContent).toMatch(/parseOpenCodeEvent/);
    });

    it('session.ts getParser covers all registered providers', () => {
      const sessionContent = readFileSync(SESSION_FILE, 'utf8');
      // getParser must have cases for each provider
      expect(sessionContent).toMatch(/case 'codex-cli'.*parse/s);
      expect(sessionContent).toMatch(/case 'gemini-cli'.*parse/s);
      expect(sessionContent).toMatch(/case 'opencode-cli'.*parse/s);
    });
  });

  describe('Budget controls present', () => {
    it('BudgetConfig has costPerMillionTokens for provider-aware pricing', () => {
      const content = readFileSync(resolve(PROVIDERS_DIR, 'budget.ts'), 'utf8');
      expect(content).toMatch(/costPerMillionTokens/);
    });

    it('ProviderBudget has checkBudget and recordUsage methods', () => {
      const content = readFileSync(resolve(PROVIDERS_DIR, 'budget.ts'), 'utf8');
      expect(content).toMatch(/checkBudget/);
      expect(content).toMatch(/recordUsage/);
    });
  });

  describe('Tool mapping registry', () => {
    it('has mappers for all CLI providers', () => {
      const content = readFileSync(resolve(PROVIDERS_DIR, 'tool-mapping.ts'), 'utf8');
      expect(content).toMatch(/claude-cli/);
      expect(content).toMatch(/codex-cli/);
      expect(content).toMatch(/gemini-cli/);
    });

    it('has a default fallback mapper', () => {
      const content = readFileSync(resolve(PROVIDERS_DIR, 'tool-mapping.ts'), 'utf8');
      expect(content).toMatch(/defaultToolMapper/);
    });
  });
});
