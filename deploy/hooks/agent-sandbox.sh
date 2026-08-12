#!/usr/bin/env bash
set -euo pipefail

# Read the tool call from stdin
INPUT=$(cat)

# Resolve the sandbox policy. writeSandboxArtifacts wires this hook with the
# absolute policy path as $1 (the code that writes the policy owns its location),
# so the hook enforces exactly that file regardless of the agent's cwd: a mid-turn
# `cd` into a subdirectory can neither miss the root policy nor pick up a policy
# planted in a writable subdir (no filesystem discovery). Fall back to the
# cwd-relative default for legacy/manual invocations wired with no argument.
POLICY_FILE="${1:-.claude/sandbox-policy.json}"
# Pass the resolved path to node via the ENVIRONMENT, never string-interpolated
# into a -e script, so a path containing a quote or backslash cannot break out of
# a JS string literal inside this security hook. node reads it from process.env.
export WHATSOUP_SANDBOX_POLICY_FILE="$POLICY_FILE"

if [ ! -f "$POLICY_FILE" ]; then
  # Missing policy contract (R1-A):
  #   WhatSoup wires this PreToolUse hook into .claude/settings.json ONLY in the
  #   same code path that writes .claude/sandbox-policy.json (see
  #   src/core/workspace.ts writeSandboxArtifacts + src/runtimes/agent/runtime.ts).
  #   So when the hook actually runs, the policy file is expected to exist. A
  #   missing file therefore means the sandbox was tampered with / corrupted /
  #   manually misconfigured — which is exactly when allow-all is most dangerous.
  #   Default: FAIL CLOSED (deny). Opt back into the legacy allow-all behaviour
  #   with WHATSOUP_SANDBOX_FAIL_OPEN=1 for out-of-band manual deployments that
  #   intentionally run the hook with no policy file.
  if [ "${WHATSOUP_SANDBOX_FAIL_OPEN:-}" = "1" ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
    exit 0
  fi
  # Emit the fail-closed decision FIRST so a diagnostic-logging failure can never
  # suppress it, then best-effort a structured stderr log built by node — so an
  # agent-controlled cwd containing a quote/backslash cannot corrupt the JSON.
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"sandbox-policy.json missing; failing closed (set WHATSOUP_SANDBOX_FAIL_OPEN=1 to allow)"}}'
  node -e 'process.stderr.write(JSON.stringify({event:"sandbox_deny",tool:"",reason:"sandbox-policy.json missing; failing closed (set WHATSOUP_SANDBOX_FAIL_OPEN=1 to allow)",cwd:process.cwd(),policyPath:process.env.WHATSOUP_SANDBOX_POLICY_FILE})+"\n")' || true
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
    const policy = JSON.parse(readFileSync(process.env.WHATSOUP_SANDBOX_POLICY_FILE, 'utf8'));
    const toolName = input.tool_name ?? '';
    const toolInput = input.tool_input ?? {};
    const allowedPaths = policy.allowedPaths ?? [];

    function allow() {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      }));
    }

    function deny(reason) {
      const log = JSON.stringify({
        event: 'sandbox_deny',
        tool: toolName,
        reason,
        cwd: process.cwd(),
        policyPath: process.env.WHATSOUP_SANDBOX_POLICY_FILE,
      });
      process.stderr.write(log + '\n');
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));
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
        allow();
        process.exit(0);
      }
      if (allowed.length === 0) {
        // Empty array = no restriction (same as absent). Normalized contract:
        // undefined/absent/[] = allow all, non-empty array = allowlist.
        allow();
        process.exit(0);
      }
      const parts = toolName.split('__');
      const mcpTool = parts.length >= 3 ? parts.slice(2).join('__') : toolName;
      if (allowed.includes(mcpTool) || allowed.includes(toolName)) {
        allow();
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
        //
        // HONEST SCOPE (R1-B): this is a best-effort denylist over the *raw*
        // command string, NOT a real sandbox. A shell offers unbounded ways to
        // construct a path that this string scan cannot see (runtime variable
        // expansion, here-docs, eval, base64-decoded args, \$IFS tricks, ...).
        // The only sound bash containment is an OS-level boundary (see the
        // residual-bypass note in docs/configuration.md #agentoptionssandbox).
        // What we do here is raise the bar against the obvious, low-effort
        // escapes and known credential paths. Use includes() to dodge bash
        // double-quote escaping issues with \$.
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
          '\${HOME',       // home variable (braces, incl. \${HOME:-x} indirection)
          '\$HO',          // \$HO''ME / \$HO\"ME split-quote evasion of \$HOME
          '\${H}',         // \${H}\${OME} brace-split evasion of \$HOME
          '\$XDG_',        // XDG_*_HOME and friends point outside the sandbox
        ];
        const blocked = blockedStrings.some((s) => cmd.includes(s));
        if (blocked) {
          deny('Bash command references paths or patterns outside the sandbox');
        }

        // Bare '..' parent-directory traversal. The '../' blockedString above
        // only catches the SLASHED form; \`cd .. && cat relative\` walks up out
        // of allowedPaths with no slash and slipped through (QR-045). Match '..'
        // ONLY as a standalone path component — bounded on each side by start/
        // end, whitespace, a quote, '(', or a path/command separator (/ & | ;
        // = :). '..' flanked by word chars on both sides is NOT a traversal, so
        // git rev ranges (HEAD..main), brace ranges ({1..10}) and double-dots
        // inside a word (a..b) are left alone. Still advisory-grade like the
        // rest of this denylist — the sound fix is the OS sandbox (see the
        // residual-bypass note in docs/configuration.md #agentoptionssandbox).
        if (/(^|[\\s=:\"'(\\/&|;])\\.\\.($|[\\s\"'\\/&|;])/.test(cmd)) {
          deny('Bash command uses \"..\" parent-directory traversal outside the sandbox');
        }

        // Tilde expansion escapes the sandbox (\${HOME}/..., ~user/...). The
        // absolute-path regex below never sees a leading '/', so tilde forms
        // slipped through entirely. Deny any '~' used as a path: start-of-token
        // '~' or '~user'. A literal '~' mid-word (e.g. a backup~ filename) is
        // only matched when it begins a shell word.
        if (/(^|[\\s=:\"'(])~($|[\\/\\s\"'])/.test(cmd) || /(^|[\\s=:\"'(])~[a-zA-Z0-9_.-]+(\$|[\\/\\s\"'])/.test(cmd)) {
          deny('Bash command uses tilde (~) path expansion outside the sandbox');
        }

        // Command substitution can build an out-of-sandbox path the string scan
        // cannot evaluate (\$(printf %s /Users/testuser), \`...\`). When path-restricted,
        // refuse to reason about a dynamically-constructed path: deny it.
        if (cmd.includes('\$(') || cmd.includes('\`')) {
          deny('Bash command uses command substitution; cannot verify constructed paths under path restriction');
        }
        // Also check for absolute paths that aren't within allowedPaths.
        //  1. Bare paths: a leading '/' followed by path chars (stops at space).
        //  2. Quoted paths: '/...'/\"/...\" that may legitimately contain spaces.
        //     The bare regex truncated these at the first space, so a quoted
        //     '/Users/testuser/my file' validated only '/Users/testuser/my'
        //     and let the rest
        //     escape. Capture the quoted span and validate the whole thing.
        const bareAbs = cmd.match(/\\/[a-zA-Z0-9_\\-\\.\\/]+/g) || [];
        const quotedAbs = (cmd.match(/[\"'](\\/[^\"']*)[\"']/g) || []).map((m) => m.slice(1, -1));
        const absPathMatches = [...bareAbs, ...quotedAbs];
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
      allow();
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

    allow();
  });
"
