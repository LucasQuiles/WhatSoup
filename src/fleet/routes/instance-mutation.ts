import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { jsonResponse } from '../../lib/http.ts';
import { createChildLogger } from '../../logger.ts';
import { instancePaths } from '../paths.ts';
import { projectError } from '../response-error-projection.ts';
import { acquireCoordinationLease, defaultLeaseProbes, INSTANCE_MUTATION_SCOPE, instanceMutationRoot, releaseCoordinationLease } from '../../transport/coordination-lease.ts';

const log = createChildLogger('fleet:instance-mutation');

export function claimInstanceMutation(name: string, res: ServerResponse) {
  const stateRoot = instanceMutationRoot(instancePaths(name).stateRoot);
  let result: ReturnType<typeof acquireCoordinationLease>;
  try {
    result = acquireCoordinationLease({ stateRoot, scopeId: INSTANCE_MUTATION_SCOPE, operationId: randomUUID(), mode: 'route_orchestration', ttlMs: 600_000, probes: defaultLeaseProbes() });
  } catch (error) {
    log.error({ err: error, instance: name }, 'Instance mutation claim failed');
    jsonResponse(res, 500, projectError(error, { operation: 'service_action', stage: 'precondition' }));
    return null;
  }
  if (!result.ok) {
    jsonResponse(res, 409, { error: 'instance_mutation_in_progress', refusal: result.refusal });
    return null;
  }
  return {
    lease: result.lease,
    release() {
      const released = releaseCoordinationLease({ stateRoot, scopeId: INSTANCE_MUTATION_SCOPE, lease: result.lease });
      if (!released.ok) log.error({ instance: name, refusal: released.refusal }, 'Instance mutation release was refused');
      return released;
    },
  };
}

export type InstanceMutationClaim = NonNullable<ReturnType<typeof claimInstanceMutation>>;
