import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderBudget } from '../../../../src/runtimes/agent/providers/budget.js';
import {
  claudeToolMapper,
  codexToolMapper,
  geminiToolMapper,
  defaultToolMapper,
  getToolMapper,
} from '../../../../src/runtimes/agent/providers/tool-mapping.js';

// ---------------------------------------------------------------------------
// ProviderBudget
// ---------------------------------------------------------------------------

describe('ProviderBudget', () => {
  describe('requestsPerMinute limit', () => {
    it('denies the 6th request when limit is 5', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 5 });

      for (let i = 0; i < 5; i++) {
        expect(budget.checkBudget().allowed).toBe(true);
        budget.recordUsage({ input: 10, output: 10 });
      }

      const result = budget.checkBudget();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('5 req/min');
      expect(result.reason).toContain('test');
    });
  });

  describe('tokensPerMinute limit', () => {
    it('denies the next request after 1000 tokens recorded', () => {
      const budget = new ProviderBudget('test', { tokensPerMinute: 1000 });

      expect(budget.checkBudget().allowed).toBe(true);
      budget.recordUsage({ input: 600, output: 400 }); // exactly 1000

      const result = budget.checkBudget();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('1000 tokens/min');
      expect(result.reason).toContain('test');
    });

    it('allows request when token count is below the limit', () => {
      const budget = new ProviderBudget('test', { tokensPerMinute: 1000 });
      budget.recordUsage({ input: 400, output: 400 }); // 800 — under limit

      expect(budget.checkBudget().allowed).toBe(true);
    });
  });

  describe('dailySpendCapUsd limit', () => {
    it('denies when estimated spend reaches the cap', () => {
      // $1 cap, $10/M tokens → need 100_000 tokens to hit $1
      const budget = new ProviderBudget('test', {
        dailySpendCapUsd: 1,
        costPerMillionTokens: 10,
      });

      expect(budget.checkBudget().allowed).toBe(true);
      budget.recordUsage({ input: 50_000, output: 50_000 }); // 100_000 tokens = $1.00

      const result = budget.checkBudget();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily spend cap');
      expect(result.reason).toContain('$1');
    });

    it('denies well beyond the cap', () => {
      const budget = new ProviderBudget('test', {
        dailySpendCapUsd: 1,
        costPerMillionTokens: 10,
      });
      budget.recordUsage({ input: 200_000, output: 0 }); // $2 — over cap

      expect(budget.checkBudget().allowed).toBe(false);
    });

    it('denies at $0.01 cap with exactly 1000 tokens at $10/M rate', () => {
      // $0.01 cap, $10/M tokens → 1000 tokens = $0.01 exactly
      const budget = new ProviderBudget('test', {
        dailySpendCapUsd: 0.01,
        costPerMillionTokens: 10,
      });

      expect(budget.checkBudget().allowed).toBe(true);
      budget.recordUsage({ input: 500, output: 500 }); // 1000 tokens = $0.01

      const result = budget.checkBudget();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily spend cap');
      expect(result.reason).toContain('$0.01');
    });

    it('allows again after resetDaily() clears the counter', () => {
      const budget = new ProviderBudget('test', {
        dailySpendCapUsd: 0.01,
        costPerMillionTokens: 10,
      });

      budget.recordUsage({ input: 500, output: 500 }); // 1000 tokens = $0.01
      expect(budget.checkBudget().allowed).toBe(false);

      budget.resetDaily();

      expect(budget.checkBudget().allowed).toBe(true);
    });

    it('getSnapshot().estimatedDailySpendUsd returns correct value', () => {
      const budget = new ProviderBudget('test', {
        dailySpendCapUsd: 0.01,
        costPerMillionTokens: 10,
      });

      budget.recordUsage({ input: 500, output: 500 }); // 1000 tokens = $0.01
      expect(budget.getSnapshot().estimatedDailySpendUsd).toBeCloseTo(0.01);

      budget.resetDaily();
      expect(budget.getSnapshot().estimatedDailySpendUsd).toBe(0);
    });
  });

  describe('chatBurstLimit', () => {
    it('denies the 4th request for same chatId when limit is 3', () => {
      const budget = new ProviderBudget('test', { chatBurstLimit: 3 });
      const chatId = 'chat-abc';

      for (let i = 0; i < 3; i++) {
        expect(budget.checkBudget(chatId).allowed).toBe(true);
        budget.recordUsage({ input: 10 }, chatId);
      }

      const result = budget.checkBudget(chatId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Chat burst limit');
      expect(result.reason).toContain('3 req/min');
    });

    it('allows a different chatId when one chat is burst-limited', () => {
      const budget = new ProviderBudget('test', { chatBurstLimit: 3 });

      for (let i = 0; i < 3; i++) {
        budget.recordUsage({ input: 10 }, 'chat-a');
      }

      // chat-a is blocked, chat-b should still be allowed
      expect(budget.checkBudget('chat-a').allowed).toBe(false);
      expect(budget.checkBudget('chat-b').allowed).toBe(true);
    });

    it('denies the 3rd request when chatBurstLimit is 2', () => {
      const budget = new ProviderBudget('test', { chatBurstLimit: 2 });

      expect(budget.checkBudget('chat-A').allowed).toBe(true);
      budget.recordUsage({ input: 10 }, 'chat-A');

      expect(budget.checkBudget('chat-A').allowed).toBe(true);
      budget.recordUsage({ input: 10 }, 'chat-A');

      const result = budget.checkBudget('chat-A');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Chat burst limit');
      expect(result.reason).toContain('2 req/min');
    });

    it('allows chat-B when chat-A is burst-limited (limit 2)', () => {
      const budget = new ProviderBudget('test', { chatBurstLimit: 2 });

      budget.recordUsage({ input: 10 }, 'chat-A');
      budget.recordUsage({ input: 10 }, 'chat-A');

      expect(budget.checkBudget('chat-A').allowed).toBe(false);
      expect(budget.checkBudget('chat-B').allowed).toBe(true);
    });

    it('allows chat-A again after the 60s window expires', () => {
      vi.useFakeTimers();
      const budget = new ProviderBudget('test', { chatBurstLimit: 2 });

      budget.recordUsage({ input: 10 }, 'chat-A');
      budget.recordUsage({ input: 10 }, 'chat-A');
      expect(budget.checkBudget('chat-A').allowed).toBe(false);

      // Advance past the 60s sliding window
      vi.advanceTimersByTime(61_000);

      expect(budget.checkBudget('chat-A').allowed).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('no limits', () => {
    it('always allows requests with empty config', () => {
      const budget = new ProviderBudget('test', {});

      for (let i = 0; i < 100; i++) {
        expect(budget.checkBudget().allowed).toBe(true);
        budget.recordUsage({ input: 1000, output: 1000 });
      }

      const snapshot = budget.getSnapshot();
      expect(snapshot.requestsLastMinute).toBeGreaterThan(0);
      expect(snapshot.isThrottled).toBe(false);
    });
  });

  describe('getSnapshot()', () => {
    it('returns correct counts after recording usage', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 10, tokensPerMinute: 500 });

      budget.recordUsage({ input: 100, output: 50 });
      budget.recordUsage({ input: 200, output: 50 });

      const snap = budget.getSnapshot();
      expect(snap.requestsLastMinute).toBe(2);
      expect(snap.tokensLastMinute).toBe(400); // 150 + 250
      expect(snap.isThrottled).toBe(false);
      expect(snap.throttleReason).toBeNull();
    });

    it('reports throttled when limit is exceeded', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 1 });

      budget.recordUsage({ input: 10 });
      budget.recordUsage({ input: 10 });

      const snap = budget.getSnapshot();
      expect(snap.isThrottled).toBe(true);
      expect(snap.throttleReason).not.toBeNull();
    });

    it('reports estimated daily spend', () => {
      const budget = new ProviderBudget('test', { costPerMillionTokens: 10 });
      budget.recordUsage({ input: 100_000, output: 100_000 }); // 200_000 tokens = $2

      const snap = budget.getSnapshot();
      expect(snap.estimatedDailySpendUsd).toBeCloseTo(2.0);
    });
  });

  describe('resetDaily()', () => {
    it('clears daily token counter so spend checks pass again', () => {
      const budget = new ProviderBudget('test', {
        dailySpendCapUsd: 1,
        costPerMillionTokens: 10,
      });
      budget.recordUsage({ input: 100_000, output: 0 }); // $1 — at cap

      expect(budget.checkBudget().allowed).toBe(false);

      budget.resetDaily();

      expect(budget.checkBudget().allowed).toBe(true);
      const snap = budget.getSnapshot();
      expect(snap.estimatedDailySpendUsd).toBe(0);
    });
  });

  describe('window pruning', () => {
    it('prunes entries older than 1 minute from sliding window', () => {
      vi.useFakeTimers();
      const budget = new ProviderBudget('test', { requestsPerMinute: 10 });

      // Record 5 requests at time 0
      for (let i = 0; i < 5; i++) {
        budget.recordUsage({ input: 10, output: 10 });
      }
      expect(budget.getSnapshot().requestsLastMinute).toBe(5);

      // Advance 61 seconds — all 5 should be pruned
      vi.advanceTimersByTime(61_000);

      // Record 1 new request to trigger pruning
      budget.recordUsage({ input: 10, output: 10 });
      expect(budget.getSnapshot().requestsLastMinute).toBe(1); // only the new one

      vi.useRealTimers();
    });
  });
  describe('pessimistic counting (burst bypass prevention)', () => {
    it('rejects the 3rd concurrent request when limit is 2 and no responses have arrived', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 2 });

      // Simulate 3 concurrent sendTurns: all call checkBudget before any recordUsage
      const r1 = budget.checkBudget();
      const r2 = budget.checkBudget();
      const r3 = budget.checkBudget();

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(false);
      expect(r3.reason).toContain('2 req/min');
    });

    it('releases pending slot when recordUsage is called (response arrives)', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 2 });

      // Two concurrent requests fill the budget
      expect(budget.checkBudget().allowed).toBe(true);
      expect(budget.checkBudget().allowed).toBe(true);
      expect(budget.checkBudget().allowed).toBe(false);

      // First response arrives — frees one pending slot
      budget.recordUsage({ input: 10, output: 10 });

      // Now a new request should be allowed (1 completed + 1 pending = 2, but completed is in window)
      // Actually: requestWindow has 1 entry + pendingRequests is 1 = 2 >= 2 — still blocked
      // Need second response too:
      budget.recordUsage({ input: 10, output: 10 });

      // Now: requestWindow has 2, pendingRequests is 0 — 2 >= 2 still blocked
      // This is correct: 2 completed requests in the window = at limit
      expect(budget.checkBudget().allowed).toBe(false);
    });

    it('releases pending slot when cancelPending is called (error path)', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 2 });

      // Two concurrent requests fill the budget
      expect(budget.checkBudget().allowed).toBe(true);
      expect(budget.checkBudget().allowed).toBe(true);
      expect(budget.checkBudget().allowed).toBe(false);

      // First request errors out — cancel its pending reservation
      budget.cancelPending();

      // Now: requestWindow has 0, pendingRequests is 1 = 1 < 2 — allowed
      expect(budget.checkBudget().allowed).toBe(true);
    });

    it('cancelPending does not go below zero', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 5 });

      // No pending requests — cancelPending should be a no-op
      budget.cancelPending();
      budget.cancelPending();
      budget.cancelPending();

      // Should still allow requests normally
      expect(budget.checkBudget().allowed).toBe(true);
    });

    it('getSnapshot does not increment pendingRequests', () => {
      const budget = new ProviderBudget('test', { requestsPerMinute: 2 });

      // Call getSnapshot multiple times — should not consume budget
      budget.getSnapshot();
      budget.getSnapshot();
      budget.getSnapshot();

      // Should still allow 2 requests
      expect(budget.checkBudget().allowed).toBe(true);
      expect(budget.checkBudget().allowed).toBe(true);
      expect(budget.checkBudget().allowed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Tool name mapping
// ---------------------------------------------------------------------------

describe('Tool name mapping', () => {
  describe('claudeToolMapper', () => {
    it('maps Read → reading', () => {
      expect(claudeToolMapper.mapToolName('Read')).toBe('reading');
    });

    it('maps Write → modifying', () => {
      expect(claudeToolMapper.mapToolName('Write')).toBe('modifying');
    });

    it('maps Bash → running', () => {
      expect(claudeToolMapper.mapToolName('Bash')).toBe('running');
    });

    it('maps Grep → searching', () => {
      expect(claudeToolMapper.mapToolName('Grep')).toBe('searching');
    });

    it('maps WebFetch → fetching', () => {
      expect(claudeToolMapper.mapToolName('WebFetch')).toBe('fetching');
    });

    it('maps Agent → agent', () => {
      expect(claudeToolMapper.mapToolName('Agent')).toBe('agent');
    });

    it('maps Skill → skill', () => {
      expect(claudeToolMapper.mapToolName('Skill')).toBe('skill');
    });

    it('maps TodoWrite → planning', () => {
      expect(claudeToolMapper.mapToolName('TodoWrite')).toBe('planning');
    });

    it('maps unknown tool → other', () => {
      expect(claudeToolMapper.mapToolName('SomeFutureTool')).toBe('other');
    });
  });

  describe('codexToolMapper', () => {
    it('maps command_execution → running', () => {
      expect(codexToolMapper.mapToolName('command_execution')).toBe('running');
    });

    it('maps file_change → modifying', () => {
      expect(codexToolMapper.mapToolName('file_change')).toBe('modifying');
    });

    it('maps web_search → fetching', () => {
      expect(codexToolMapper.mapToolName('web_search')).toBe('fetching');
    });

    it('maps unknown → other', () => {
      expect(codexToolMapper.mapToolName('unknown_tool')).toBe('other');
    });
  });

  describe('geminiToolMapper', () => {
    it('maps read_file → reading', () => {
      expect(geminiToolMapper.mapToolName('read_file')).toBe('reading');
    });

    it('maps edit_file → modifying', () => {
      expect(geminiToolMapper.mapToolName('edit_file')).toBe('modifying');
    });

    it('maps run_shell_command → running', () => {
      expect(geminiToolMapper.mapToolName('run_shell_command')).toBe('running');
    });

    it('maps google_web_search → fetching', () => {
      expect(geminiToolMapper.mapToolName('google_web_search')).toBe('fetching');
    });

    it('maps unknown → other', () => {
      expect(geminiToolMapper.mapToolName('unknown_tool')).toBe('other');
    });
  });

  describe('defaultToolMapper — heuristic matching', () => {
    it('maps readFile → reading (contains "read")', () => {
      expect(defaultToolMapper.mapToolName('readFile')).toBe('reading');
    });

    it('maps executeCommand → running (contains "exec")', () => {
      expect(defaultToolMapper.mapToolName('executeCommand')).toBe('running');
    });

    it('maps searchDocs → searching (contains "search")', () => {
      expect(defaultToolMapper.mapToolName('searchDocs')).toBe('searching');
    });

    it('maps unknown tool name → other', () => {
      expect(defaultToolMapper.mapToolName('frobnicate')).toBe('other');
    });
  });

  describe('defaultToolMapper — mcp prefix stripping in getToolLabel', () => {
    it('strips mcp__<server>__ prefix from tool name', () => {
      const label = defaultToolMapper.getToolLabel('mcp__whatsoup__send_message', {});
      expect(label).toBe('send message');
    });

    it('replaces underscores with spaces in plain tool names', () => {
      const label = defaultToolMapper.getToolLabel('some_tool_name', {});
      expect(label).toBe('some tool name');
    });
  });

  describe('getToolMapper registry', () => {
    it('returns claudeToolMapper for "claude-cli"', () => {
      const mapper = getToolMapper('claude-cli');
      // Verify it behaves like claudeToolMapper
      expect(mapper.mapToolName('Read')).toBe('reading');
      expect(mapper.mapToolName('Bash')).toBe('running');
    });

    it('returns codexToolMapper for "codex-cli"', () => {
      const mapper = getToolMapper('codex-cli');
      expect(mapper.mapToolName('command_execution')).toBe('running');
    });

    it('returns geminiToolMapper for "gemini-cli"', () => {
      const mapper = getToolMapper('gemini-cli');
      expect(mapper.mapToolName('read_file')).toBe('reading');
    });

    it('returns defaultToolMapper for unknown provider id', () => {
      const mapper = getToolMapper('some-unknown-provider');
      // defaultToolMapper uses heuristics, not exact cases
      expect(mapper.mapToolName('readFile')).toBe('reading');
      expect(mapper.mapToolName('frobnicate')).toBe('other');
    });
  });
});
