import { AsyncLocalStorage } from 'node:async_hooks';
import { WhatSoupError } from '../errors.ts';
import { MS_PER_SECOND } from '../lib/time-units.ts';

const SEND_DEADLINE_MS = 30 * MS_PER_SECOND;
interface SendDeadline {
  controller: AbortController;
  expiresAt: number;
  error: WhatSoupError;
}
const currentDeadline = new AsyncLocalStorage<SendDeadline>();

export function currentTransportSendSignal(): AbortSignal | undefined {
  return currentDeadline.getStore()?.controller.signal;
}

export function assertTransportSendActive(): void {
  const deadline = currentDeadline.getStore();
  if (!deadline) return;
  // Check elapsed time as well as the timer: synchronous snapshot work can
  // consume the budget before the event loop gets to run the abort callback.
  if (performance.now() >= deadline.expiresAt) deadline.controller.abort(deadline.error);
  deadline.controller.signal.throwIfAborted();
}

/** A submitted provider call cannot be recalled; timeout makes its effect unknown. */
export async function observeTransportSubmission<T>(submission: Promise<T>): Promise<T> {
  const signal = currentTransportSendSignal();
  if (!signal) return submission;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([submission, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Keep late admission continuations from initiating a provider submission. */
export async function runWithTransportSendDeadline<T>(work: () => Promise<T>): Promise<T> {
  if (currentDeadline.getStore()) {
    assertTransportSendActive();
    return work();
  }
  const deadline: SendDeadline = {
    controller: new AbortController(),
    expiresAt: performance.now() + SEND_DEADLINE_MS,
    error: new WhatSoupError('sendMessage timed out after 30s', 'SEND_TIMEOUT'),
  };
  return currentDeadline.run(deadline, async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadline.controller.abort(deadline.error);
        reject(deadline.error);
      }, SEND_DEADLINE_MS);
    });
    try {
      return await Promise.race([work(), expired]);
    } finally {
      clearTimeout(timer);
    }
  });
}
