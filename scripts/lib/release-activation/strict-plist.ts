/**
 * A strict reader for the XML property lists that host activation proves before it rewrites or trusts them.
 *
 * launchd reads a job through CFPropertyList, which also accepts binary plists, other encodings, numeric character
 * references and CDATA sections. check-service-units.ts parsePlist reads text with regular expressions, so it can read
 * text launchd never sees (a binary plist's string object) or miss text launchd does see (a character reference that
 * spells a key). This reader admits only this form: UTF-8 XML from the first byte; no DOCTYPE, or only Apple's PLIST
 * 1.0 DOCTYPE; the five predefined entities in values and no other reference; no CDATA section, DOCTYPE internal
 * subset or processing instruction besides the XML declaration; no comment that starts with <!---; key text with no
 * entity, markup or surrounding whitespace; no markup inside a value; unique keys at every level; and exactly one root
 * <dict> inside <plist version="1.0">. It skips other comments outside a key or value, each ending at the first -->
 * after its opener. It does not prove that launchd reads the same dictionary from the bytes it admits. Callers read
 * files as UTF-8, so an invalid byte sequence arrives as U+FFFD, which this reader refuses.
 */

export type StrictPlistValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'integer' | 'real' | 'date' | 'data'; readonly text: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'array'; readonly items: readonly StrictPlistValue[] }
  | { readonly kind: 'dict'; readonly entries: StrictPlistDict };

export type StrictPlistDict = ReadonlyMap<string, StrictPlistValue>;

export type StrictPlistRead = { readonly ok: true; readonly root: StrictPlistDict } | { readonly ok: false; readonly error: string };

const MAX_DEPTH = 32;
const ROOT_SHAPE = 'plist root is not exactly one <dict> inside <plist version="1.0">';
const ENTITIES = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);
const XML_DECLARATION = /<\?xml[ \t\r\n]+version=(["'])1\.0\1(?:[ \t\r\n]+encoding=(["'])([A-Za-z][A-Za-z0-9._-]*)\2)?(?:[ \t\r\n]+standalone=(["'])(?:yes|no)\4)?[ \t\r\n]*\?>/y;
// Apple's PLIST 1.0 DOCTYPE, on one line or two as the repository writers emit it, with the older Apple Computer public
// identifier that plist(5) shows. A quoted literal can hold `>` and a whole plist, and plutil reads a plist written
// inside a SYSTEM literal as the document, so no other DOCTYPE is admitted.
const APPLE_DOCTYPE = /<!DOCTYPE[ \t\r\n]+plist[ \t\r\n]+PUBLIC[ \t\r\n]+"-\/\/Apple(?: Computer)?\/\/DTD PLIST 1\.0\/\/EN"[ \t\r\n]+"http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"[ \t\r\n]*>/y;
// Key text can hold a path or other host text, so a refusal detail prints a key only in this bounded identifier form.
const DETAIL_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const PLIST_OPEN = /<plist[ \t\r\n]+version=(["'])1\.0\1[ \t\r\n]*>/y;
const ROOT_DICT = /<dict[ \t\r\n]*\/?>/y;
const START_TAG = /<([A-Za-z][A-Za-z0-9]*)[ \t\r\n]*(\/?)>/y;
const END_TAG = /<\/([A-Za-z][A-Za-z0-9]*)[ \t\r\n]*>/y;
const ATTRIBUTE_TAG = /<([A-Za-z][A-Za-z0-9]*)[ \t\r\n]+[^ \t\r\n/>]/y;

class StrictPlistRefusal extends Error {}

function refuse(message: string): never {
  throw new StrictPlistRefusal(message);
}

/** A key as a refusal detail prints it: the key itself in DETAIL_KEY's form, otherwise a fixed phrase that prints none of it. */
export function detailKey(key: string): string {
  return DETAIL_KEY.test(key) ? key : '(a name outside [A-Za-z_][A-Za-z0-9_.-]{0,63}, not shown)';
}

/** XML 1.0 forbids these code units in a document; U+FFFD is what an undecodable UTF-8 byte reads as. */
function hasNonXmlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffd || code === 0xfffe || code === 0xffff) return true;
  }
  return false;
}

function decodeText(raw: string): string {
  let decoded = '';
  let index = 0;
  for (let ampersand = raw.indexOf('&'); ampersand >= 0; ampersand = raw.indexOf('&', index)) {
    if (raw.startsWith('&#', ampersand)) refuse('plist holds a numeric character reference');
    const semicolon = raw.indexOf(';', ampersand);
    const value = semicolon < 0 ? undefined : ENTITIES.get(raw.slice(ampersand + 1, semicolon));
    if (value === undefined) refuse('plist holds an undefined or malformed entity reference');
    decoded += raw.slice(index, ampersand) + value;
    index = semicolon + 1;
  }
  return decoded + raw.slice(index);
}

class Reader {
  private position = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  document(): StrictPlistDict {
    const text = this.text;
    if (text.startsWith('bplist')) refuse('plist is a binary property list; only XML is admitted');
    if (text.charCodeAt(0) === 0xfeff) refuse('plist starts with a byte-order mark');
    if (!text.startsWith('<?xml') && !text.startsWith('<plist')) refuse('plist does not start with an XML declaration or <plist>');
    if (hasNonXmlCharacter(text)) refuse('plist holds a control character or an undecodable byte');
    if (text.startsWith('<?xml')) {
      const declaration = this.sticky(XML_DECLARATION);
      if (declaration === null) refuse('plist XML declaration is malformed');
      const encoding = declaration[3];
      if (encoding !== undefined && encoding.toLowerCase() !== 'utf-8') refuse(`plist declares encoding ${encoding}; only UTF-8 is admitted`);
    }
    this.misc();
    if (text.startsWith('<!DOCTYPE', this.position)) {
      if (this.sticky(APPLE_DOCTYPE) === null) {
        const close = text.indexOf('>', this.position);
        refuse(text.slice(this.position, close < 0 ? undefined : close).includes('[')
          ? 'plist DOCTYPE has an internal subset or entity declaration'
          : 'plist DOCTYPE is not the Apple PLIST 1.0 DOCTYPE');
      }
      this.misc();
    }
    if (text.startsWith('<!ENTITY', this.position)) refuse('plist DOCTYPE has an internal subset or entity declaration');
    if (this.sticky(PLIST_OPEN) === null) refuse(ROOT_SHAPE);
    this.misc();
    ROOT_DICT.lastIndex = this.position;
    if (!ROOT_DICT.test(text)) refuse(ROOT_SHAPE);
    const root = this.value(0);
    if (root.kind !== 'dict') refuse(ROOT_SHAPE);
    this.misc();
    if (!text.startsWith('</plist', this.position)) refuse(ROOT_SHAPE);
    this.end('plist');
    this.misc();
    if (this.position !== text.length) refuse('plist has content after </plist>');
    return root.entries;
  }

  private sticky(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.position;
    const match = pattern.exec(this.text);
    if (match !== null) this.position = pattern.lastIndex;
    return match;
  }

  private whitespace(): void {
    while (this.position < this.text.length && ' \t\r\n'.includes(this.text[this.position]!)) this.position += 1;
  }

  private comment(): void {
    // This reader ends a comment at the first --> after its <!-- opener. A reader that starts that search at the
    // opener's second dash ends <!---> at once and reads what follows. No repository writer emits <!---.
    if (this.text.startsWith('<!---', this.position)) refuse('plist holds a comment that starts with <!---');
    const end = this.text.indexOf('-->', this.position + 4);
    if (end < 0) refuse('plist is malformed: unterminated comment');
    this.position = end + 3;
  }

  /** Whitespace and comments outside the root element; a processing instruction there refuses. */
  private misc(): void {
    for (;;) {
      this.whitespace();
      if (this.text.startsWith('<!--', this.position)) this.comment();
      else if (this.text.startsWith('<?', this.position)) refuse('plist holds a processing instruction');
      else return;
    }
  }

  /** Whitespace and comments between elements; any other text refuses. */
  private between(): void {
    for (;;) {
      this.whitespace();
      if (this.text.startsWith('<!--', this.position)) { this.comment(); continue; }
      if (this.position >= this.text.length) refuse('plist is malformed: unexpected end');
      if (this.text[this.position] !== '<') refuse('plist is malformed: text between elements');
      return;
    }
  }

  private refuseMarkup(): never {
    const rest = this.text.slice(this.position, this.position + 16);
    if (rest.startsWith('<![CDATA[')) refuse('plist holds a CDATA section');
    if (rest.startsWith('<?')) refuse('plist holds a processing instruction');
    if (rest.startsWith('<!ENTITY')) refuse('plist DOCTYPE has an internal subset or entity declaration');
    ATTRIBUTE_TAG.lastIndex = this.position;
    const attributes = ATTRIBUTE_TAG.exec(this.text);
    if (attributes !== null) refuse(`plist is malformed: <${attributes[1]}> has attributes`);
    refuse('plist is malformed: unexpected markup');
  }

  private startTag(): { name: string; empty: boolean } {
    const tag = this.sticky(START_TAG);
    if (tag === null) this.refuseMarkup();
    return { name: tag[1]!, empty: tag[2] === '/' };
  }

  private end(name: string): void {
    const tag = this.sticky(END_TAG);
    if (tag === null || tag[1] !== name) refuse(`plist is malformed: expected </${name}>`);
  }

  /** The raw text of a scalar element up to its end tag: no comment, CDATA or other markup inside. */
  private rawText(name: string): string {
    const next = this.text.indexOf('<', this.position);
    if (next < 0) refuse('plist is malformed: unexpected end');
    const raw = this.text.slice(this.position, next);
    this.position = next;
    if (this.text.startsWith('<![CDATA[', next)) refuse('plist holds a CDATA section');
    if (this.text.startsWith('<?', next)) refuse('plist holds a processing instruction');
    if (!this.text.startsWith('</', next)) refuse(`plist <${name}> holds markup`);
    this.end(name);
    return raw;
  }

  private key(): string {
    const tag = this.startTag();
    if (tag.name !== 'key') refuse(`plist is malformed: <dict> holds <${tag.name}> where a <key> belongs`);
    if (tag.empty) refuse('plist is malformed: empty <key/>');
    const raw = this.rawText('key');
    if (raw.includes('&#')) refuse('plist holds a numeric character reference');
    if (raw.includes('&')) refuse('plist <key> holds an entity reference');
    if (/^[ \t\r\n]|[ \t\r\n]$/.test(raw)) refuse('plist <key> text has surrounding whitespace');
    return raw;
  }

  private value(depth: number): StrictPlistValue {
    if (depth > MAX_DEPTH) refuse(`plist is malformed: nesting is deeper than ${MAX_DEPTH}`);
    const tag = this.startTag();
    switch (tag.name) {
      case 'dict': {
        const entries = new Map<string, StrictPlistValue>();
        if (tag.empty) return { kind: 'dict', entries };
        for (;;) {
          this.between();
          if (this.text.startsWith('</', this.position)) { this.end('dict'); return { kind: 'dict', entries }; }
          const key = this.key();
          if (entries.has(key)) refuse(`plist has a duplicate key ${detailKey(key)}`);
          this.between();
          if (this.text.startsWith('</', this.position)) refuse('plist is malformed: <key> without a value');
          entries.set(key, this.value(depth + 1));
        }
      }
      case 'array': {
        const items: StrictPlistValue[] = [];
        if (tag.empty) return { kind: 'array', items };
        for (;;) {
          this.between();
          if (this.text.startsWith('</', this.position)) { this.end('array'); return { kind: 'array', items }; }
          items.push(this.value(depth + 1));
        }
      }
      case 'true':
      case 'false':
        if (!tag.empty) refuse(`plist is malformed: <${tag.name}> must be empty`);
        return { kind: 'boolean', value: tag.name === 'true' };
      case 'string':
        return { kind: 'string', value: tag.empty ? '' : decodeText(this.rawText('string')) };
      case 'integer':
      case 'real':
      case 'date':
      case 'data':
        return { kind: tag.name, text: tag.empty ? '' : decodeText(this.rawText(tag.name)) };
      default:
        return refuse(`plist is malformed: <${tag.name}> is not a plist value element`);
    }
  }
}

export function readStrictPlist(text: string): StrictPlistRead {
  try {
    return { ok: true, root: new Reader(text).document() };
  } catch (error) {
    if (error instanceof StrictPlistRefusal) return { ok: false, error: error.message };
    throw error;
  }
}

/** The strings of an array value; a missing key reads as an empty list. */
export function strictStringArray(dict: StrictPlistDict, key: string): { values: string[] } | { error: string } {
  const value = dict.get(key);
  if (value === undefined) return { values: [] };
  if (value.kind !== 'array') return { error: `plist ${key} is not an <array>` };
  const values: string[] = [];
  for (const [index, item] of value.items.entries()) {
    if (item.kind !== 'string') return { error: `plist ${key} entry ${index} is not a <string>` };
    values.push(item.value);
  }
  return { values };
}

/** The string values of a dict value; a missing key reads as an empty dict. */
export function strictStringDict(dict: StrictPlistDict, key: string): { entries: ReadonlyMap<string, string> } | { error: string } {
  const value = dict.get(key);
  if (value === undefined) return { entries: new Map() };
  if (value.kind !== 'dict') return { error: `plist ${key} is not a <dict>` };
  const entries = new Map<string, string>();
  for (const [entry, item] of value.entries) {
    if (item.kind !== 'string') return { error: `plist ${key} value for ${detailKey(entry)} is not a <string>` };
    entries.set(entry, item.value);
  }
  return { entries };
}

/** Every string value in the document, in document order; keys are not values. */
export function strictPlistStrings(dict: StrictPlistDict): string[] {
  const strings: string[] = [];
  const visit = (value: StrictPlistValue): void => {
    if (value.kind === 'string') strings.push(value.value);
    else if (value.kind === 'array') value.items.forEach(visit);
    else if (value.kind === 'dict') value.entries.forEach(visit);
  };
  dict.forEach(visit);
  return strings;
}
