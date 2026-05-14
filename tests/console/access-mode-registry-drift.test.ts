import { describe, expect, it } from 'vitest';
import { ACCESS_MODES } from '../../src/core/agent-config-validator.ts';
import { ACCESS_MODE_VALUES } from '../../console/src/lib/access-modes.ts';

describe('console access mode registry drift', () => {
  it('keeps the frontend access mode registry aligned with the backend validator registry', () => {
    expect(ACCESS_MODE_VALUES).toEqual(ACCESS_MODES);
  });
});
