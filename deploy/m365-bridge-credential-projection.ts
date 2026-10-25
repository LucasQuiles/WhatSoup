// Decides whether the launch wrapper may project an instance-bound Agent365
// credential into its parent process. It reads the agent envelope and shared
// bridge-policy inputs only; credential lookup remains in deploy/whatsoup.

import { readPrivateConfigFileSync } from '../src/core/private-config-file.ts';
import { isValidInstanceName } from '../src/fleet/instance-name.ts';
import {
  m365BridgeCredentialProjectionAllowed,
  m365BridgeCredentialAdmission,
  type M365BridgeBinding,
} from '../src/core/m365-bridge-policy.ts';

const [instance, configPath, mode, processIdText] = process.argv.slice(2);
if (!instance || !configPath) process.exit(1);
const issueAdmission = mode === '--credential-admission';
if (process.argv.length !== (issueAdmission ? 6 : 4) || (mode !== undefined && !issueAdmission)) process.exit(3);
const processId = Number(processIdText);
if (issueAdmission && (!/^[1-9][0-9]*$/.test(processIdText ?? '') || !Number.isSafeInteger(processId))) process.exit(3);

// A validated name binds the lookup to this instance's credential namespace.
if (!isValidInstanceName(instance)) process.exit(3);

let config: Record<string, unknown>;
try {
  const parsed: unknown = JSON.parse(readPrivateConfigFileSync(configPath));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) process.exit(3);
  config = parsed;
} catch {
  process.exit(3);
}

// This envelope prevents a malformed/non-agent instance from reading the
// credential. Exact M365 binding validation remains in the shared policy.
if (config['name'] !== instance || config['type'] !== 'agent') process.exit(3);

const candidateAgentOptions = config['agentOptions'];
const agentOptions = typeof candidateAgentOptions === 'object' && candidateAgentOptions !== null && !Array.isArray(candidateAgentOptions)
  ? candidateAgentOptions as Record<string, unknown>
  : undefined;
if (agentOptions === undefined) process.exit(3);
const options = {
  instanceName: instance,
  provider: agentOptions['provider'] as string | undefined,
  allowM365Mutations: agentOptions['allowM365Mutations'] === true,
  enabledPlugins: agentOptions['enabledPlugins'] as Record<string, boolean> | undefined,
  binding: agentOptions['m365Bridge'] as M365BridgeBinding | undefined,
};
if (!m365BridgeCredentialProjectionAllowed(options)) process.exit(3);

if (issueAdmission) {
  const admission = m365BridgeCredentialAdmission(options, processId);
  if (admission === null) process.exit(3);
  process.stdout.write(admission);
}
process.exit(0);
