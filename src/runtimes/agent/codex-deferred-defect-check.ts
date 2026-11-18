/**
 * Startup check for the Codex resume risks that the thread/resume change left
 * open. Two risks were deferred because no configured instance could reach
 * them:
 *  - in single or shared session scope, a lost Codex history can give the
 *    user contradictory or duplicate lines;
 *  - under host work admission, Codex rollout survival across the suspension
 *    kill is unproven, and a rejected turn can get a duplicate generic reply.
 * Config can change without notice, so this check logs one ERROR per
 * reachable risk at startup and raises one BOT ERRORS warning for it. A log
 * line alone reaches no operator: nothing reads WhatSoup logs by level. Each
 * risk has its own alert source, so the dispatcher's incident key
 * (machine|instance|source) is stable per instance and risk, and its dedupe
 * absorbs the repeat at each restart while the incident is open. A still-open
 * card is sent again on the dispatcher's reminder schedule (6 h by default,
 * doubling to a 24 h cap). A quiet incident may later close as unverified;
 * that close does not mean the config was fixed. The check never refuses to
 * start: a refused start takes the bot offline, which is worse than either
 * risk. Each alert is one synchronous outbox write before the runtime is
 * built.
 *
 * Remove this module and its main.ts call once Codex resume is proven in
 * single and shared scope and under host work admission.
 */
import { createChildLogger } from '../../logger.ts';
import { emitAlert } from '../../lib/emit-alert.ts';

const log = createChildLogger('codex-deferred-defects');

const CODEX_PROVIDER_ID = 'codex-cli';

export interface CodexDeferredDefectInput {
  /** The instance name (config.botName); the alert's incident is keyed on it. */
  instance: string;
  provider: string;
  fallbacks: readonly { provider: string }[];
  /** The configured scope; undefined means the runtime default, 'single'. */
  sessionScope: string | undefined;
  /** isHostWorkAdmissionEnabled(): Linux with WHATSOUP_WORK_ADMISSION=systemd. */
  hostWorkAdmission: boolean;
}

export interface CodexDeferredDefect {
  check: 'codex_single_or_shared_scope' | 'codex_host_work_admission';
  message: string;
}

interface ErrorLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

function codexRoles(input: CodexDeferredDefectInput): string[] {
  const roles: string[] = [];
  if (input.provider === CODEX_PROVIDER_ID) roles.push('primary');
  if (input.fallbacks.some((entry) => entry.provider === CODEX_PROVIDER_ID)) roles.push('fallback');
  return roles;
}

export function findCodexDeferredDefects(input: CodexDeferredDefectInput): CodexDeferredDefect[] {
  const roles = codexRoles(input);
  if (roles.length === 0) return [];
  const configured = `codex-cli is configured as ${roles.join(' and ')}`;
  const scope = input.sessionScope ?? 'single';
  const defects: CodexDeferredDefect[] = [];
  if (scope === 'single' || scope === 'shared') {
    defects.push({
      check: 'codex_single_or_shared_scope',
      message: `${configured} with sessionScope ${scope}: Codex resume is not proven for this scope.`
        + ' A lost Codex history can give the user contradictory or duplicate lines. Use sessionScope per_chat.',
    });
  }
  if (input.hostWorkAdmission) {
    defects.push({
      check: 'codex_host_work_admission',
      message: `${configured} and runs with WHATSOUP_WORK_ADMISSION=systemd: Codex resume is not proven under`
        + ' host work admission. Codex rollout survival across the suspension kill is unproven, and a rejected'
        + ' turn can get a duplicate generic reply.',
    });
  }
  return defects;
}

/**
 * One BOT ERRORS warning per risk. The outbox confines summary and evidence
 * to a digest, so the card's readable headline comes from the instance and
 * the source; each source therefore names the risk and its fix in plain
 * words. Both sources are literals so the fault-taxonomy coverage guard can
 * see them.
 */
function emitDeferredDefectAlert(instance: string, defect: CodexDeferredDefect, evidence: string) {
  if (defect.check === 'codex_single_or_shared_scope') {
    return emitAlert(
      instance,
      'codex_resume_needs_per_chat_scope',
      `${instance}: codex-cli resume needs sessionScope per_chat`,
      evidence,
      'warning',
    );
  }
  return emitAlert(
    instance,
    'codex_resume_unproven_under_host_admission',
    `${instance}: codex-cli resume is unproven under host work admission`,
    evidence,
    'warning',
  );
}

/**
 * Logs one ERROR and emits one BOT ERRORS warning per reachable risk. Never
 * throws: each step is caught on its own, so a failed log line still lets the
 * alert go out, and one failed alert does not skip the next.
 */
export function reportCodexDeferredDefects(
  input: CodexDeferredDefectInput,
  logger: ErrorLogger = log,
): CodexDeferredDefect[] {
  let defects: CodexDeferredDefect[];
  let roles: string[];
  try {
    defects = findCodexDeferredDefects(input);
    roles = codexRoles(input);
  } catch {
    // A startup check that only reports must never stop the bot from starting.
    return [];
  }
  const sessionScope = input.sessionScope ?? 'single';
  for (const defect of defects) {
    const fields = {
      event: 'codex_deferred_defect',
      check: defect.check,
      codexRoles: roles,
      sessionScope,
      hostWorkAdmission: input.hostWorkAdmission,
    };
    try {
      logger.error(fields, defect.message);
    } catch {
      // Intentional: the alert below still reports the risk to the operator.
    }
    try {
      const evidence = `check=${defect.check} codex_roles=${roles.join(',')}`
        + ` session_scope=${sessionScope} host_work_admission=${input.hostWorkAdmission}`;
      const result = emitDeferredDefectAlert(input.instance, defect, evidence);
      if (!result.ok) {
        logger.error({ ...fields, alertStatus: result.status }, 'codex deferred-defect alert was not queued');
      }
    } catch (err) {
      try {
        logger.error({ ...fields, err }, 'codex deferred-defect alert could not be emitted');
      } catch {
        // Intentional: nothing else can report it, and starting the bot matters more.
      }
    }
  }
  return defects;
}
