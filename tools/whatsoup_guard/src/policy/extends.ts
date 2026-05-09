type PlainObject = Record<string, unknown>;

export function resolveExtends(parent: PlainObject, child: PlainObject): PlainObject {
  const output: PlainObject = { ...parent };
  for (const key of Object.keys(child)) {
    const parentValue = output[key];
    const childValue = child[key];
    output[key] = isPlainObject(parentValue) && isPlainObject(childValue)
      ? { ...parentValue, ...childValue }
      : childValue;
  }
  return output;
}

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
