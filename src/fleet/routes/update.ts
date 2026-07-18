import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse } from '../../lib/http.ts';
import { createSSEWriter } from '../sse-helpers.ts';
import { createChildLogger } from '../../logger.ts';
import type { UpdateChecker } from '../update-checker.ts';

const log = createChildLogger('fleet:update');

/** Typed, machine-readable refusal code for the retired in-place update path. */
export const UPDATE_REFUSAL_CODE = 'update-by-release-deploy-required';
const UPDATE_REFUSAL_MESSAGE =
  'In-place update is retired. This instance runs an immutable release — update it by deploying a new release.';

export function handleGetVersion(
  _req: IncomingMessage,
  res: ServerResponse,
  checker: UpdateChecker,
): void {
  // B1 observability: non-secret console auth posture rides the version
  // payload so operators can verify the closure from the API. This read-only
  // availability check is what remains after the mutating update path was
  // retired (S-03) — it works from a detached immutable release.
  jsonResponse(res, 200, { ...checker.getState(), consoleAuthMode: 'session', rootTokenInHtml: false });
}

/**
 * POST /api/update — the in-place mutating update path is RETIRED (S-03).
 *
 * It previously ran `git pull` / `merge --ff-only` inside the running checkout,
 * then npm-installed, rebuilt the console, and restarted the fleet. On the fleet
 * that checkout is an immutable release directory (`WhatSoup-release-<sha>`,
 * detached HEAD), so the pull actively misbehaved (`git fetch origin main` →
 * `couldn't find remote ref main`) and mutating it broke the release model.
 *
 * The path is retired in EVERY supported mode: this handler performs no
 * mutation under any configuration and returns a typed refusal over the
 * existing SSE `error` channel (200 `text/event-stream`), so a pre-existing
 * console surfaces `data.message` in its error phase unchanged during a
 * mixed-version deploy. Updates now happen by deploying a new release; the
 * read-only availability/version check is served by `GET /api/version`.
 */
export function handleUpdate(
  _req: IncomingMessage,
  res: ServerResponse,
  _checker: UpdateChecker,
  _repoRoot: string,
): void {
  log.info({ code: UPDATE_REFUSAL_CODE }, 'in-place update refused — retired in favor of release-deploy');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const { writeSSE, endOnce } = createSSEWriter(res);
  writeSSE('error', {
    step: 'update',
    code: UPDATE_REFUSAL_CODE,
    message: UPDATE_REFUSAL_MESSAGE,
  });
  endOnce();
}
