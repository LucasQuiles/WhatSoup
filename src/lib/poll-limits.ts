/**
 * Conservative WhatsApp poll limits, shared by the AskUserQuestion poll bridge
 * (src/runtimes/agent/poll-resolution.ts) and the MCP send_poll tool
 * (src/mcp/tools/messaging.ts). They live in src/lib because the import
 * boundary matrix lets both of those layers import lib, while mcp may not
 * import runtimes.
 */
export const POLL_QUESTION_MAX_CHARS = 900;
export const POLL_OPTION_MAX_CHARS = 95;  // leave margin under WhatsApp's ~100 char limit
