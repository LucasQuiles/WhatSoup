import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readPrivateFileSync } from '../src/lib/private-fs.ts';
import { EffectiveConfigError, resolveDeploymentEffectiveConfig } from './lib/deployment-qualification/effective-config.ts';

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const writer = fileURLToPath(new URL('../deploy/scripts/write_effective_config_record.py', import.meta.url));
const options = Object.fromEntries([
  'binding', 'binding-root', 'inventory', 'inventory-root', 'instance-root',
  'arc-commit', 'qfleet-commit', 'whatsoup-commit', 'run-context-digest', 'output', 'output-root',
].map((name) => [name, { type: 'string' as const }]));

/** Write a new private record and return only its digest to the calling process. */
export function resolveEffectiveConfigCommand(argv: string[]) {
  try {
    const parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: false, tokens: true });
    const names = parsed.tokens.filter((token) => token.kind === 'option').map((token) => token.name);
    if (new Set(names).size !== names.length) throw new EffectiveConfigError('INPUT_INVALID');
    const values = parsed.values;
    const record = resolveDeploymentEffectiveConfig({
      binding: { path: values.binding, root: values['binding-root'] },
      inventory: { path: values.inventory, root: values['inventory-root'] },
      instanceRoot: values['instance-root'],
      context: { arc_commit: values['arc-commit'], qfleet_commit: values['qfleet-commit'],
        whatsoup_commit: values['whatsoup-commit'], run_context_digest: values['run-context-digest'] },
    });
    const output = values.output;
    const root = values['output-root'];
    if (typeof output !== 'string' || typeof root !== 'string') throw new EffectiveConfigError('INPUT_INVALID');
    if (!isAbsolute(output) || resolve(output) !== output || !isAbsolute(root) || resolve(root) !== root) {
      throw new EffectiveConfigError('INPUT_INVALID');
    }
    const observation = { maxBytes: MAX_RECORD_BYTES, observation: { root } };
    if (readPrivateFileSync(output, observation) !== null) throw new EffectiveConfigError('OWNER_CONFLICT');
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > MAX_RECORD_BYTES) throw new EffectiveConfigError('INPUT_INVALID');
    const receipt = JSON.parse(execFileSync('python3', [writer, '--output-root', root,
      '--output-relative', relative(root, output)], {
      input: bytes, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096,
      stdio: ['pipe', 'pipe', 'pipe'],
    })) as Record<string, unknown>;
    if (receipt.schema_version !== 'whatsoup.effective-config-write.v1'
      || typeof receipt.record_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.record_sha256)
      || Object.keys(receipt).length !== 2) throw new EffectiveConfigError('INPUT_INVALID');
    const written = readPrivateFileSync(output, observation);
    const digest = receipt.record_sha256;
    if (!written || written.rawSha256 !== digest) throw new EffectiveConfigError('EVIDENCE_STALE');
    return { schema_version: 'whatsoup.effective-config-write.v1', record_sha256: digest };
  } catch (error) {
    if (error instanceof EffectiveConfigError) throw error;
    throw new EffectiveConfigError('INPUT_INVALID');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(resolveEffectiveConfigCommand(process.argv.slice(2)))}\n`);
  } catch (error) {
    const code = error instanceof EffectiveConfigError ? error.code : 'INPUT_INVALID';
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  }
}
