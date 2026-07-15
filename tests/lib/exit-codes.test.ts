import { describe, expect, it } from 'vitest';

import {
  classifyErrorToExitCode,
  ExitCode,
  exitCodeName,
  inferErrorCategory,
  isPermanentExitCode,
  isTransientExitCode,
  PERMANENT_EXIT_CODES,
  TRANSIENT_EXIT_CODES,
} from '../../src/lib/exit-codes.ts';

describe('ExitCode constants', () => {
  it('EX_OK is 0', () => {
    expect(ExitCode.EX_OK).toBe(0);
  });

  it('EX_CONFIG is 78', () => {
    expect(ExitCode.EX_CONFIG).toBe(78);
  });

  it('EX_USAGE is 64', () => {
    expect(ExitCode.EX_USAGE).toBe(64);
  });

  it('EX_TEMPFAIL is 75', () => {
    expect(ExitCode.EX_TEMPFAIL).toBe(75);
  });

  it('EX_UNAVAILABLE is 69', () => {
    expect(ExitCode.EX_UNAVAILABLE).toBe(69);
  });

  it('EX_SOFTWARE is 70', () => {
    expect(ExitCode.EX_SOFTWARE).toBe(70);
  });

  it('EX_NOINPUT is 66', () => {
    expect(ExitCode.EX_NOINPUT).toBe(66);
  });

  it('EX_DATAERR is 65', () => {
    expect(ExitCode.EX_DATAERR).toBe(65);
  });
});

describe('PERMANENT_EXIT_CODES', () => {
  it('includes EX_CONFIG', () => {
    expect(PERMANENT_EXIT_CODES).toContain(ExitCode.EX_CONFIG);
  });

  it('includes EX_USAGE', () => {
    expect(PERMANENT_EXIT_CODES).toContain(ExitCode.EX_USAGE);
  });

  it('does NOT include EX_TEMPFAIL', () => {
    expect(PERMANENT_EXIT_CODES).not.toContain(ExitCode.EX_TEMPFAIL);
  });

  it('does NOT include EX_SOFTWARE', () => {
    expect(PERMANENT_EXIT_CODES).not.toContain(ExitCode.EX_SOFTWARE);
  });
});

describe('TRANSIENT_EXIT_CODES', () => {
  it('includes EX_TEMPFAIL', () => {
    expect(TRANSIENT_EXIT_CODES).toContain(ExitCode.EX_TEMPFAIL);
  });

  it('includes EX_UNAVAILABLE', () => {
    expect(TRANSIENT_EXIT_CODES).toContain(ExitCode.EX_UNAVAILABLE);
  });

  it('does NOT include EX_CONFIG', () => {
    expect(TRANSIENT_EXIT_CODES).not.toContain(ExitCode.EX_CONFIG);
  });
});

describe('isPermanentExitCode', () => {
  it('returns true for EX_CONFIG', () => {
    expect(isPermanentExitCode(ExitCode.EX_CONFIG)).toBe(true);
  });

  it('returns true for EX_USAGE', () => {
    expect(isPermanentExitCode(ExitCode.EX_USAGE)).toBe(true);
  });

  it('returns false for EX_TEMPFAIL', () => {
    expect(isPermanentExitCode(ExitCode.EX_TEMPFAIL)).toBe(false);
  });

  it('returns false for EX_SOFTWARE', () => {
    expect(isPermanentExitCode(ExitCode.EX_SOFTWARE)).toBe(false);
  });

  it('returns false for EX_OK', () => {
    expect(isPermanentExitCode(ExitCode.EX_OK)).toBe(false);
  });

  it('returns false for unknown codes', () => {
    expect(isPermanentExitCode(99)).toBe(false);
  });
});

describe('isTransientExitCode', () => {
  it('returns true for EX_TEMPFAIL', () => {
    expect(isTransientExitCode(ExitCode.EX_TEMPFAIL)).toBe(true);
  });

  it('returns true for EX_UNAVAILABLE', () => {
    expect(isTransientExitCode(ExitCode.EX_UNAVAILABLE)).toBe(true);
  });

  it('returns false for EX_CONFIG', () => {
    expect(isTransientExitCode(ExitCode.EX_CONFIG)).toBe(false);
  });

  it('returns false for unknown codes', () => {
    expect(isTransientExitCode(99)).toBe(false);
  });
});

describe('exitCodeName', () => {
  it('returns EX_OK for 0', () => {
    expect(exitCodeName(0)).toBe('EX_OK');
  });

  it('returns EX_CONFIG for 78', () => {
    expect(exitCodeName(78)).toBe('EX_CONFIG');
  });

  it('returns EX_TEMPFAIL for 75', () => {
    expect(exitCodeName(75)).toBe('EX_TEMPFAIL');
  });

  it('returns EX_UNKNOWN_N for unrecognized codes', () => {
    expect(exitCodeName(99)).toBe('EX_UNKNOWN_99');
  });
});

describe('classifyErrorToExitCode', () => {
  it('classifies config as EX_CONFIG', () => {
    expect(classifyErrorToExitCode('config')).toBe(ExitCode.EX_CONFIG);
  });

  it('classifies usage as EX_USAGE', () => {
    expect(classifyErrorToExitCode('usage')).toBe(ExitCode.EX_USAGE);
  });

  it('classifies noinput as EX_NOINPUT', () => {
    expect(classifyErrorToExitCode('noinput')).toBe(ExitCode.EX_NOINPUT);
  });

  it('classifies data as EX_DATAERR', () => {
    expect(classifyErrorToExitCode('data')).toBe(ExitCode.EX_DATAERR);
  });

  it('classifies permission as EX_NOPERM', () => {
    expect(classifyErrorToExitCode('permission')).toBe(ExitCode.EX_NOPERM);
  });

  it('classifies unavailable as EX_UNAVAILABLE', () => {
    expect(classifyErrorToExitCode('unavailable')).toBe(ExitCode.EX_UNAVAILABLE);
  });

  it('classifies tempfail as EX_TEMPFAIL', () => {
    expect(classifyErrorToExitCode('tempfail')).toBe(ExitCode.EX_TEMPFAIL);
  });

  it('classifies software as EX_SOFTWARE', () => {
    expect(classifyErrorToExitCode('software')).toBe(ExitCode.EX_SOFTWARE);
  });

  it('classifies unknown as EX_SOFTWARE (retry — bug may not recur)', () => {
    expect(classifyErrorToExitCode('unknown')).toBe(ExitCode.EX_SOFTWARE);
  });
});

describe('inferErrorCategory', () => {
  it('infers data from SyntaxError', () => {
    expect(inferErrorCategory(new SyntaxError('unexpected token'))).toBe('data');
  });

  it('infers data from JSON parse error', () => {
    expect(inferErrorCategory(new Error('Unexpected token in JSON'))).toBe('data');
  });

  it('infers config from config message', () => {
    expect(inferErrorCategory(new Error('Invalid config: missing field'))).toBe('config');
  });

  it('infers config from missing required message', () => {
    expect(inferErrorCategory(new Error('Missing required environment variable'))).toBe('config');
  });

  it('infers noinput from ENOENT', () => {
    expect(inferErrorCategory(new Error('ENOENT: no such file'))).toBe('noinput');
  });

  it('infers noinput from not found', () => {
    expect(inferErrorCategory(new Error('File not found'))).toBe('noinput');
  });

  it('infers permission from EACCES', () => {
    expect(inferErrorCategory(new Error('EACCES: permission denied'))).toBe('permission');
  });

  it('infers usage from invalid option', () => {
    expect(inferErrorCategory(new Error('Invalid option --foo'))).toBe('usage');
  });

  it('infers tempfail from rate limit', () => {
    expect(inferErrorCategory(new Error('Rate limit exceeded (429)'))).toBe('tempfail');
  });

  it('infers tempfail from 429', () => {
    expect(inferErrorCategory(new Error('HTTP 429 Too Many Requests'))).toBe('tempfail');
  });

  it('infers unavailable from ECONNREFUSED', () => {
    expect(inferErrorCategory(new Error('ECONNREFUSED'))).toBe('unavailable');
  });

  it('infers unavailable from 503', () => {
    expect(inferErrorCategory(new Error('Service returned 503'))).toBe('unavailable');
  });

  it('returns unknown for generic errors', () => {
    expect(inferErrorCategory(new Error('something went wrong'))).toBe('unknown');
  });

  it('handles errors with empty message', () => {
    expect(inferErrorCategory(new Error(''))).toBe('unknown');
  });

  it('handles errors with undefined message', () => {
    const err = new Error();
    expect(inferErrorCategory(err)).toBe('unknown');
  });
});

describe('integration: classify after infer', () => {
  it('a config error classifies to a permanent exit code', () => {
    const err = new Error('config.json: missing required field "model"');
    const cat = inferErrorCategory(err);
    const code = classifyErrorToExitCode(cat);
    expect(isPermanentExitCode(code)).toBe(true);
    expect(code).toBe(ExitCode.EX_CONFIG);
  });

  it('a rate-limit error classifies to a transient exit code', () => {
    const err = new Error('Rate limit: 429 Too Many Requests');
    const cat = inferErrorCategory(err);
    const code = classifyErrorToExitCode(cat);
    expect(isTransientExitCode(code)).toBe(true);
    expect(code).toBe(ExitCode.EX_TEMPFAIL);
  });

  it('a missing-file error classifies to a permanent exit code', () => {
    const err = new Error('ENOENT: no such file config.json');
    const cat = inferErrorCategory(err);
    const code = classifyErrorToExitCode(cat);
    expect(isPermanentExitCode(code)).toBe(true);
  });

  it('a network error classifies to a transient exit code', () => {
    const err = new Error('ECONNREFUSED: database unavailable');
    const cat = inferErrorCategory(err);
    const code = classifyErrorToExitCode(cat);
    expect(isTransientExitCode(code)).toBe(true);
  });
});
