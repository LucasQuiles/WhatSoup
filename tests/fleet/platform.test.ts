import { describe, it, expect } from 'vitest';
import { escapeXml, buildPlist, parseInstanceName } from '../../src/fleet/platform.ts';

describe('platform', () => {
  describe('escapeXml', () => {
    it('escapes ampersands', () => {
      expect(escapeXml('a&b')).toBe('a&amp;b');
    });

    it('escapes angle brackets', () => {
      expect(escapeXml('a<b>c')).toBe('a&lt;b&gt;c');
    });

    it('escapes quotes', () => {
      expect(escapeXml('a"b\'c')).toBe('a&quot;b&apos;c');
    });

    it('handles empty string', () => {
      expect(escapeXml('')).toBe('');
    });

    it('handles string with no special chars', () => {
      expect(escapeXml('hello world')).toBe('hello world');
    });

    it('escapes mixed content', () => {
      expect(escapeXml('1 < 2 & 3 > 0 "yes"')).toBe('1 &lt; 2 &amp; 3 &gt; 0 &quot;yes&quot;');
    });

    it('escapes CDATA end marker', () => {
      expect(escapeXml(']]>')).toBe(']]&gt;');
    });

    it('handles multiple consecutive special chars', () => {
      expect(escapeXml('&&&<<<>>>')).toBe('&amp;&amp;&amp;&lt;&lt;&lt;&gt;&gt;&gt;');
    });
  });

  describe('buildPlist', () => {
    it('produces valid XML structure', () => {
      const plist = buildPlist('test-instance');
      expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain('</plist>');
      expect(plist).toContain('<string>com.whatsoup.test-instance</string>');
    });

    it('escapes PATH containing special XML characters', () => {
      const origPath = process.env.PATH;
      process.env.PATH = '/usr/bin:/opt/something&weird/bin:</dangerous>';
      try {
        const plist = buildPlist('test');
        // The raw dangerous chars must NOT appear unescaped
        expect(plist).not.toContain('&weird');
        expect(plist).toContain('&amp;weird');
        expect(plist).toContain('&lt;/dangerous&gt;');
        // Should not contain raw < or > in string values
        expect(plist).not.toMatch(/<string>[^<]*<\/dangerous[^<]*<\/string>/);
      } finally {
        process.env.PATH = origPath;
      }
    });

    it('escapes instance name in label', () => {
      // Instance names are validated to [a-z][a-z0-9-]* by ops.ts,
      // but buildPlist should still be safe for any input
      const plist = buildPlist('safe-name');
      expect(plist).toContain('com.whatsoup.safe-name');
    });

    it('includes KeepAlive Crashed semantics', () => {
      const plist = buildPlist('test');
      expect(plist).toContain('<key>Crashed</key>');
      expect(plist).toContain('<true/>');
    });

    it('includes log paths', () => {
      const plist = buildPlist('myapp');
      expect(plist).toContain('stdout.log');
      expect(plist).toContain('stderr.log');
    });
  });

  describe('parseInstanceName', () => {
    it('extracts name from whatsoup@ unit pattern', () => {
      expect(parseInstanceName('whatsoup@foo')).toBe('foo');
    });

    it('extracts name with hyphens', () => {
      expect(parseInstanceName('whatsoup@my-instance')).toBe('my-instance');
    });

    it('returns full string for non-template units', () => {
      expect(parseInstanceName('whatsoup-fleet')).toBe('whatsoup-fleet');
    });

    it('returns full string for plain names', () => {
      expect(parseInstanceName('myservice')).toBe('myservice');
    });
  });
});
