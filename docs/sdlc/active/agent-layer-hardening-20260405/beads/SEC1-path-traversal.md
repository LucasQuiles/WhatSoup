# SEC1: Path Traversal via Unsanitized File Extension

**Severity:** High
**Source:** L audit finding H3
**Files:** `src/runtimes/chat/media/processor.ts:171`, `src/mcp/tools/media.ts:329`

## Problem

WhatsApp messages include a `fileName` field set by the sender. The media processor extracts the file extension from this field and uses it to construct temp file paths and MIME type detection. A malicious `fileName` like `../../etc/passwd.jpg` or `payload.jpg\x00.sh` could:

1. Write downloaded media outside the temp directory
2. Cause incorrect MIME classification
3. Potentially overwrite files if combined with predictable temp paths

## Fix

1. Strip path separators (`/`, `\`) from fileName before extracting extension
2. Use `path.basename()` to isolate the filename component
3. Validate extension against an allowlist of known media extensions
4. Reject or sanitize any extension containing null bytes or path separators

## Verification

- Unit test: fileName with `../` traversal → extension extracted safely
- Unit test: fileName with null bytes → sanitized
- Unit test: fileName with backslashes → stripped
