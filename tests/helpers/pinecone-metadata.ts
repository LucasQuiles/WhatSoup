type Filter = Record<string, unknown>;

/** Evaluate the metadata operators used by recall and consolidation fixtures. */
export function matchesMetadata(fields: Filter, filter: Filter = {}): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return (condition as Filter[]).every((part) => matchesMetadata(fields, part));
    if (key === '$or') return (condition as Filter[]).some((part) => matchesMetadata(fields, part));
    const value = fields[key];
    return Object.entries(condition as Filter).every(([operator, operand]) => {
      switch (operator) {
        case '$eq': return value === operand;
        case '$ne': return value !== undefined && value !== operand;
        case '$in': return (operand as unknown[]).includes(value);
        case '$exists': return (value !== undefined) === operand;
        default: throw new Error(`Unsupported metadata operator: ${operator}`);
      }
    });
  });
}
