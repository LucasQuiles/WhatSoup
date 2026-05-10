import { pathToFileURL } from 'node:url';
import { cycleCommand, type CycleDeps } from './cycle.ts';
import { runCycleRuntime } from './cycle-runtime.ts';
import { muteCommand, statusCommand, type MuteCommandDeps } from './mute.ts';
import { simulateCommand, type SimulateCommandDeps } from './simulate.ts';
import { watchdogCommand, type WatchdogCommandDeps } from './watchdog.ts';
import { createGuardLogger } from '../logging.ts';

export type CycleCommand = (args: string[], deps: CycleDeps) => Promise<number>;
export type MuteCommand = (args: string[], deps: MuteCommandDeps) => Promise<number>;
export type StatusCommand = (args: string[], deps: MuteCommandDeps) => Promise<number>;
export type SimulateCommand = (args: string[], deps: SimulateCommandDeps) => Promise<number>;
export type WatchdogCommand = (args: string[], deps: WatchdogCommandDeps) => Promise<number>;

export interface CliDeps extends CycleDeps, MuteCommandDeps, SimulateCommandDeps, WatchdogCommandDeps {
  cycleCommand?: CycleCommand;
  muteCommand?: MuteCommand;
  statusCommand?: StatusCommand;
  simulateCommand?: SimulateCommand;
  watchdogCommand?: WatchdogCommand;
}

const USAGE = 'usage: whatsoup-guard <ping|cycle|mute|status|simulate|watchdog>\n';

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'ping':
      deps.write('pong v1\n');
      return 0;
    case 'cycle':
      return (deps.cycleCommand ?? cycleCommand)(rest, {
        ...deps,
        runCycle: deps.runCycle ?? defaultRunCycle(deps.logger),
      });
    case 'mute':
      return (deps.muteCommand ?? muteCommand)(rest, deps);
    case 'status':
      return (deps.statusCommand ?? statusCommand)(rest, deps);
    case 'simulate':
      return (deps.simulateCommand ?? simulateCommand)(rest, deps);
    case 'watchdog':
      return (deps.watchdogCommand ?? watchdogCommand)(rest, deps);
    default:
      deps.write(`unknown command: ${command ?? '<none>'}\n`);
      deps.write(USAGE);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), {
    write: (chunk) => process.stdout.write(chunk),
    logger: createGuardLogger(),
  }).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`whatsoup-guard: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'operation failed';
}

function defaultRunCycle(logger: CycleDeps['logger']): NonNullable<CycleDeps['runCycle']> {
  return (input) => runCycleRuntime(input, logger ? { logger } : {});
}
