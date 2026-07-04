// @check CHK-021
// @traces REQ-005.AC-02
import { describe, it, expect } from 'vitest';
import { classifyInput } from '../../../src/runtimes/agent/commands.ts';

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
    it('bare slash "/" returns forwarded (no command name)', () => {
      // "/" → commandName is "" which is not a local command
      const result = classifyInput('/');
      expect(result.type).toBe('forwarded');
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
    expect(classifyInput('/why')).toEqual({ type: 'forwarded', text: '/why' });
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

  it('/why returns local command "why"', () => {
    expect(classifyInput('/why', NL)).toEqual({ type: 'local', command: 'why' });
  });

  it('/reset returns local command "reset"', () => {
    expect(classifyInput('/reset', NL)).toEqual({ type: 'local', command: 'reset' });
  });

  it('/Model (mixed case) is local', () => {
    expect(classifyInput('/Model fastest', NL)).toEqual({ type: 'local', command: 'model', args: 'fastest' });
  });

  it('/route stays forwarded even with routing aliases ON (not part of the 3-alias set)', () => {
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

  it('/model with extra words forwards (recognized grammar is exactly one arg)', () => {
    expect(classifyInput('/model strongest please', NL)).toEqual({ type: 'forwarded', text: '/model strongest please' });
  });

  it('arged /why forwards; bare /why stays local', () => {
    expect(classifyInput('/why because', NL)).toEqual({ type: 'forwarded', text: '/why because' });
    expect(classifyInput('/why', NL)).toEqual({ type: 'local', command: 'why' });
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
    expect(classifyInput('/why ', NL)).toEqual({ type: 'local', command: 'why' });
    expect(classifyInput('/model ', NL)).toEqual({ type: 'local', command: 'model' });
  });

  it('a trailing space after a /model verb still classifies local with the verb as args', () => {
    expect(classifyInput('/model strongest ', NL)).toEqual({ type: 'local', command: 'model', args: 'strongest' });
  });

  it('a base local command with a trailing space is unaffected', () => {
    expect(classifyInput('/status ')).toEqual({ type: 'local', command: 'status' });
    expect(classifyInput('/new ')).toEqual({ type: 'local', command: 'new' });
  });

  it('a bare slash with only whitespace still forwards (no command name)', () => {
    expect(classifyInput('/ ').type).toBe('forwarded');
  });
});
