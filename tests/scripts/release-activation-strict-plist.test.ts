import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStrictPlist, strictPlistStrings, strictStringArray, strictStringDict } from '../../scripts/lib/release-activation/strict-plist.ts';
import { plist } from '../helpers/release-activate-world.ts';

// Written as code points so the source holds no invisible character.
const BOM = String.fromCharCode(0xfeff);
const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
/** One plist document around a root dict body. */
const document = (body: string, prolog = PROLOG): string => `${prolog}<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
const refusal = (text: string): string | null => {
  const read = readStrictPlist(text);
  return read.ok ? null : read.error;
};
const rootOf = (text: string) => {
  const read = readStrictPlist(text);
  if (!read.ok) throw new Error(read.error);
  return read.root;
};

describe('strict plist reader', () => {
  it('reads every plist value type, decodes the five predefined entities, and skips comments between elements', () => {
    const root = rootOf(document([
      '  <!-- a comment between elements -->',
      '  <key>Label</key><string>com.example.job</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>/opt/example/bin/tool</string>',
      '    <string>a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;</string>',
      '    <string/>',
      '  </array>',
      '  <key>Nested</key>',
      '  <dict><key>Hour</key><integer>7</integer><key>Ratio</key><real>0.5</real><key>When</key><date>2026-01-01T00:00:00Z</date>',
      '  <key>Blob</key><data>AA==</data><key>On</key><true/><key>Off</key><false/><key>Empty</key><dict/><key>None</key><array/></dict>',
    ].join('\n')));
    expect(root.get('Label')).toEqual({ kind: 'string', value: 'com.example.job' });
    expect(strictStringArray(root, 'ProgramArguments')).toEqual({ values: ['/opt/example/bin/tool', 'a <b> & "c" \'d\'', ''] });
    expect(root.get('Nested')).toEqual({ kind: 'dict', entries: new Map<string, unknown>([
      ['Hour', { kind: 'integer', text: '7' }], ['Ratio', { kind: 'real', text: '0.5' }], ['When', { kind: 'date', text: '2026-01-01T00:00:00Z' }],
      ['Blob', { kind: 'data', text: 'AA==' }], ['On', { kind: 'boolean', value: true }], ['Off', { kind: 'boolean', value: false }],
      ['Empty', { kind: 'dict', entries: new Map() }], ['None', { kind: 'array', items: [] }],
    ]) });
    expect(strictPlistStrings(root)).toEqual(['com.example.job', '/opt/example/bin/tool', 'a <b> & "c" \'d\'', '']);
  });

  it.each(['com.whatsoup.harness-maintenance', 'com.whatsoup.reply-guarantee'])('reads the repository template deploy/%s.plist', (label) => {
    const root = rootOf(readFileSync(path.join(process.cwd(), 'deploy', `${label}.plist`), 'utf8'));
    expect(root.get('Label')).toEqual({ kind: 'string', value: label });
    const environment = strictStringDict(root, 'EnvironmentVariables');
    expect('entries' in environment ? [...environment.entries.keys()] : environment).toEqual(['PATH']);
  });

  it('reads the test plist helper, a plist that starts at <plist>, and a comment after </plist>', () => {
    expect(strictStringArray(rootOf(plist('com.example.job', ['/bin/bash', '/opt/x.sh'], '/opt')), 'ProgramArguments')).toEqual({ values: ['/bin/bash', '/opt/x.sh'] });
    expect(refusal('<plist version="1.0"><dict><key>A</key><string>x</string></dict></plist>\n<!-- end -->\n')).toBeNull();
  });

  it('reads no string out of a comment, even one that holds a non-canonical <string>', () => {
    expect(strictPlistStrings(rootOf(document('<!-- <string>/tmp/../x</string> --><key>A</key><string>/opt/x</string>')))).toEqual(['/opt/x']);
  });

  it.each([
    { name: 'a binary plist', text: `bplist00${document('')}`, error: 'plist is a binary property list; only XML is admitted' },
    { name: 'a byte-order mark', text: `${BOM}${document('')}`, error: 'plist starts with a byte-order mark' },
    { name: 'leading whitespace', text: ` ${document('')}`, error: 'plist does not start with an XML declaration or <plist>' },
    { name: 'UTF-16 text read as UTF-8', text: Buffer.from(`${BOM}${document('')}`, 'utf16le').toString('utf8'), error: 'plist does not start with an XML declaration or <plist>' },
    { name: 'XML version 1.1', text: document('', '<?xml version="1.1"?>\n'), error: 'plist XML declaration is malformed' },
    { name: 'a declared UTF-16 encoding', text: document('', '<?xml version="1.0" encoding="UTF-16"?>\n'), error: 'plist declares encoding UTF-16; only UTF-8 is admitted' },
    { name: 'a control character', text: document('<key>A</key><string>\u0001</string>'), error: 'plist holds a control character or an undecodable byte' },
    { name: 'an undecodable byte', text: document(`<key>A</key><string>${String.fromCharCode(0xfffd)}</string>`), error: 'plist holds a control character or an undecodable byte' },
    { name: 'a DOCTYPE internal subset', text: document('<key>&k;</key><string>x</string>', '<?xml version="1.0"?>\n<!DOCTYPE plist [<!ENTITY k "Label">]>\n'), error: 'plist DOCTYPE has an internal subset or entity declaration' },
    { name: 'an entity declaration in the content', text: document('<!ENTITY k "Label"><key>A</key><string>x</string>'), error: 'plist DOCTYPE has an internal subset or entity declaration' },
    { name: 'a malformed DOCTYPE', text: document('', '<?xml version="1.0"?>\n<!DOCTYPE plist PUBLIC>\n'), error: 'plist DOCTYPE is malformed' },
    { name: 'a processing instruction in the prolog', text: document('', '<?xml version="1.0"?>\n<?xml-stylesheet href="x"?>\n'), error: 'plist holds a processing instruction' },
    { name: 'a processing instruction in a dict', text: document('<?pi x?><key>A</key><string>x</string>'), error: 'plist holds a processing instruction' },
    { name: 'a CDATA string value', text: document('<key>A</key><string><![CDATA[x]]></string>'), error: 'plist holds a CDATA section' },
    { name: 'a CDATA key', text: document('<key><![CDATA[A]]></key><string>x</string>'), error: 'plist holds a CDATA section' },
    { name: 'a numeric character reference in a string', text: document('<key>A</key><string>&#47;x</string>'), error: 'plist holds a numeric character reference' },
    { name: 'a numeric character reference in a key', text: document('<key>A&#66;</key><string>x</string>'), error: 'plist holds a numeric character reference' },
    { name: 'an undefined entity', text: document('<key>A</key><string>&nbsp;</string>'), error: 'plist holds an undefined or malformed entity reference' },
    { name: 'a bare ampersand', text: document('<key>A</key><string>a & b</string>'), error: 'plist holds an undefined or malformed entity reference' },
    { name: 'a predefined entity in a key', text: document('<key>A&amp;B</key><string>x</string>'), error: 'plist <key> holds an entity reference' },
    { name: 'leading whitespace in a key', text: document('<key> A</key><string>x</string>'), error: 'plist <key> text has surrounding whitespace' },
    { name: 'a trailing newline in a key', text: document('<key>A\n</key><string>x</string>'), error: 'plist <key> text has surrounding whitespace' },
    { name: 'a comment inside a key', text: document('<key>A<!-- c --></key><string>x</string>'), error: 'plist <key> holds markup' },
    { name: 'a comment inside a string', text: document('<key>A</key><string>a<!-- c -->b</string>'), error: 'plist <string> holds markup' },
    { name: 'a duplicate root key', text: document('<key>A</key><string>x</string><key>A</key><string>y</string>'), error: 'plist has a duplicate key A' },
    { name: 'a duplicate nested key', text: document('<key>A</key><dict><key>B</key><true/><key>B</key><false/></dict>'), error: 'plist has a duplicate key B' },
    { name: 'content after </plist>', text: `${document('')}x`, error: 'plist has content after </plist>' },
    { name: 'a second root dict', text: `${PROLOG}<plist version="1.0">\n<dict/>\n<dict/>\n</plist>\n`, error: 'plist root is not exactly one <dict> inside <plist version="1.0">' },
    { name: 'an array root', text: `${PROLOG}<plist version="1.0">\n<array/>\n</plist>\n`, error: 'plist root is not exactly one <dict> inside <plist version="1.0">' },
    { name: 'a plist element without its version', text: `${PROLOG}<plist>\n<dict/>\n</plist>\n`, error: 'plist root is not exactly one <dict> inside <plist version="1.0">' },
    { name: 'an attribute on a value', text: document('<key>A</key><string id="x">y</string>'), error: 'plist is malformed: <string> has attributes' },
    { name: 'an element that is not a plist value', text: document('<key>A</key><text>y</text>'), error: 'plist is malformed: <text> is not a plist value element' },
    { name: 'a value where a key belongs', text: document('<string>x</string>'), error: 'plist is malformed: <dict> holds <string> where a <key> belongs' },
    { name: 'a key without a value', text: document('<key>A</key>'), error: 'plist is malformed: <key> without a value' },
    { name: 'text between elements', text: document('<key>A</key>x<string>y</string>'), error: 'plist is malformed: text between elements' },
    { name: 'an unclosed array', text: document('<key>A</key><array><string>x</string>'), error: 'plist is malformed: expected </array>' },
    { name: 'a non-empty boolean', text: document('<key>A</key><true></true>'), error: 'plist is malformed: <true> must be empty' },
    { name: 'nesting deeper than 32', text: document(`<key>A</key>${'<array>'.repeat(40)}${'</array>'.repeat(40)}`), error: 'plist is malformed: nesting is deeper than 32' },
  ])('refuses $name', ({ text, error }) => {
    expect(refusal(text)).toBe(error);
  });

  it('reads string arrays and string dicts, naming the first value of another type', () => {
    const root = rootOf(document([
      '<key>ProgramArguments</key><array><string>a</string><integer>1</integer></array>',
      '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string><key>N</key><integer>1</integer></dict>',
      '<key>Flat</key><string>x</string>',
    ].join('\n')));
    expect(strictStringArray(root, 'ProgramArguments')).toEqual({ error: 'plist ProgramArguments entry 1 is not a <string>' });
    expect(strictStringDict(root, 'EnvironmentVariables')).toEqual({ error: 'plist EnvironmentVariables value for N is not a <string>' });
    expect(strictStringArray(root, 'Flat')).toEqual({ error: 'plist Flat is not an <array>' });
    expect(strictStringDict(root, 'Flat')).toEqual({ error: 'plist Flat is not a <dict>' });
    expect(strictStringArray(root, 'Missing')).toEqual({ values: [] });
    expect(strictStringDict(root, 'Missing')).toEqual({ entries: new Map() });
  });
});
