import type { Event, ProbeDoc } from '../types.ts';
import type { DeploymentRole } from '../policy/schema.ts';

export type EvaluatorEventInput = Omit<Event, 'id' | 'correlation_id'> & {
  correlation_id?: string | undefined;
};

export interface EvaluatorContext {
  observed: ProbeDoc;
  baseline: ProbeDoc | undefined;
  deploymentRole?: DeploymentRole | undefined;
}

export type Evaluator = (ctx: EvaluatorContext) => EvaluatorEventInput[];
