import { fingerprint } from '../canonical.ts';
import type { ProbeDoc, Severity } from '../types.ts';
import type { EvaluatorEventInput } from './types.ts';

export interface ChangeRuleArgs {
  observed: ProbeDoc;
  baseline: ProbeDoc | undefined;
  severity: Severity;
}

interface ChangeField {
  field: string;
  reasonCode: 'change.new_persistence_unit' | 'change.new_application_route';
}

const CHANGE_FIELDS: ChangeField[] = [
  { field: 'units', reasonCode: 'change.new_persistence_unit' },
  { field: 'persistence_units', reasonCode: 'change.new_persistence_unit' },
  { field: 'routes', reasonCode: 'change.new_application_route' },
  { field: 'application_routes', reasonCode: 'change.new_application_route' },
];

export function changeRule(args: ChangeRuleArgs): EvaluatorEventInput[] {
  if (!args.baseline) return [];

  const events: EvaluatorEventInput[] = [];
  for (const changeField of CHANGE_FIELDS) {
    const added = addedStrings(args.observed.fields[changeField.field], args.baseline.fields[changeField.field]);
    if (added.length === 0) continue;
    events.push(changeEvent(args, changeField, added));
  }
  return events;
}

function changeEvent(args: ChangeRuleArgs, changeField: ChangeField, added: string[]): EvaluatorEventInput {
  return {
    ts: args.observed.captured_at,
    kind: 'drift',
    domain: 'change',
    scope_id: args.observed.scope_id,
    probe_id: args.observed.probe_id,
    severity: args.severity,
    fingerprint: fingerprint(
      changeField.reasonCode,
      { ...args.observed, fields: { field: changeField.field, added } },
      { ...args.observed, fields: { field: changeField.field, added: [] } },
    ),
    payload: {
      action: 'alert',
      reason_code: changeField.reasonCode,
      field: changeField.field,
      diff: { added, removed: [], changed: {} },
    },
  };
}

function addedStrings(observed: unknown, baseline: unknown): string[] {
  const observedSet = new Set(readStringArray(observed));
  const baselineSet = new Set(readStringArray(baseline));
  return [...observedSet]
    .filter((value) => !baselineSet.has(value))
    .sort((left, right) => left.localeCompare(right));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
