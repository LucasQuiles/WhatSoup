// The full rehearsal needs a second, older checkout and is run by hand (see
// docs/runbook.md, "Schema 65 rollback"). These tests pin its safety rails.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseRehearsalArgs,
  runSchemaRollbackRehearsal,
} from '../../scripts/schema-rollback-rehearsal.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-rollback-rehearsal-');

describe('schema rollback rehearsal arguments', () => {
  it('requires all three roots and rejects unknown flags', () => {
    expect(parseRehearsalArgs(['--old-root', 'a', '--new-root', 'b', '--work-dir', 'c']))
      .toEqual({
        oldRoot: expect.stringMatching(/\/a$/),
        newRoot: expect.stringMatching(/\/b$/),
        workDir: expect.stringMatching(/\/c$/),
      });
    expect(() => parseRehearsalArgs(['--old-root', 'a', '--new-root', 'b']))
      .toThrow('--work-dir is required');
    expect(() => parseRehearsalArgs(['--old-root', 'a', '--bogus', 'x']))
      .toThrow('Unknown argument: --bogus');
    expect(() => parseRehearsalArgs(['--old-root', '--new-root']))
      .toThrow('--old-root is required');
  });

  it('refuses a work directory that already exists, before running anything', () => {
    const existing = tmp.make('existing');
    expect(() => runSchemaRollbackRehearsal({
      oldRoot: join(existing, 'old'),
      newRoot: join(existing, 'new'),
      workDir: existing,
    })).toThrow('--work-dir must not exist yet');
  });
});
