import { mkdirSync } from 'node:fs';
import { runCoverageCommand, type CoverageCommandResult } from '../coverage-shards.ts';

const [scratch, budget, ...argv] = process.argv.slice(2);
let result: CoverageCommandResult;
try {
  const budgetMs = Number(budget);
  if (!scratch || scratch !== process.env.TMPDIR || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Invalid coverage worker invocation');
  mkdirSync(scratch, { mode: 0o700 });
  result = await runCoverageCommand(argv, process.cwd(), budgetMs);
} catch (error) {
  result = { schemaVersion: 1, operation: argv[0], outcome: 'inconclusive', exitCode: 125, error: String(error) };
}
const serialized = JSON.stringify(result);
if (Buffer.byteLength(serialized) > 65_536) {
  process.stderr.write('Coverage worker terminal result unavailable or oversized\n');
  process.exitCode = 125;
} else {
  process.stdout.write(serialized);
  process.exitCode = result.exitCode;
}
