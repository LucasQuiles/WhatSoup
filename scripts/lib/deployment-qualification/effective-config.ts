import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { validateInstanceConfig } from '../../../src/core/agent-config-validator.ts';
import { isValidInstanceName } from '../../../src/fleet/instance-name.ts';
import { readPrivateFileSync, type PrivateFileObservation } from '../../../src/lib/private-fs.ts';
import { isRecord } from '../../../src/lib/type-guards.ts';
import { parseBoundaryJsonBytes } from '../verification/boundary-run/schema.ts';

const INPUT_LIMIT_BYTES = 1024 * 1024;
const LIMITS = { timeout_seconds: 5, max_bytes: 65536, freshness_seconds: 300 };
const cleanString = z.string().min(1).max(4096).refine((value) => value === value.trim()
  && !/[\x00-\x1f\x7f]/.test(value));
const absolutePath = cleanString.refine((value) => isAbsolute(value) && resolve(value) === value);
const relativePath = cleanString.refine((value) => !isAbsolute(value)
  && value.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..'));
const opaqueRef = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{8,32}$`));
const port = z.number().int().min(1024).max(65535);
const observationInput = z.object({ path: absolutePath, root: absolutePath }).strict();
const contextSchema = z.object({
  arc_commit: z.string().regex(/^[a-f0-9]{40}$/),
  qfleet_commit: z.string().regex(/^[a-f0-9]{40}$/),
  whatsoup_commit: z.string().regex(/^[a-f0-9]{40}$/),
  run_context_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const optionsSchema = z.object({ binding: observationInput, inventory: observationInput,
  instanceRoot: absolutePath, context: contextSchema }).strict();

const deploymentSettingsSchema = z.object({
  uid: z.number().int().nonnegative(), home_root: absolutePath,
  principal: cleanString, platform: z.literal('macos'),
  service_manager: z.literal('launchd'), service_domain: z.enum(['gui', 'user']),
  healthPort: port.optional(), token_file_relative: relativePath,
  launch_agent_plist_relative: relativePath.optional(),
  node_executable: absolutePath.optional(), wrapper_executable: absolutePath.optional(),
}).strict();
const bindingSchema = z.object({
  schema_version: z.literal('whatsoup.deployment-binding.v1'),
  target: z.object({ host_ref: opaqueRef('host'), user_ref: opaqueRef('usr'),
    instance_ref: opaqueRef('inst'), inventory_host: cleanString,
    instance_name: z.string().refine(isValidInstanceName) }).strict(),
  settings: deploymentSettingsSchema.partial(),
  requested: z.object({ healthPort: port.nullable().optional(),
    service: z.record(z.string(), z.unknown()).nullable().optional(),
  }).strict().default({}),
  overrides: z.array(z.object({ field: z.enum(['limits.timeout_seconds', 'limits.max_bytes',
    'limits.freshness_seconds']), value: z.number().positive(), reason: cleanString }).strict())
    .max(3).default([]),
}).strict();
// Qualification consumes the v1 canonical inventory's host projection. qFleet
// continues to own collector scheduling, thresholds and the full inventory policy.
const inventorySchema = z.object({ version: z.literal(1),
  interval_minutes: z.number().positive(), collector_origin: cleanString.optional(),
  timeouts: z.record(z.string(), z.unknown()), debounce: z.record(z.string(), z.unknown()),
  thresholds: z.record(z.string(), z.unknown()),
  hosts: z.record(z.string(), z.record(z.string(), z.unknown())) }).passthrough();
const inventoryHostSchema = z.object({
  tier: z.enum(['alert', 'observe']), probe: z.enum(['ssh', 'local']).optional(),
  role: cleanString.optional(), principal: cleanString.nullable().optional(),
  ssh_alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).nullable().optional(),
  tailscale_ip: cleanString.optional(),
  services: z.array(z.record(z.string(), z.unknown())),
  required_processes: z.array(cleanString),
  expected_listening_ports: z.array(z.number().int().min(1).max(65535)),
}).passthrough();

type Owner = 'whatsoup_instance' | 'qualification_binding' | 'qfleet_inventory' | 'qualification_policy';
type SourceName = 'binding' | 'inventory' | 'instance_config';
interface FieldRecord {
  field: string;
  owner: Owner;
  source_raw_sha256: string;
  presence: 'absent' | 'null' | 'value';
  value?: unknown;
  override_reason: string | null;
  derived_from?: string[];
}
type ErrorCode = 'INPUT_INVALID' | 'OWNER_CONFLICT' | 'EVIDENCE_STALE' | 'DEPENDENCY_UNAVAILABLE';
export class EffectiveConfigError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
    this.name = 'EffectiveConfigError';
  }
}
function fail(code: ErrorCode): never { throw new EffectiveConfigError(code); }

function observe(input: z.infer<typeof observationInput>): PrivateFileObservation {
  try {
    const result = readPrivateFileSync(input.path, { maxBytes: INPUT_LIMIT_BYTES,
      observation: { root: input.root } });
    if (!result) fail('INPUT_INVALID');
    return result;
  } catch (error) {
    if (error instanceof EffectiveConfigError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    fail(code === 'ESTALE' ? 'EVIDENCE_STALE' : code === 'ENOTSUP'
      ? 'DEPENDENCY_UNAVAILABLE' : 'INPUT_INVALID');
  }
}
function parseInput(observation: PrivateFileObservation): Record<string, unknown> {
  const result = parseBoundaryJsonBytes(observation.bytes,
    { allowCarriageReturns: true, allowNegativeZero: true, rejectNonFiniteNumbers: true });
  if (!result.result.ok || !isRecord(result.value)) fail('INPUT_INVALID');
  return result.value;
}
function beneath(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function selected(raw: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(raw, key)).map((key) => [key, raw[key]]));
}

/** Resolve private inputs without invoking the stateful instance loader or changing settings. */
export function resolveDeploymentEffectiveConfig(rawOptions: unknown) {
  try {
    return resolveEffectiveConfig(rawOptions);
  } catch (error) {
    if (error instanceof EffectiveConfigError) throw error;
    return fail('INPUT_INVALID');
  }
}

function resolveEffectiveConfig(rawOptions: unknown) {
  const parsedOptions = optionsSchema.safeParse(rawOptions);
  if (!parsedOptions.success) fail('INPUT_INVALID');
  const options = parsedOptions.data;
  const bindingObservation = observe(options.binding);
  const rawBinding = parseInput(bindingObservation);
  const rawSettings = isRecord(rawBinding.settings) ? rawBinding.settings : {};
  const forbiddenSettings = ['service', 'agentOptions', 'type', 'accessMode', 'ssh_alias',
    'tailscale_ip', 'services', 'required_processes', 'expected_listening_ports', 'tier'];
  if (forbiddenSettings.some((key) => Object.hasOwn(rawSettings, key))) fail('OWNER_CONFLICT');
  const bindingResult = bindingSchema.safeParse(rawBinding);
  if (!bindingResult.success) fail('INPUT_INVALID');
  const binding = bindingResult.data;
  const instanceInput = { root: options.instanceRoot,
    path: join(options.instanceRoot, binding.target.instance_name, 'config.json') };
  const inventoryObservation = observe(options.inventory);
  const inventoryResult = inventorySchema.safeParse(parseInput(inventoryObservation));
  if (!inventoryResult.success) fail('INPUT_INVALID');
  const rawHost = inventoryResult.data.hosts[binding.target.inventory_host];
  if (!rawHost || !Object.hasOwn(inventoryResult.data.hosts, binding.target.inventory_host)) fail('INPUT_INVALID');
  const hostResult = inventoryHostSchema.safeParse(rawHost);
  if (!hostResult.success) fail('INPUT_INVALID');
  const host = hostResult.data;
  if (Object.hasOwn(host, 'name') && host.name !== binding.target.inventory_host) fail('INPUT_INVALID');
  const collectors = Object.entries(inventoryResult.data.hosts).filter(([, row]) => row.role === 'collector');
  const origin = inventoryResult.data.collector_origin ?? (collectors.length === 1 ? collectors[0]![0] : null);
  if ((host.probe ?? 'ssh') === 'ssh') {
    if (!host.ssh_alias || !host.tailscale_ip) fail('INPUT_INVALID');
  } else if (origin !== binding.target.inventory_host) fail('INPUT_INVALID');
  for (const key of Object.keys(binding.settings)) {
    if (Object.hasOwn(host, key)) fail('OWNER_CONFLICT');
  }
  const settingsResult = deploymentSettingsSchema.safeParse({
    ...selected(host, Object.keys(deploymentSettingsSchema.shape)), ...binding.settings,
  });
  if (!settingsResult.success) fail('INPUT_INVALID');
  const settings = settingsResult.data;
  if (!beneath(settings.home_root, options.instanceRoot)) fail('INPUT_INVALID');
  const instanceObservation = observe(instanceInput);
  const instance = parseInput(instanceObservation);
  if (validateInstanceConfig(instance, { name: binding.target.instance_name, mode: 'load' })) {
    fail('INPUT_INVALID');
  }
  if (Object.hasOwn(instance, 'healthPort') && settings.healthPort !== undefined) fail('OWNER_CONFLICT');
  const healthPort = Object.hasOwn(instance, 'healthPort') ? instance.healthPort : settings.healthPort;
  if (!port.safeParse(healthPort).success) fail('INPUT_INVALID');
  const service = isRecord(instance.service) ? instance.service : {};
  const serviceKeys = ['claudeConfigDir', 'pathPrepend', 'expectedAccountDigest'];
  if (binding.requested.service !== undefined && binding.requested.service !== null) {
    if (Object.keys(binding.requested.service).some((key) => !serviceKeys.includes(key))) fail('OWNER_CONFLICT');
    if (validateInstanceConfig({ ...instance, service: binding.requested.service },
      { name: binding.target.instance_name, mode: 'load' })) fail('INPUT_INVALID');
  }
  const fields: FieldRecord[] = [];
  const add = (field: string, owner: Owner, digest: string, value: unknown,
    reason: string | null = null, derivedFrom?: string[]): void => {
    if (isRecord(value) && Object.keys(value).length > 0) {
      for (const [key, child] of Object.entries(value)) {
        const address = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
        add(`${field}${address}`, owner, digest, child, reason, derivedFrom);
      }
      return;
    }
    fields.push({ field, owner, source_raw_sha256: digest,
      presence: value === undefined ? 'absent' : value === null ? 'null' : 'value',
      ...(value === undefined ? {} : { value }), override_reason: reason,
      ...(derivedFrom === undefined ? {} : { derived_from: derivedFrom }) });
  };
  const settingsOwner = (key: string): Owner => Object.hasOwn(host, key) ? 'qfleet_inventory' : 'qualification_binding';
  const settingsDigest = (key: string) => Object.hasOwn(host, key) ? inventoryObservation.rawSha256 : bindingObservation.rawSha256;
  for (const key of ['name', 'type', 'accessMode']) {
    add(`configured.instance.${key}`, 'whatsoup_instance', instanceObservation.rawSha256, instance[key]);
  }
  const instanceHasPort = Object.hasOwn(instance, 'healthPort');
  add('configured.instance.healthPort', instanceHasPort ? 'whatsoup_instance' : settingsOwner('healthPort'),
    instanceHasPort ? instanceObservation.rawSha256 : settingsDigest('healthPort'), healthPort);
  for (const key of serviceKeys) add(`configured.service.${key}`, 'whatsoup_instance', instanceObservation.rawSha256, service[key]);
  if (Object.keys(selected(service, serviceKeys)).length === 0) {
    add('configured.service', 'whatsoup_instance', instanceObservation.rawSha256, {});
  }
  const agentOptions = isRecord(instance.agentOptions) ? instance.agentOptions : {};
  for (const key of ['provider', 'model', 'fallbackProvider', 'fallbackModel']) {
    add(`configured.agentOptions.${key}`, 'whatsoup_instance', instanceObservation.rawSha256, agentOptions[key]);
  }
  if (Object.keys(selected(agentOptions, ['provider', 'model', 'fallbackProvider', 'fallbackModel'])).length === 0) {
    add('configured.agentOptions', 'whatsoup_instance', instanceObservation.rawSha256, {});
  }
  add('configured.host', 'qfleet_inventory', inventoryObservation.rawSha256, host);
  for (const [key, value] of Object.entries(settings)) {
    add(`configured.deployment.${key}`, settingsOwner(key), settingsDigest(key), value);
  }
  const tokenFile = join(settings.home_root, settings.token_file_relative);
  add('configured.deployment.token_file', settingsOwner('token_file_relative'), settingsDigest('token_file_relative'),
    tokenFile, null, ['configured.deployment.home_root', 'configured.deployment.token_file_relative']);
  const launchAgentPlist = settings.launch_agent_plist_relative === undefined
    ? undefined : join(settings.home_root, settings.launch_agent_plist_relative);
  if (launchAgentPlist !== undefined) {
    add('configured.deployment.launch_agent_plist', settingsOwner('launch_agent_plist_relative'), settingsDigest('launch_agent_plist_relative'),
      launchAgentPlist, null, ['configured.deployment.home_root', 'configured.deployment.launch_agent_plist_relative']);
  }
  add('requested', 'qualification_binding', bindingObservation.rawSha256, binding.requested);
  for (const [key, value] of Object.entries(binding.target)) add(`target.${key}`, 'qualification_binding', bindingObservation.rawSha256, value);
  const policyDigest = createHash('sha256').update(JSON.stringify(LIMITS)).digest('hex');
  const limits = { ...LIMITS };
  const overridden = new Set<string>();
  for (const override of binding.overrides) {
    const key = override.field.slice('limits.'.length) as keyof typeof LIMITS;
    if (overridden.has(key) || override.value > LIMITS[key]
      || (key === 'timeout_seconds' && override.value < 0.01)
      || (key !== 'timeout_seconds' && !Number.isInteger(override.value))) fail('INPUT_INVALID');
    overridden.add(key);
    limits[key] = override.value;
    add(override.field, 'qualification_binding', bindingObservation.rawSha256, override.value, override.reason);
  }
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (!overridden.has(key)) add(`limits.${key}`, 'qualification_policy', policyDigest, limits[key]);
  }
  const sourceInputs = { binding: options.binding, inventory: options.inventory, instance_config: instanceInput };
  const observations = { binding: bindingObservation, inventory: inventoryObservation, instance_config: instanceObservation };
  const sources = Object.fromEntries((Object.keys(observations) as SourceName[]).map((name) => {
    const before = observations[name];
    const after = observe(sourceInputs[name]);
    if (before.rawSha256 !== after.rawSha256 || JSON.stringify(before.identity) !== JSON.stringify(after.identity)) {
      fail('EVIDENCE_STALE');
    }
    return [name, { path: sourceInputs[name].path, root: sourceInputs[name].root,
      raw_sha256: before.rawSha256, identity: before.identity }];
  })) as Record<SourceName, { path: string; root: string; raw_sha256: string; identity: PrivateFileObservation['identity'] }>;
  return {
    schema_version: 'whatsoup.effective-config.v1' as const,
    generated_at: new Date().toISOString(), context: options.context, target: binding.target,
    sources, requested: binding.requested,
    configured: { host, instance: { ...selected(instance, ['name', 'type', 'accessMode']), healthPort },
      service: selected(service, serviceKeys), agentOptions: selected(agentOptions, ['provider', 'model', 'fallbackProvider', 'fallbackModel']),
      deployment: { ...settings, token_file: tokenFile,
        ...(launchAgentPlist === undefined ? {} : { launch_agent_plist: launchAgentPlist }) } },
    fields, limits, policy_digest: policyDigest, transport_identity: 'unresolved' as const,
  };
}
