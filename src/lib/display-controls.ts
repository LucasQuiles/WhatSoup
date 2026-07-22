const CONTROL_CODE_POINT_RE = /\p{Cc}/u;
const FORMAT_CODE_POINT_RE = /\p{Cf}/u;
const DEFAULT_IGNORABLE_CODE_POINT_RE = /\p{Default_Ignorable_Code_Point}/u;
const SEPARATOR_CODE_POINT_RE = /\p{Z}/u;

export function escapeDisplayControls(value: string): string {
  return [...value].map(character => {
    if (character === '\\') return '\\\\';
    const code = character.codePointAt(0) ?? 0;
    if (
      !CONTROL_CODE_POINT_RE.test(character)
      && !FORMAT_CODE_POINT_RE.test(character)
      && !DEFAULT_IGNORABLE_CODE_POINT_RE.test(character)
      && (character === ' ' || !SEPARATOR_CODE_POINT_RE.test(character))
    ) return character;
    const hex = code.toString(16).toUpperCase();
    return code <= 0xFFFF ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  }).join('');
}
