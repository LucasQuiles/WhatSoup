import { z } from 'zod';
import { FixtureDocSchema } from '../collector/fixture.ts';
import { DURATION_PATTERN } from '../lib/duration.ts';
import { Domain, Severity } from '../types.ts';

export const ProfileNameSchema = z.enum(['development', 'personal-strict', 'production', 'customer-managed']);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

export const HostInventorySchema = z.object({
  id: z.string().min(1),
  platform: z.enum(['macos', 'windows', 'linux']),
  collectors: z.array(z.string().min(1)).default([]),
  fixture_docs: z.record(z.string().min(1), FixtureDocSchema).optional(),
}).strict();
export type HostInventory = z.infer<typeof HostInventorySchema>;

export const InstanceInventorySchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  host: z.string().min(1),
}).strict();
export type InstanceInventory = z.infer<typeof InstanceInventorySchema>;

export const InventorySchema = z.object({
  hosts: z.array(HostInventorySchema).default([]),
  instances: z.array(InstanceInventorySchema).default([]),
}).strict();
export type Inventory = z.infer<typeof InventorySchema>;

export const DeploymentRoleSchema = z.object({
  runtime_type: z.enum(['chat', 'agent', 'passive']).optional(),
  provider_env: z.record(z.enum(['required', 'forbidden', 'optional'])).optional(),
  enabled_plugins_max: z.number().int().nonnegative().optional(),
  enabled_plugins: z.array(z.string().min(1)).optional(),
  access_mode: z.record(z.union([z.boolean(), z.string()])).optional(),
  mcp_tool_set: z.array(z.string().min(1)).optional(),
}).strict();
export type DeploymentRole = z.infer<typeof DeploymentRoleSchema>;

export const ActionSchema = z.enum(['observe', 'alert', 'propose_fix', 'remediate', 'block', 'meta_alert']);
export type Action = z.infer<typeof ActionSchema>;

export const DomainPolicySchema = z.object({
  enabled: z.boolean().optional(),
  severity: Severity.optional(),
}).strict();
export type DomainPolicy = z.infer<typeof DomainPolicySchema>;

export const AlertSinkSchema = z.object({
  kind: z.literal('whatsoup'),
  base_url: z.string().min(1).optional(),
  conversation_key: z.string().min(1).optional(),
  delivery_jid: z.string().min(1).optional(),
  target_label: z.string().min(1).optional(),
  token_file: z.string().min(1).optional(),
  timeout_s: z.number().positive().default(10),
  retry_crit: z.array(z.number().nonnegative()).default([1, 5, 30]),
  retry_other: z.array(z.number().nonnegative()).default([]),
}).strict();
export type AlertSink = z.infer<typeof AlertSinkSchema>;

export const MetaAlertSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['ntfy', 'pushover', 'webhook']).optional(),
  secret_file: z.string().min(1).optional(),
  topic_or_destination: z.string().min(1).optional(),
}).strict();
export type MetaAlert = z.infer<typeof MetaAlertSchema>;

export const TransportSchema = z.object({
  alert_sink: AlertSinkSchema,
  meta_alert: MetaAlertSchema.optional(),
}).strict();
export type Transport = z.infer<typeof TransportSchema>;

export const MuteConstraintsSchema = z.object({
  default_max_duration: z.string().regex(DURATION_PATTERN, 'default_max_duration must be a duration like 8h, 30m, or 90s'),
  forbidden_domains: z.array(z.string().min(1)),
  wildcard_blocks_remediation: z.boolean(),
}).strict();
export type MuteConstraints = z.infer<typeof MuteConstraintsSchema>;

export const PolicySchema = z.object({
  extends: ProfileNameSchema,
  inventory: InventorySchema,
  domains: z.record(Domain, DomainPolicySchema).default({}),
  deployment_roles: z.record(DeploymentRoleSchema),
  actions: z.record(ActionSchema),
  transport: TransportSchema,
  mute_constraints: MuteConstraintsSchema,
}).strict();
export type Policy = z.infer<typeof PolicySchema>;
