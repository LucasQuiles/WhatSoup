#!/usr/bin/env bash
set -euo pipefail

# Read the tool call from stdin
INPUT=$(cat)

# Find sandbox-policy.json relative to this hook's location
# Claude Code hooks run from the project root (cwd), so look in .claude/
POLICY_FILE=".claude/sandbox-policy.json"

if [ ! -f "$POLICY_FILE" ]; then
  # No sandbox policy — allow everything
  echo '{"decision":"allow"}'
  exit 0
fi

# Use node to do the actual validation (JSON parsing in bash is painful).
# INPUT is passed via stdin to avoid shell injection from user-controlled content.
echo "$INPUT" | exec node --experimental-strip-types -e "
  import { readFileSync } from 'node:fs';
  import { resolve } from 'node:path';
  import { createInterface } from 'node:readline';

  const chunks = [];
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => chunks.push(line));
  rl.on('close', () => {
    const raw = chunks.join('\n');
    const input = JSON.parse(raw);
    const policy = JSON.parse(readFileSync('$POLICY_FILE', 'utf8'));
    const toolName = input.tool_name ?? '';
    const toolInput = input.tool_input ?? {};
    const allowedPaths = policy.allowedPaths ?? [];

    // Helper: check if a path is within allowed roots
    function isPathAllowed(p) {
      if (!p || allowedPaths.length === 0) return true;
      const absPath = resolve(p);
      return allowedPaths.some((root) => {
        const absRoot = resolve(root);
        return absPath === absRoot || absPath.startsWith(absRoot + '/');
      });
    }

    // MCP tools: empty allowedMcpTools = allow all MCP tools
    if (toolName.startsWith('mcp__')) {
      const allowed = policy.allowedMcpTools ?? [];
      if (allowed.length === 0) {
        console.log(JSON.stringify({ decision: 'allow' }));
        process.exit(0);
      }
      const parts = toolName.split('__');
      const mcpTool = parts.length >= 3 ? parts.slice(2).join('__') : toolName;
      if (allowed.includes(mcpTool) || allowed.includes(toolName)) {
        console.log(JSON.stringify({ decision: 'allow' }));
      } else {
        console.log(JSON.stringify({ decision: 'block', reason: 'MCP tool ' + toolName + ' not in allowedMcpTools' }));
      }
      process.exit(0);
    }

    // Bash: blocked if disabled, path-restricted if enabled with pathRestricted
    if (toolName === 'Bash') {
      if (!policy.bash?.enabled) {
        console.log(JSON.stringify({ decision: 'block', reason: 'Bash is disabled by sandbox policy' }));
        process.exit(0);
      }
      if (policy.bash?.pathRestricted) {
        // Check the command for paths outside the sandbox
        // Can't fully validate shell commands — trust CLAUDE.md instructions
        // but block obvious escapes via cd to outside paths
      }
      // Bash allowed
      console.log(JSON.stringify({ decision: 'allow' }));
      process.exit(0);
    }

    // Core tool allowlist: empty = allow all tools
    const allowedTools = policy.allowedTools ?? [];
    if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
      console.log(JSON.stringify({ decision: 'block', reason: 'Tool ' + toolName + ' not in allowedTools' }));
      process.exit(0);
    }

    // Path validation for file-touching tools
    const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
    if (fileTools.includes(toolName)) {
      const pathField = toolInput.file_path ?? toolInput.path ?? '';
      if (pathField && !isPathAllowed(pathField)) {
        console.log(JSON.stringify({ decision: 'block', reason: 'Path ' + resolve(pathField) + ' is outside allowed directories' }));
        process.exit(0);
      }
    }

    console.log(JSON.stringify({ decision: 'allow' }));
  });
"
