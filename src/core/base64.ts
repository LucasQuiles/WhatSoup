/**
 * Validates and normalises a base64-encoded image string.
 *
 * - Strips a leading data URI prefix (e.g. `data:image/png;base64,`) if present.
 * - Rejects strings that contain characters outside the base64 alphabet.
 * - Rejects strings that decode to an empty buffer.
 *
 * Returns the clean base64 string on success, or throws with a descriptive
 * message on failure.
 */
export function validateBase64Image(input: string): string {
  // Strip optional data URI prefix: "data:<mime>;base64,<data>"
  let content = input;
  const dataUriPrefix = /^data:[^;]+;base64,/;
  if (dataUriPrefix.test(content)) {
    content = content.replace(dataUriPrefix, '');
  }

  // Validate base64 alphabet before decoding — Buffer.from silently drops
  // invalid characters and returns a non-empty buffer for garbage input.
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(content)) {
    throw new Error('Invalid base64 content: contains non-base64 characters');
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(content, 'base64');
    if (buffer.length === 0) throw new Error('Empty buffer');
  } catch {
    throw new Error('Invalid base64 content');
  }

  // Suppress unused-variable warning — buffer length was the real check.
  void buffer;

  return content;
}
