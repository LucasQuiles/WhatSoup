import { execFileSync, spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { anonymizeText } from '../../scripts/anonymize-private-literals.ts';

const join = (parts: string[]) => parts.join('');
const tmp = trackTmpDirs('whatsoup-');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: cleanGitEnv() });
}

describe('anonymize-private-literals', () => {
  it('replaces private literals without exposing originals in replacement records', () => {
    const privatePhone = join(['1845', '978', '0919']);
    const privateUserJid = `${privatePhone}@s.whatsapp.net`;
    const privateGroupJid = join(['120363', '406689', '931730', '@g.us']);
    const privateHome = join(['/Users/', 'alice', '/LAB/WhatSoup']);
    const privateInstance = join(['mw', '-bot']);
    const privateHost = join(['mw', 'lab']);
    const privateProject = join(['o6', 'fs', 'xb8']);
    const privateKey = join(['sk-', 'abcdefghijklmnopqrstuvwxyz012345']);

    const result = anonymizeText([
      `phone=${privatePhone}`,
      `jid=${privateUserJid}`,
      `group=${privateGroupJid}`,
      `home=${privateHome}`,
      `instance=${privateInstance}`,
      `host=${privateHost}`,
      `project=${privateProject}`,
      `key=${privateKey}`,
    ].join('\n'));

    expect(result.text).toContain('15555550001');
    expect(result.text).toContain('15555550001@s.whatsapp.net');
    expect(result.text).toContain('1111111000000000001@g.us');
    expect(result.text).toContain('/home/whatsoup/LAB/WhatSoup');
    expect(result.text).toContain('instance=test-agent');
    expect(result.text).toContain('host=test-host');
    expect(result.text).toContain('project=project-placeholder');
    expect(result.text).toContain('key=<openai-key>');

    const serializedRecords = JSON.stringify(result.replacements);
    expect(serializedRecords).not.toContain(privatePhone);
    expect(serializedRecords).not.toContain(privateUserJid);
    expect(serializedRecords).not.toContain(privateGroupJid);
    expect(serializedRecords).not.toContain(privateHome);
    expect(serializedRecords).not.toContain(privateInstance);
    expect(serializedRecords).not.toContain(privateHost);
    expect(serializedRecords).not.toContain(privateProject);
    expect(serializedRecords).not.toContain(privateKey);
  });

  it('keeps repeated originals mapped to the same synthetic replacement', () => {
    const privatePhone = join(['1845', '588', '0337']);
    const result = anonymizeText(`${privatePhone}\n${privatePhone}\n`);

    expect(result.text).toBe('15555550001\n15555550001\n');
    expect(result.replacements).toEqual([
      expect.objectContaining({
        code: 'phone-like-id',
        count: 2,
        replacement: '15555550001',
      }),
    ]);
  });

  it('preserves safe placeholders and synthetic fixture identifiers', () => {
    const text = [
      '/home/whatsoup/workspaces/demo',
      '/home/<your-name>/workspace',
      '15555550100',
      '15555550100@s.whatsapp.net',
      '99900000001@lid',
      '<openai-key>',
      '<pinecone-key>',
    ].join('\n');

    const result = anonymizeText(text);

    expect(result.text).toBe(text);
    expect(result.replacements).toEqual([]);
  });

  it('redacts credential and token shapes with non-secret placeholders', () => {
    const bearer = join(['Authorization: Bearer ', 'abcde12345'.repeat(5)]);
    const awsSecret = join(['AWS_SECRET_ACCESS_KEY=', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY']);
    const jwt = join(['eyJ', 'a'.repeat(12), '.', 'b'.repeat(12), '.', 'c'.repeat(12)]);
    const privateKey = join(['BEGIN OPENSSH ', 'PRIVATE KEY']);

    const result = anonymizeText([bearer, awsSecret, jwt, privateKey].join('\n'));

    expect(result.text).toContain('Authorization: Bearer <bearer-token>');
    expect(result.text).toContain('AWS_SECRET_ACCESS_KEY=<aws-secret>');
    expect(result.text).toContain('<jwt-token>');
    expect(result.text).toContain(join(['BEGIN REDACTED ', 'PRIVATE KEY']));
    expect(result.replacements.map((replacement) => replacement.code)).toEqual(expect.arrayContaining([
      'aws-secret',
      'bearer-token',
      'jwt-token',
      'private-key',
    ]));
  });

  it.each(['fixture.ts', 'fixture with spaces.ts', 'fixture\nname.ts'])('supports report-only and write modes for directory arguments containing %s', (name) => {
    const dir = tmp.make('anonymizer');
    git(dir, ['init']);
    mkdirSync(joinPath(dir, 'nested'));
    const rawPhone = join(['1845', '978', '0919']);
    writeFileSync(joinPath(dir, 'nested', name), `const phone = "${rawPhone}";\n`);
    git(dir, ['add', `nested/${name}`]);

    const script = joinPath(process.cwd(), 'scripts/anonymize-private-literals.ts');
    const hookEnv = {
      ...cleanGitEnv(),
      GIT_DIR: execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: cleanGitEnv(),
      }).trim(),
      GIT_WORK_TREE: process.cwd(),
    };
    const report = spawnSync('node', ['--experimental-strip-types', script, '--json', 'nested'], {
      cwd: dir,
      encoding: 'utf8',
      env: hookEnv,
    });

    expect(report.status).toBe(1);
    expect(JSON.parse(report.stdout)).toMatchObject({ ok: false, write: false, files: 1 });
    expect(readFileSync(joinPath(dir, 'nested', name), 'utf8')).toBe(`const phone = "${rawPhone}";\n`);

    execFileSync('node', ['--experimental-strip-types', script, '--write', 'nested'], { cwd: dir, env: hookEnv });
    expect(readFileSync(joinPath(dir, 'nested', name), 'utf8')).toBe('const phone = "15555550001";\n');
  });

  it.each([
    { kind: '', newline: '\n' },
    { kind: 'RSA ', newline: '\r\n' },
    { kind: 'EC ', newline: '\n' },
    { kind: 'OPENSSH ', newline: '\n' },
    { kind: 'ENCRYPTED ', newline: '\\n' },
    { kind: 'DSA ', newline: '\n' },
  ])('removes the entire $kind private-key block', ({ kind, newline }) => {
    const body = 'fixture-key-body-that-must-disappear';
    const key = [join(['-----BEGIN ', kind, 'PRIVATE KEY-----']), body,
      join(['-----END ', kind, 'PRIVATE KEY-----'])].join(newline);
    const result = anonymizeText(`before\n${key}\nafter`);

    expect(result.text).toBe('before\n<private-key>\nafter');
    expect(result.replacements).toEqual([
      { code: 'private-key', count: 1, fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/), replacement: '<private-key>' },
    ]);
    expect(JSON.stringify(result)).not.toContain(body);
    expect(anonymizeText(result.text)).toEqual({ text: result.text, replacements: [] });
  });

  it('refuses a truncated key without writing or printing its body', () => {
    const dir = tmp.make('truncated-key');
    git(dir, ['init']);
    const text = join(['-----BEGIN ', 'RSA PRIVATE KEY-----\n', 'fixture-unclosed-key-body\n']);
    const file = joinPath(dir, 'fixture.txt');
    writeFileSync(file, text);
    const result = spawnSync(process.execPath, [joinPath(process.cwd(), 'scripts/anonymize-private-literals.ts'), '--write', '--json', 'fixture.txt'], {
      cwd: dir, env: cleanGitEnv(), encoding: 'utf8', timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unterminated private-key block');
    expect(result.stdout + result.stderr).not.toContain('fixture-unclosed-key-body');
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it.each(['parent', 'nested-parent', 'absolute', 'symlink-file', 'symlink-directory', 'hardlink', 'tracked-symlink'])('refuses %s paths before rewriting any file', (kind) => {
    const root = tmp.make('path-boundary');
    const dir = joinPath(root, 'repo');
    mkdirSync(dir);
    mkdirSync(joinPath(dir, 'nested'));
    git(dir, ['init']);
    const text = `phone=${join(['1845', '978', '0919'])}\n`;
    const outside = joinPath(root, 'outside.txt');
    const safe = joinPath(dir, 'a-safe.txt');
    writeFileSync(outside, text);
    writeFileSync(safe, text);
    let argument = '../outside.txt';
    if (kind === 'nested-parent') argument = 'nested/../../outside.txt';
    if (kind === 'absolute') argument = outside;
    if (kind === 'symlink-file' || kind === 'tracked-symlink') {
      symlinkSync(outside, joinPath(dir, 'z-alias.txt'));
      argument = 'z-alias.txt';
    }
    if (kind === 'symlink-directory') {
      symlinkSync(root, joinPath(dir, 'z-alias'));
      argument = 'z-alias/outside.txt';
    }
    if (kind === 'hardlink') {
      linkSync(outside, joinPath(dir, 'z-alias.txt'));
      argument = 'z-alias.txt';
    }
    if (kind === 'tracked-symlink') git(dir, ['add', 'a-safe.txt', argument]);
    const paths = kind === 'tracked-symlink' ? [] : ['a-safe.txt', argument];
    const result = spawnSync(process.execPath, [joinPath(process.cwd(), 'scripts/anonymize-private-literals.ts'), '--write', '--json', ...paths], {
      cwd: dir, env: cleanGitEnv(), encoding: 'utf8', timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/repository-relative|symlink|hardlink/);
    expect(readFileSync(outside, 'utf8')).toBe(text);
    expect(readFileSync(safe, 'utf8')).toBe(text);
    expect(result.stdout + result.stderr).not.toContain(text.trim());
  });

  it('writes a complete key as one placeholder without retaining its body or trailing bytes', () => {
    const dir = tmp.make('complete-key');
    git(dir, ['init']);
    const file = joinPath(dir, 'fixture.txt');
    const text = join(['before\n-----BEGIN ', 'RSA PRIVATE KEY-----\nfixture-key-body\n-----END ', 'RSA PRIVATE KEY-----\nafter\n']);
    writeFileSync(file, text);
    const result = spawnSync(process.execPath, [joinPath(process.cwd(), 'scripts/anonymize-private-literals.ts'), '--write', '--json', 'fixture.txt'], {
      cwd: dir, env: cleanGitEnv(), encoding: 'utf8', timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ write: true, files: 1 });
    expect(readFileSync(file, 'utf8')).toBe('before\n<private-key>\nafter\n');
    expect(result.stdout + result.stderr).not.toContain('fixture-key-body');
  });

  it.each(['open', 'read'])('rejects a symlink replacement after %s without changing its target', (phase) => {
    const root = tmp.make('swapped-file');
    const dir = joinPath(root, 'repo');
    mkdirSync(dir);
    git(dir, ['init']);
    const file = joinPath(dir, 'fixture.txt');
    const outside = joinPath(root, 'outside.txt');
    const text = `phone=${join(['1845', '978', '0919'])}\n`;
    writeFileSync(file, text);
    writeFileSync(outside, text);
    const preload = joinPath(root, 'swap.mjs');
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, read = fs.readFileSync;
let selected;
function swap() {
  fs.unlinkSync(${JSON.stringify(file)});
  fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(file)});
  process.stderr.write('SWAP_INJECTED\\n');
}
fs.openSync = (path, ...args) => {
  const fd = open(path, ...args);
  if (path === ${JSON.stringify(file)}) { selected = fd; if (${JSON.stringify(phase)} === 'open') swap(); }
  return fd;
};
fs.readFileSync = (path, ...args) => {
  const content = read(path, ...args);
  if (path === selected && ${JSON.stringify(phase)} === 'read') swap();
  return content;
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--import', preload, joinPath(process.cwd(), 'scripts/anonymize-private-literals.ts'), '--write', 'fixture.txt'], {
      cwd: dir, env: cleanGitEnv(), encoding: 'utf8', timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SWAP_INJECTED');
    expect(result.stderr).toContain('Anonymizer refuses symlink paths');
    expect(readFileSync(outside, 'utf8')).toBe(text);
  });
});
