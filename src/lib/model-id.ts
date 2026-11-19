/** Model identifiers become prompt data, so share a bounded token grammar. */
export function isModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 256
    && /^[A-Za-z0-9]/.test(value)
    && !/[^A-Za-z0-9._:/-]/.test(value);
}
