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

    function deny(reason) {
      const log = JSON.stringify({
        event: 'sandbox_deny',
        tool: toolName,
        reason,
        cwd: process.cwd(),
        policyPath: '$POLICY_FILE',
      });
      process.stderr.write(log + '\n');
      console.log(JSON.stringify({ decision: 'block', reason }));
      process.exit(0);
    }

    // Helper: check if a path is within allowed roots
    function isPathAllowed(p) {
      if (!p || allowedPaths.length === 0) return true;
      const absPath = resolve(p);
      return allowedPaths.some((root) => {
        const absRoot = resolve(root);
        return absPath === absRoot || absPath.startsWith(absRoot + '/');
      });
    }

    // MCP tools: missing field = allow all, explicit empty array = deny all
    if (toolName.startsWith('mcp__')) {
      const allowed = policy.allowedMcpTools;
      if (allowed === undefined || allowed === null) {
        // Field omitted = no MCP restriction (allow all)
        console.log(JSON.stringify({ decision: 'allow' }));
        process.exit(0);
      }
      if (allowed.length === 0) {
        // Empty array = no restriction (same as absent). Normalized contract:
        // undefined/absent/[] = allow all, non-empty array = allowlist.
        console.log(JSON.stringify({ decision: 'allow' }));
        process.exit(0);
      }
      const parts = toolName.split('__');
      const mcpTool = parts.length >= 3 ? parts.slice(2).join('__') : toolName;
      if (allowed.includes(mcpTool) || allowed.includes(toolName)) {
        console.log(JSON.stringify({ decision: 'allow' }));
      } else {
        deny('MCP tool ' + toolName + ' not in allowedMcpTools');
      }
      process.exit(0);
    }

    // Bash: blocked if disabled, path-restricted if enabled with pathRestricted
    if (toolName === 'Bash') {
      if (!policy.bash?.enabled) {
        deny('Bash is disabled by sandbox policy');
      }
      if (policy.bash?.pathRestricted && allowedPaths.length > 0) {
        const cmd = toolInput.command ?? '';
        // Block commands that reference paths outside the sandbox.
        // Strategy: extract path-like tokens and validate each one.
        // Also block known escape patterns.
        // Use includes() to avoid bash double-quote escaping issues with \$
        const blockedStrings = [
          '../',           // directory traversal
          '/etc/',         // system config
          '/proc/',        // process info
          '/sys/',         // sysfs
          '/root/',        // root home
          'secret-tool',   // credential access
          '.ssh/',         // ssh keys
          '.ssh ',         // ssh keys (space after)
          '.gnupg/',       // gpg keys
          '\$HOME',        // home variable
          '\${HOME}',      // home variable (braces)
        ];
        const blocked = blockedStrings.some((s) => cmd.includes(s));
        if (blocked) {
          deny('Bash command references paths or patterns outside the sandbox');
        }
        // Also check for absolute paths that aren't within allowedPaths
        const absPathMatches = cmd.match(/\\/[a-zA-Z0-9_\\-\\.\\/]+/g) || [];
        for (const p of absPathMatches) {
          const absP = resolve(p);
          const inAllowed = allowedPaths.some((root) => {
            const absRoot = resolve(root);
            return absP === absRoot || absP.startsWith(absRoot + '/');
          });
          if (!inAllowed) {
            // Allow common system binaries but block file-path access
            const systemBinPrefixes = ['/usr/bin/', '/usr/local/bin/', '/bin/', '/usr/sbin/', '/sbin/', '/usr/lib/', '/dev/null', '/dev/stdout', '/dev/stderr'];
            const isBin = systemBinPrefixes.some((bp) => absP.startsWith(bp) || absP === bp.slice(0, -1));
            if (!isBin) {
              deny('Bash command references path ' + absP + ' outside allowed directories');
            }
          }
        }
      }
      // Bash allowed
      console.log(JSON.stringify({ decision: 'allow' }));
      process.exit(0);
    }

    // Core tool allowlist: empty = allow all tools
    const allowedTools = policy.allowedTools ?? [];
    if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
      deny('Tool ' + toolName + ' not in allowedTools');
    }

    // Path validation for file-touching tools
    const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
    if (fileTools.includes(toolName)) {
      const pathField = toolInput.file_path ?? toolInput.path ?? '';
      if (pathField && !isPathAllowed(pathField)) {
        deny('Path ' + resolve(pathField) + ' is outside allowed directories');
      }
    }

    console.log(JSON.stringify({ decision: 'allow' }));
  });
"
