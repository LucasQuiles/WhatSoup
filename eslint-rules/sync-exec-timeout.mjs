/**
 * fitness/sync-exec-timeout — registry rule `portability.sync-exec-timeout`.
 *
 * Warn: Calls to execSync(), execFileSync(), spawnSync() must include a
 * `timeout` option. Without one, a hanging subprocess blocks the Node.js
 * event loop forever (synchronous call).
 *
 * Recognises:
 *   - child_process.execSync(cmd, { timeout: N })
 *   - child_process.execFileSync(bin, args, { timeout: N })
 *   - child_process.spawnSync(bin, args, { timeout: N })
 *   - Direct import forms (import { execSync } from 'node:child_process')
 */

const SYNC_FUNCS = new Set(['execSync', 'execFileSync', 'spawnSync']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Synchronous child_process calls must include a timeout to prevent event-loop blocking on unresponsive subprocesses.',
    },
    schema: [],
    messages: {
      missingTimeout:
        '{{name}}() without timeout option: add `timeout: <ms>` to prevent indefinite blocking.',
    },
  },
  create(context) {
    return {
      /** @param {import('estree').CallExpression} node */
      CallExpression(node) {
        let funcName = null;

        // Direct call: execSync(...)
        if (
          node.callee.type === 'Identifier' &&
          SYNC_FUNCS.has(node.callee.name)
        ) {
          funcName = node.callee.name;
        }

        // Member call: child_process.execSync(...) or cp.execFileSync(...)
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          SYNC_FUNCS.has(node.callee.property.name)
        ) {
          funcName = node.callee.property.name;
        }

        if (!funcName) return;

        // Check the last argument for timeout
        const args = node.arguments;
        if (args.length < 2) {
          // execSync(cmd) — definitely missing timeout
          context.report({ node, data: { name: funcName }, messageId: 'missingTimeout' });
          return;
        }

        // spawnSync(bin, args, opts) — check opts argument (usually 3rd)
        // execSync(cmd, opts) — check opts argument (2nd)
        // execFileSync(bin, args, opts) — check opts (3rd) or (bin, opts)
        let optsArg = null;
        if (funcName === 'execSync') {
          optsArg = args[1]; // execSync(cmd, opts)
        } else if (funcName === 'spawnSync') {
          optsArg = args[2]; // spawnSync(bin, args, opts)
        } else if (funcName === 'execFileSync') {
          if (args.length >= 3) {
            optsArg = args[2]; // execFileSync(bin, args, opts)
          } else if (args.length === 2) {
            optsArg = args[1]; // execFileSync(bin, opts)
          }
        }

        if (!optsArg) {
          context.report({ node, data: { name: funcName }, messageId: 'missingTimeout' });
          return;
        }

        // Check for timeout property in object literal
        if (optsArg.type === 'ObjectExpression') {
          const hasTimeout = optsArg.properties.some(
            (prop) =>
              prop.type === 'Property' &&
              prop.key.type === 'Identifier' &&
              prop.key.name === 'timeout',
          );
          if (!hasTimeout) {
            context.report({ node, data: { name: funcName }, messageId: 'missingTimeout' });
          }
        }
        // Identifier/spread — can't statically verify, skip
      },
    };
  },
};
