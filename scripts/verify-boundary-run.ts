import { pathToFileURL } from 'node:url';

import type { BoundaryValidationResult } from './lib/verification/boundary-run-manifest.ts';
import { recordCommand, recordArtifact, recordInternalCheck } from './lib/verification/boundary-run-cli/attempts.ts';
import { closeoutRun, verifyCloseout } from './lib/verification/boundary-run-cli/closeout.ts';
import { initializeRun } from './lib/verification/boundary-run-cli/init.ts';
import {
  parseBoundaryRunInvocation,
  type BoundaryRunInvocation,
} from './lib/verification/boundary-run-cli/invocation.ts';
import { recordChildRun, recordReview } from './lib/verification/boundary-run-cli/joins.ts';
import { finalizeRun, setLifecycle, setUpstream, verifyRun } from './lib/verification/boundary-run-cli/lifecycle.ts';
import { operationResult } from './lib/verification/boundary-run-cli/shared.ts';
import { recordGitTransition } from './lib/verification/boundary-run-cli/transitions.ts';

export {
  BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS,
} from './lib/verification/boundary-run-cli/attempts.ts';
export {
  type BoundaryCloseoutControlClosure,
  validateBoundaryCloseoutControlClosure,
} from './lib/verification/boundary-run-cli/closeout.ts';
export {
  BOUNDARY_RUN_COMMANDS,
  type BoundaryRunCommand,
  type BoundaryRunInvocation,
  parseBoundaryRunInvocation,
} from './lib/verification/boundary-run-cli/invocation.ts';

export async function runBoundaryRunCli(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<BoundaryValidationResult> {
  let invocation: BoundaryRunInvocation;
  try {
    invocation = parseBoundaryRunInvocation(argv);
  } catch (error) {
    return operationResult([{ code: 'invocation-invalid', message: (error as Error).message }], 2);
  }
  if (invocation.command === 'init') return initializeRun(invocation, cwd);
  if (invocation.command === 'record-command') return recordCommand(invocation, cwd);
  if (invocation.command === 'record-internal-check') return recordInternalCheck(invocation, cwd);
  if (invocation.command === 'record-git-transition') return recordGitTransition(invocation, cwd);
  if (invocation.command === 'record-artifact') return recordArtifact(invocation);
  if (invocation.command === 'record-child-run') return recordChildRun(invocation, cwd);
  if (invocation.command === 'record-review') return recordReview(invocation);
  if (invocation.command === 'set-upstream') return setUpstream(invocation, cwd);
  if (invocation.command === 'set-lifecycle') return setLifecycle(invocation, cwd);
  if (invocation.command === 'finalize') return finalizeRun(invocation, cwd);
  if (invocation.command === 'verify') return verifyRun(invocation, cwd);
  if (invocation.command === 'closeout') return closeoutRun(invocation, cwd);
  return verifyCloseout(invocation, cwd);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runBoundaryRunCli(process.argv.slice(2));
  const destination = result.ok ? process.stdout : process.stderr;
  destination.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
