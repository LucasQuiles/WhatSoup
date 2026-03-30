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

  describe('edge cases', () => {
    it('bare slash "/" returns forwarded (no command name)', () => {
      // "/" → commandName is "" which is not a local command
      const result = classifyInput('/');
      expect(result.type).toBe('forwarded');
    });

    it('command name is extracted from first whitespace-delimited token', () => {
      // "/new extra" — "new" is local even with trailing args
      expect(classifyInput('/new start fresh')).toEqual({ type: 'local', command: 'new' });
    });
  });
});
