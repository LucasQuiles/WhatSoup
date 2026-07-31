// @check CHK-021
// @traces REQ-005.AC-02
import { describe, it, expect } from 'vitest';
import { classifyInput } from '../../../src/runtimes/agent/commands.ts';
import { COMMAND_REGISTRY, type CommandSpec } from '../../../src/runtimes/agent/command-registry.ts';

// Widen the `as const` narrow tuple so optional-field reads typecheck (same
// reason as the production derivation — the T1-worker flag; matches the cast
// the landed command-registry.test.ts already uses).
const REGISTRY = COMMAND_REGISTRY as readonly CommandSpec[];

describe('classifyInput', () => {
  describe('local commands', () => {
    it('/new returns local command "new"', () => {
      expect(classifyInput('/new')).toEqual({ type: 'local', command: 'new' });
    });

    it('/status returns local command "status"', () => {
      expect(classifyInput('/status')).toEqual({ type: 'local', command: 'status' });
    });

    it('/help returns local command "help"', () => {
      expect(classifyInput('/help')).toEqual({ type: 'local', command: 'help' });
    });

    it('/NEW (uppercase) is treated as local command', () => {
      expect(classifyInput('/NEW')).toEqual({ type: 'local', command: 'new' });
    });

    it('/Status (mixed case) is treated as local command', () => {
      expect(classifyInput('/Status')).toEqual({ type: 'local', command: 'status' });
    });

    it('/HELP (uppercase) is treated as local command', () => {
      expect(classifyInput('/HELP')).toEqual({ type: 'local', command: 'help' });
    });
  });

  describe('forwarded slash commands', () => {
    it('/compact is forwarded with the original text', () => {
      expect(classifyInput('/compact')).toEqual({ type: 'forwarded', text: '/compact' });
    });

    it('/clear is forwarded', () => {
      expect(classifyInput('/clear')).toEqual({ type: 'forwarded', text: '/clear' });
    });

    it('/Compact (mixed case) is forwarded with original text preserved', () => {
      expect(classifyInput('/Compact')).toEqual({ type: 'forwarded', text: '/Compact' });
    });

    it('/unknown-command is forwarded', () => {
      expect(classifyInput('/unknown-command')).toEqual({
        type: 'forwarded',
        text: '/unknown-command',
      });
    });

    it('/compact with arguments is forwarded', () => {
      expect(classifyInput('/compact some args')).toEqual({
        type: 'forwarded',
        text: '/compact some args',
      });
    });

    it('/review-pr is forwarded', () => {
      expect(classifyInput('/review-pr')).toEqual({
        type: 'forwarded',
        text: '/review-pr',
      });
    });

    it('forwarded text preserves the exact original input', () => {
      const input = '/clear --all';
      const result = classifyInput(input);
      expect(result).toEqual({ type: 'forwarded', text: input });
    });
  });

  describe('regular messages', () => {
    it('plain text (no slash) returns message type', () => {
      expect(classifyInput('Hello!')).toEqual({ type: 'message', text: 'Hello!' });
    });

    it('empty string returns message type', () => {
      expect(classifyInput('')).toEqual({ type: 'message', text: '' });
    });

    it('whitespace-only string returns message type', () => {
      expect(classifyInput('   ')).toEqual({ type: 'message', text: '   ' });
    });

    it('text that contains a slash (not at start) returns message type', () => {
      expect(classifyInput('foo/bar')).toEqual({ type: 'message', text: 'foo/bar' });
    });

    it('text starting with a URL is a message, not a command', () => {
      const url = 'https://example.com/path';
      expect(classifyInput(url)).toEqual({ type: 'message', text: url });
    });

    it('multi-line message without leading slash returns message type', () => {
      const msg = 'Hello\nworld\n/not-a-command-since-not-at-start';
      expect(classifyInput(msg)).toEqual({ type: 'message', text: msg });
    });
  });

  describe('session admin commands (AE5)', () => {
    it('/sessions returns local command "sessions"', () => {
      expect(classifyInput('/sessions')).toEqual({ type: 'local', command: 'sessions' });
    });

    it('/kill-session 2 returns local command with args', () => {
      expect(classifyInput('/kill-session 2')).toEqual({
        type: 'local', command: 'kill-session', args: '2',
      });
    });

    it('/kill-session without args returns local command with undefined args', () => {
      expect(classifyInput('/kill-session')).toEqual({
        type: 'local', command: 'kill-session',
      });
    });

    it('/SESSIONS (uppercase) is treated as local command', () => {
      expect(classifyInput('/SESSIONS')).toEqual({ type: 'local', command: 'sessions' });
    });

    it('/Kill-Session 5 (mixed case) returns local with args', () => {
      expect(classifyInput('/Kill-Session 5')).toEqual({
        type: 'local', command: 'kill-session', args: '5',
      });
    });
  });

  describe('edge cases', () => {
    it.each(['/', '/ ', '/\t', '/\n'])('bare slash input %j opens the local help menu', (input) => {
      expect(classifyInput(input)).toEqual({ type: 'local', command: 'help' });
    });

    it('command name is extracted from first whitespace-delimited token', () => {
      // "/new extra" — "new" is local even with trailing args
      expect(classifyInput('/new start fresh')).toEqual({ type: 'local', command: 'new', args: 'start fresh' });
    });
  });
});



describe('routing aliases (NL-first design, owner-approved PR-plan v2)', () => {
  const NL = { routingAliases: true };

  it('flag OFF (default): /model stays forwarded — byte-identical to today', () => {
    expect(classifyInput('/model strongest')).toEqual({ type: 'forwarded', text: '/model strongest' });
    expect(classifyInput('/reset')).toEqual({ type: 'forwarded', text: '/reset' });
  });

  it('flag OFF: existing local commands are unaffected by the opts param', () => {
    expect(classifyInput('/status', NL)).toEqual({ type: 'local', command: 'status' });
  });

  it('/model strongest returns local command "model" with args', () => {
    expect(classifyInput('/model strongest', NL)).toEqual({ type: 'local', command: 'model', args: 'strongest' });
  });

  it('bare /model returns local command "model" with no args (= status)', () => {
    expect(classifyInput('/model', NL)).toEqual({ type: 'local', command: 'model' });
  });

  it('/why is removed: always forwards, even with routing aliases ON (D11)', () => {
    expect(classifyInput('/why', NL)).toEqual({ type: 'forwarded', text: '/why' });
  });

  it('/reset returns local command "reset"', () => {
    expect(classifyInput('/reset', NL)).toEqual({ type: 'local', command: 'reset' });
  });

  it('/Model (mixed case) is local', () => {
    expect(classifyInput('/Model fastest', NL)).toEqual({ type: 'local', command: 'model', args: 'fastest' });
  });

  it('/route stays forwarded even with routing aliases ON (not part of the alias set)', () => {
    expect(classifyInput('/route', NL)).toEqual({ type: 'forwarded', text: '/route' });
  });

  it('/delegate stays forwarded even with routing aliases ON', () => {
    expect(classifyInput('/delegate review', NL)).toEqual({ type: 'forwarded', text: '/delegate review' });
  });

  it('/runtime stays forwarded even with routing aliases ON (operator surface is a separate PR)', () => {
    expect(classifyInput('/runtime health', NL)).toEqual({ type: 'forwarded', text: '/runtime health' });
  });
});

describe('routing aliases — forwarded-capability fallthrough (F04)', () => {
  const NL = { routingAliases: true };

  it('/model with an unrecognized arg forwards (base /model capability preserved)', () => {
    expect(classifyInput('/model sonnet', NL)).toEqual({ type: 'forwarded', text: '/model sonnet' });
  });

  it('/model with a compiled-in provider id stays local', () => {
    expect(classifyInput('/model claude-cli', NL)).toEqual({ type: 'local', command: 'model', args: 'claude-cli' });
  });

  it('B26: /model list is local when routing aliases are ON, forwarded when OFF (D7)', () => {
    expect(classifyInput('/model list', NL)).toEqual({ type: 'local', command: 'model', args: 'list' });
    expect(classifyInput('/model list')).toEqual({ type: 'forwarded', text: '/model list' });
  });

  it('/model with extra words forwards (recognized grammar is exactly one arg)', () => {
    expect(classifyInput('/model strongest please', NL)).toEqual({ type: 'forwarded', text: '/model strongest please' });
  });

  it('Slice 1: /model <vendor/model> is a local direct selector; slash-less and free-text stay forwarded (F04)', () => {
    // The new local grammar — a slashed vendor/model id classifies local so
    // the direct selector (model-pin.ts) can pin it in one step.
    expect(classifyInput('/model opencode-cli/kimi-k3', NL)).toEqual({ type: 'local', command: 'model', args: 'opencode-cli/kimi-k3' });
    expect(classifyInput('/model anthropic/claude-opus-4-8', NL)).toEqual({ type: 'local', command: 'model', args: 'anthropic/claude-opus-4-8' });
    // Case is PRESERVED in args (model ids are case-sensitive) even though the
    // command name is lowercased.
    expect(classifyInput('/model Vendor/Model-X', NL)).toEqual({ type: 'local', command: 'model', args: 'Vendor/Model-X' });
    // A slash-less token is NOT a vendor/model id — it stays on the
    // provider-id/verb path or forwards, unchanged by Slice 1 (F04).
    expect(classifyInput('/model gpt-4o', NL)).toEqual({ type: 'forwarded', text: '/model gpt-4o' });
    // Free text (spaces) still forwards to the agent's own /model.
    expect(classifyInput('/model the best kimi', NL)).toEqual({ type: 'forwarded', text: '/model the best kimi' });
    // Flag OFF: even a vendor/model id forwards — byte-identical to today.
    expect(classifyInput('/model opencode-cli/kimi-k3')).toEqual({ type: 'forwarded', text: '/model opencode-cli/kimi-k3' });
  });

  it('/why is removed: forwards whether bare or arged (D11)', () => {
    expect(classifyInput('/why because', NL)).toEqual({ type: 'forwarded', text: '/why because' });
    expect(classifyInput('/why', NL)).toEqual({ type: 'forwarded', text: '/why' });
  });

  it('arged /reset forwards; bare /reset stays local', () => {
    expect(classifyInput('/reset everything', NL)).toEqual({ type: 'forwarded', text: '/reset everything' });
    expect(classifyInput('/reset', NL)).toEqual({ type: 'local', command: 'reset' });
  });
});

describe('routing aliases — trailing whitespace grammar (R10)', () => {
  const NL = { routingAliases: true };

  it('a trailing space on a bare alias still classifies local (matches base /status )', () => {
    expect(classifyInput('/reset ', NL)).toEqual({ type: 'local', command: 'reset' });
    expect(classifyInput('/model ', NL)).toEqual({ type: 'local', command: 'model' });
  });

  it('a trailing space after a /model verb still classifies local with the verb as args', () => {
    expect(classifyInput('/model strongest ', NL)).toEqual({ type: 'local', command: 'model', args: 'strongest' });
  });

  it('a base local command with a trailing space is unaffected', () => {
    expect(classifyInput('/status ')).toEqual({ type: 'local', command: 'status' });
    expect(classifyInput('/new ')).toEqual({ type: 'local', command: 'new' });
  });

  it('routing-alias mode does not change the bare slash menu', () => {
    expect(classifyInput('/ ', NL)).toEqual({ type: 'local', command: 'help' });
  });
});

describe('classifier sets derive from COMMAND_REGISTRY (W1-T2)', () => {
  // These literals are the pre-refactor membership. The derivation must reproduce
  // them exactly, or classifier behavior changed.
  it('LOCAL_COMMANDS membership is unchanged (non-routing-alias names)', () => {
    const derived = REGISTRY.filter((c) => !c.routingAlias).map((c) => c.name).sort();
    expect(derived).toEqual(['help', 'kill-session', 'new', 'sessions', 'status']);
  });
  it('ROUTING_ALIAS_COMMANDS membership no longer includes why (D11)', () => {
    const derived = REGISTRY.filter((c) => c.routingAlias).map((c) => c.name).sort();
    expect(derived).toEqual(['model', 'reset']);
  });
  it('ROUTING_MODEL_VERBS membership carries the B26 catalogue verb, no longer default (D12)', () => {
    const model = REGISTRY.find((c) => c.name === 'model');
    expect(model?.subVerbs).toEqual(['status', 'list', 'strongest', 'fastest']);
  });
});

describe('nlRouting flag matrix stays byte-identical (G7/D7)', () => {
  // FLAG OFF: routing aliases forward untouched (today’s behavior).
  it('flag OFF — /model, /why, /reset all forward', () => {
    for (const t of ['/model', '/model strongest', '/why', '/reset']) {
      expect(classifyInput(t)).toEqual({ type: 'forwarded', text: t });
    }
  });
  // FLAG ON: recognized grammar is claimed local; unrecognized still forwards (F04).
  it('flag ON — bare aliases and recognized /model grammar are local; /why always forwards (D11)', () => {
    expect(classifyInput('/model', { routingAliases: true })).toEqual({ type: 'local', command: 'model' });
    expect(classifyInput('/model strongest', { routingAliases: true }))
      .toEqual({ type: 'local', command: 'model', args: 'strongest' });
    expect(classifyInput('/why', { routingAliases: true })).toEqual({ type: 'forwarded', text: '/why' });
    expect(classifyInput('/reset', { routingAliases: true })).toEqual({ type: 'local', command: 'reset' });
  });
  it('flag ON — unrecognized /model 2nd token still forwards (F04 capability preservation)', () => {
    expect(classifyInput('/model sonnet --verbose', { routingAliases: true }))
      .toEqual({ type: 'forwarded', text: '/model sonnet --verbose' });
  });
});

describe('structured /model grammar (C1 — agent-assisted design)', () => {
  it('routes structured numbered forms local', () => {
    expect(classifyInput('/model 2', { routingAliases: true })).toMatchObject({ type: 'local', command: 'model', args: '2' });
    expect(classifyInput('/model 2b', { routingAliases: true }).type).toBe('local');
    expect(classifyInput('/model 2 default', { routingAliases: true }).type).toBe('local');
    expect(classifyInput('/model list openai', { routingAliases: true }).type).toBe('local');
  });
  it('FORWARDS free text to the agent (agent-assisted NL)', () => {
    expect(classifyInput('/model the best kimi', { routingAliases: true }).type).toBe('forwarded');
  });
  it('keeps bare + verb + provider-id local; all forward when flag OFF', () => {
    expect(classifyInput('/model', { routingAliases: true })).toMatchObject({ type: 'local', command: 'model' });
    expect(classifyInput('/model strongest', { routingAliases: true })).toMatchObject({ type: 'local', command: 'model' });
    expect(classifyInput('/model the best kimi').type).toBe('forwarded'); // flag off
  });
});

// #2357 shadow classification: detect compound command+body (slash command
// followed by a nonblank multi-line remainder). Detection-only — runtime
// behavior is unchanged. The body is preserved byte-for-byte.
describe('classifyInput compound body shadow detection (#2357)', () => {
  it('detects compound body on a local command', () => {
    const result = classifyInput('/status\ndo the task');
    expect(result.type).toBe('local');
    expect(result.command).toBe('status');
    expect(result.compoundBody).toBe('do the task');
  });

  it('detects compound body on a forwarded command', () => {
    const result = classifyInput('/plugin:workflow\nrun the thing');
    expect(result.type).toBe('forwarded');
    expect(result.compoundBody).toBe('run the thing');
  });

  it('preserves body byte-for-byte including line endings and leading whitespace', () => {
    const body = '  indented line\nsecond line\n';
    const result = classifyInput(`/status\n${body}`);
    expect(result.compoundBody).toBe(body);
  });

  it('preserves CRLF in the body', () => {
    const result = classifyInput('/status\r\nbody line');
    // The body after the first \n is 'body line' — the \r stays on the command line
    expect(result.compoundBody).toBe('body line');
  });

  it('preserves CRLF line endings within the body', () => {
    const result = classifyInput('/status\nline1\r\nline2');
    expect(result.compoundBody).toBe('line1\r\nline2');
  });

  it('returns no compoundBody for single-line command', () => {
    expect(classifyInput('/status').compoundBody).toBeUndefined();
    expect(classifyInput('/status arg').compoundBody).toBeUndefined();
  });

  it('returns no compoundBody when remainder is blank', () => {
    expect(classifyInput('/status\n').compoundBody).toBeUndefined();
    expect(classifyInput('/status\n   ').compoundBody).toBeUndefined();
    expect(classifyInput('/status\n\n\n').compoundBody).toBeUndefined();
  });

  it('returns no compoundBody for non-slash messages', () => {
    const result = classifyInput('hello\nworld');
    expect(result.type).toBe('message');
    expect((result as { type: 'message' }).compoundBody).toBeUndefined();
  });

  it('returns no compoundBody for bare slash (help)', () => {
    expect(classifyInput('/').compoundBody).toBeUndefined();
    expect(classifyInput('/\n').compoundBody).toBeUndefined();
    // Note: '/\nbody' is NOT a bare slash — after stripping '/', "body" becomes
    // an unknown command name → forwarded, with compoundBody='body'.
  });

  it('does not change args behavior (shadow: args still includes body tokens)', () => {
    // Shadow phase: args are unchanged — the body tokens still appear in args.
    // Promotion to dual-phase will separate them.
    const result = classifyInput('/status arg\ndo task');
    expect(result.type).toBe('local');
    expect(result.args).toBe('arg do task');
    expect(result.compoundBody).toBe('do task');
  });

  it('detects compound body with routing aliases enabled', () => {
    // Bare /model (parts.length===1) stays local even with a body line:
    const result = classifyInput('/model\nswitch to kimi', { routingAliases: true });
    // NOTE: the body tokens inflate parts.length, so this forwards (structured
    // grammar fails for multi-line content). This is CORRECT shadow behavior —
    // the body is preserved in compoundBody regardless of local/forwarded.
    expect(result.compoundBody).toBe('switch to kimi');
  });

  it('detects compound body on unknown forwarded command', () => {
    const result = classifyInput('/unknown\ntask body');
    expect(result.type).toBe('forwarded');
    expect(result.compoundBody).toBe('task body');
  });
});
