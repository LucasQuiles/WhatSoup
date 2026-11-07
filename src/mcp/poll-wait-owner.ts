export interface PollWaitOwner {
  begin(timeoutMs: number): (() => void) | undefined;
}

// Ownership stays in process; it must not enter tool arguments or persisted context.
const owners = new WeakMap<object, PollWaitOwner>();

export function attachPollWaitOwner(context: object, owner: PollWaitOwner | undefined): void {
  if (owner === undefined) owners.delete(context);
  else owners.set(context, owner);
}

export function beginPollWait(context: object, timeoutMs: number): (() => void) | undefined {
  return owners.get(context)?.begin(timeoutMs);
}
