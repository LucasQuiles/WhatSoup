import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('supports report-only and write modes for directory arguments', () => {
    const dir = tmp.make('anonymizer');
    git(dir, ['init']);
    mkdirSync(joinPath(dir, 'nested'));
    const rawPhone = join(['1845', '978', '0919']);
    writeFileSync(joinPath(dir, 'nested', 'fixture.ts'), `const phone = "${rawPhone}";\n`);
    git(dir, ['add', 'nested/fixture.ts']);

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
    expect(readFileSync(joinPath(dir, 'nested', 'fixture.ts'), 'utf8')).toContain(rawPhone);

    execFileSync('node', ['--experimental-strip-types', script, '--write', 'nested'], { cwd: dir, env: hookEnv });
    expect(readFileSync(joinPath(dir, 'nested', 'fixture.ts'), 'utf8')).toContain('15555550001');
  });
});
