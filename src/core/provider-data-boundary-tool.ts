import {
  PROVIDER_ALIAS_TYPES,
  ProviderDataBoundaryError,
  type ProviderAliasType,
  type ProviderBoundaryMcpTool,
} from './provider-data-boundary-contract.ts';
import {
  containsProviderAliasSyntax,
  MAX_BOUNDARY_TEXT_LENGTH,
  MAX_TOOL_DEPTH,
  MAX_TOOL_NODES,
  scanProviderTextSequence,
} from './provider-data-boundary-detection.ts';

const TOOL_FIELD_AUTHORIZATIONS: Readonly<Record<string, Readonly<Record<string, ProviderAliasType>>>> = Object.freeze({
  send_media: Object.freeze({ '/filePath': 'path', '/chatJid': 'whatsapp_id' }),
  send_message: Object.freeze({ '/chatJid': 'whatsapp_id', '/to': 'technical_identifier' }),
  reply_message: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  react_message: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  edit_message: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  delete_message: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  send_location: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  send_contact: Object.freeze({ '/chatJid': 'whatsapp_id', '/contacts/*/phone': 'phone' }),
  send_poll: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  pin_message: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  send_button_reply: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  send_list_reply: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  send_limit_sharing: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  share_phone_number: Object.freeze({ '/jid': 'whatsapp_id' }),
  request_phone_number: Object.freeze({ '/jid': 'whatsapp_id' }),
  send_product_message: Object.freeze({ '/jid': 'whatsapp_id' }),
  relay_message: Object.freeze({ '/jid': 'whatsapp_id' }),
  clear_chat: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  delete_chat: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  delete_message_for_me: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  send_event_message: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  mark_chat_read: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  fetch_message_history: Object.freeze({ '/oldest_message_key/remoteJid': 'whatsapp_id' }),
  request_placeholder_resend: Object.freeze({ '/message_key/remoteJid': 'whatsapp_id' }),
  set_disappearing_messages: Object.freeze({ '/jid': 'whatsapp_id' }),
  forward_message: Object.freeze({ '/to_jid': 'whatsapp_id' }),
  archive_chat: Object.freeze({ '/jid': 'whatsapp_id' }),
  pin_chat: Object.freeze({ '/jid': 'whatsapp_id' }),
  mute_chat: Object.freeze({ '/jid': 'whatsapp_id' }),
  mark_messages_read: Object.freeze({ '/jid': 'whatsapp_id' }),
  star_message: Object.freeze({ '/jid': 'whatsapp_id' }),
  schedule_message: Object.freeze({ '/chatJid': 'whatsapp_id', '/filePath': 'path' }),
  list_scheduled: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  memory_write: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  post_status: Object.freeze({ '/filePath': 'path' }),
  list_statuses: Object.freeze({ '/sender_jid': 'whatsapp_id' }),
  get_group_metadata: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_update_subject: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_update_description: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_participants_update: Object.freeze({ '/jid': 'whatsapp_id', '/participants/*': 'whatsapp_id' }),
  group_settings_update: Object.freeze({ '/jid': 'whatsapp_id' }),
  get_group_invite_link: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_create: Object.freeze({ '/participants/*': 'whatsapp_id' }),
  group_leave: Object.freeze({ '/id': 'whatsapp_id' }),
  group_revoke_invite: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_toggle_ephemeral: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_member_add_mode: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_join_approval_mode: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_request_participants_list: Object.freeze({ '/jid': 'whatsapp_id' }),
  group_request_participants_update: Object.freeze({ '/jid': 'whatsapp_id', '/participants/*': 'whatsapp_id' }),
  group_revoke_invite_v4: Object.freeze({ '/groupJid': 'whatsapp_id', '/invitedJid': 'whatsapp_id' }),
  send_group_invite: Object.freeze({ '/chatJid': 'whatsapp_id', '/groupJid': 'whatsapp_id' }),
  get_profile_picture: Object.freeze({ '/jid': 'whatsapp_id' }),
  get_contact_status: Object.freeze({ '/jid': 'whatsapp_id' }),
  check_whatsapp: Object.freeze({ '/phone_numbers/*': 'phone' }),
  request_pairing_code: Object.freeze({ '/phoneNumber': 'phone' }),
  block_contact: Object.freeze({ '/jid': 'whatsapp_id' }),
  update_profile_picture: Object.freeze({ '/jid': 'whatsapp_id' }),
  remove_profile_picture: Object.freeze({ '/jid': 'whatsapp_id' }),
  subscribe_presence: Object.freeze({ '/jid': 'whatsapp_id' }),
  get_presence: Object.freeze({ '/jid': 'whatsapp_id' }),
  send_typing: Object.freeze({ '/chatJid': 'whatsapp_id' }),
  add_or_edit_contact: Object.freeze({ '/jid': 'whatsapp_id', '/phone': 'phone' }),
  remove_contact: Object.freeze({ '/jid': 'whatsapp_id' }),
  fetch_disappearing_duration: Object.freeze({ '/jids/*': 'whatsapp_id' }),
  get_business_profile: Object.freeze({ '/jid': 'whatsapp_id' }),
  update_business_profile: Object.freeze({ '/email': 'email' }),
  get_catalog: Object.freeze({ '/jid': 'whatsapp_id' }),
  get_collections: Object.freeze({ '/jid': 'whatsapp_id' }),
  manage_labels: Object.freeze({ '/chat_jid': 'whatsapp_id' }),
  search_messages_advanced: Object.freeze({ '/sender_jid': 'whatsapp_id' }),
  create_agent_job: Object.freeze({ '/report_chat': 'whatsapp_id' }),
  create_watch: Object.freeze({ '/report_chat': 'whatsapp_id' }),
  capture_task: Object.freeze({ '/chat_jid': 'whatsapp_id', '/owner_jid': 'whatsapp_id' }),
  capture_observation: Object.freeze({
    '/entity_ref/contact_jid': 'whatsapp_id',
    '/entity_ref/group_jid': 'whatsapp_id',
  }),
  list_beads: Object.freeze({ '/owner_jid': 'whatsapp_id', '/chat_jid': 'whatsapp_id' }),
  get_activity: Object.freeze({ '/owner_jid': 'whatsapp_id' }),
  get_profile: Object.freeze({
    '/entity_ref/contact_jid': 'whatsapp_id',
    '/entity_ref/group_jid': 'whatsapp_id',
  }),
  add_alias: Object.freeze({
    '/entity_ref/contact_jid': 'whatsapp_id',
    '/entity_ref/group_jid': 'whatsapp_id',
  }),
  community_metadata: Object.freeze({ '/jid': 'whatsapp_id' }),
  community_create_group: Object.freeze({ '/participants/*': 'whatsapp_id', '/parentJid': 'whatsapp_id' }),
  community_leave: Object.freeze({ '/id': 'whatsapp_id' }),
  community_link_group: Object.freeze({ '/groupJid': 'whatsapp_id', '/communityJid': 'whatsapp_id' }),
  community_unlink_group: Object.freeze({ '/groupJid': 'whatsapp_id', '/communityJid': 'whatsapp_id' }),
  community_fetch_linked_groups: Object.freeze({ '/jid': 'whatsapp_id' }),
  community_participants_update: Object.freeze({ '/jid': 'whatsapp_id', '/participants/*': 'whatsapp_id' }),
  community_invite_code: Object.freeze({ '/jid': 'whatsapp_id' }),
  community_settings_update: Object.freeze({ '/jid': 'whatsapp_id' }),
  community_update_metadata: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_update: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_metadata: Object.freeze({ '/key': 'whatsapp_id' }),
  newsletter_subscribers: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_follow: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_unfollow: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_mute: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_unmute: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_update_name: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_update_description: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_update_picture: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_remove_picture: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_react_message: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_fetch_messages: Object.freeze({ '/jid': 'whatsapp_id' }),
  subscribe_newsletter_updates: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_admin_count: Object.freeze({ '/jid': 'whatsapp_id' }),
  newsletter_change_owner: Object.freeze({ '/jid': 'whatsapp_id', '/newOwnerJid': 'whatsapp_id' }),
  newsletter_demote: Object.freeze({ '/jid': 'whatsapp_id', '/userJid': 'whatsapp_id' }),
  newsletter_delete: Object.freeze({ '/jid': 'whatsapp_id' }),
});
const EXACT_ALIAS_RE = /^⟦WSA1:(?:path|email|whatsapp_id|phone|network_identity|repository_ref|technical_identifier):[0-9a-f]{32}:[0-9a-f]{32}⟧$/u;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function ownValue(schema: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(schema, key) ? schema[key] : undefined;
}

function assertProviderSchemaSafe(schema: Record<string, unknown>): void {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_TOOL_NODES || depth > MAX_TOOL_DEPTH) {
      throw new ProviderDataBoundaryError('limit_exceeded');
    }
    if (typeof value !== 'object' || value === null) return;
    if (ancestors.has(value)) throw new ProviderDataBoundaryError('invalid_tool_input');
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) && (
      prototype !== Array.prototype
      || Object.keys(value).some((key) => !/^(?:0|[1-9]\d*)$/u.test(key))
    )) {
      throw new ProviderDataBoundaryError('invalid_tool_input');
    }
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new ProviderDataBoundaryError('invalid_tool_input');
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
    } else {
      for (const key of Object.keys(value)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new ProviderDataBoundaryError('invalid_tool_input');
        walk((value as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(value);
  };
  walk(schema, 0);
}

function schemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const properties = ownValue(schema, 'properties');
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return Object.create(null) as Record<string, Record<string, unknown>>;
  }
  return properties as Record<string, Record<string, unknown>>;
}

function schemaAliasType(schema: Record<string, unknown>): ProviderAliasType | null {
  const value = ownValue(schema, 'x-whatsoup-alias-type');
  return typeof value === 'string' && (PROVIDER_ALIAS_TYPES as readonly string[]).includes(value)
    ? value as ProviderAliasType
    : null;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function matchesScalarSchema(value: unknown, schema: Record<string, unknown> | undefined): boolean {
  if (schema === undefined) return false;
  const declaredType = ownValue(schema, 'type');
  const types = Array.isArray(declaredType) ? declaredType : [declaredType];
  const typeMatches = types.some((type) => {
    switch (type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
      case 'boolean': return typeof value === 'boolean';
      case 'null': return value === null;
      default: return false;
    }
  });
  if (!typeMatches) return false;
  if (Object.hasOwn(schema, 'const') && !Object.is(value, ownValue(schema, 'const'))) return false;
  const allowed = ownValue(schema, 'enum');
  return !Array.isArray(allowed) || allowed.some((candidate) => Object.is(value, candidate));
}

function authorizedAliasType(
  toolName: string,
  pointer: string,
  schema: Record<string, unknown>,
): ProviderAliasType | null {
  const toolAuthorizations = Object.hasOwn(TOOL_FIELD_AUTHORIZATIONS, toolName)
    ? TOOL_FIELD_AUTHORIZATIONS[toolName]
    : undefined;
  return schemaAliasType(schema) ?? toolAuthorizations?.[pointer] ?? null;
}

export function preflightProviderToolValue(value: unknown): number {
  const ancestors = new WeakSet<object>();
  const orderedTexts: string[] = [];
  let nodes = 0;
  const walk = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_TOOL_NODES || depth > MAX_TOOL_DEPTH) {
      throw new ProviderDataBoundaryError('limit_exceeded');
    }
    if (typeof current === 'string') {
      if (current.length > MAX_BOUNDARY_TEXT_LENGTH) throw new ProviderDataBoundaryError('limit_exceeded');
      orderedTexts.push(current);
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    if (ancestors.has(current)) throw new ProviderDataBoundaryError('invalid_tool_input');
    ancestors.add(current);
    if (Array.isArray(current)) {
      for (const child of current) walk(child, depth + 1);
    } else {
      for (const key of Object.keys(current)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new ProviderDataBoundaryError('invalid_tool_input');
        if (key.length > MAX_BOUNDARY_TEXT_LENGTH) throw new ProviderDataBoundaryError('limit_exceeded');
        orderedTexts.push(key);
        walk((current as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(current);
  };
  walk(value, 0);
  const scan = scanProviderTextSequence(orderedTexts);
  if (scan.fragmentedAlias) throw new ProviderDataBoundaryError('residual_alias');
  return scan.directSecretCount + scan.fragmentedSecretCount;
}

export function rehydrateAuthorizedProviderToolInput(input: {
  readonly toolName: string;
  readonly value: Record<string, unknown>;
  readonly tools: readonly ProviderBoundaryMcpTool[];
  readonly authenticate: (
    alias: string,
    expectedType: ProviderAliasType,
    destinationPointer: string,
  ) => string;
}): { output: Record<string, unknown>; aliasCount: number } {
  const advertised = input.tools.find((candidate) => candidate.name === input.toolName);
  if (!advertised) throw new ProviderDataBoundaryError('unknown_tool');
  assertProviderSchemaSafe(advertised.inputSchema);
  let aliasCount = 0;
  let nodeCount = 0;
  const ancestors = new WeakSet<object>();

  const cloneUnclassified = (value: unknown, depth: number): unknown => {
    nodeCount += 1;
    if (nodeCount > MAX_TOOL_NODES || depth > MAX_TOOL_DEPTH) {
      throw new ProviderDataBoundaryError('limit_exceeded');
    }
    if (typeof value === 'string') {
      if (value.length > MAX_BOUNDARY_TEXT_LENGTH) throw new ProviderDataBoundaryError('limit_exceeded');
      if (containsProviderAliasSyntax(value)) throw new ProviderDataBoundaryError('unauthorized_field');
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ProviderDataBoundaryError('invalid_tool_input');
      return value;
    }
    if (typeof value === 'boolean' || value === null) return value;
    if (typeof value !== 'object') throw new ProviderDataBoundaryError('invalid_tool_input');
    if (ancestors.has(value)) throw new ProviderDataBoundaryError('invalid_tool_input');
    ancestors.add(value);
    if (Array.isArray(value)) {
      const output = value.map((item) => cloneUnclassified(item, depth + 1));
      ancestors.delete(value);
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProviderDataBoundaryError('invalid_tool_input');
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new ProviderDataBoundaryError('invalid_tool_input');
      }
      if (containsProviderAliasSyntax(key)) throw new ProviderDataBoundaryError('unauthorized_field');
      output[key] = cloneUnclassified(child, depth + 1);
    }
    ancestors.delete(value);
    return output;
  };

  const walk = (
    value: unknown,
    schema: Record<string, unknown> | undefined,
    pointer: string,
    depth: number,
  ): unknown => {
    nodeCount += 1;
    if (nodeCount > MAX_TOOL_NODES || depth > MAX_TOOL_DEPTH) {
      throw new ProviderDataBoundaryError('limit_exceeded');
    }
    if (typeof value === 'string') {
      if (value.length > MAX_BOUNDARY_TEXT_LENGTH) throw new ProviderDataBoundaryError('limit_exceeded');
      if (!matchesScalarSchema(value, schema)) throw new ProviderDataBoundaryError('invalid_tool_input');
      if (!containsProviderAliasSyntax(value)) return value;
      if (!EXACT_ALIAS_RE.test(value)) throw new ProviderDataBoundaryError('nested_alias');
      if (schema === undefined || ownValue(schema, 'type') !== 'string') {
        throw new ProviderDataBoundaryError('invalid_tool_input');
      }
      const expectedType = authorizedAliasType(input.toolName, pointer, schema);
      if (expectedType === null) throw new ProviderDataBoundaryError('unauthorized_field');
      aliasCount += 1;
      return input.authenticate(value, expectedType, pointer);
    }
    if (Array.isArray(value)) {
      const items = schema ? ownValue(schema, 'items') : undefined;
      if (schema === undefined || ownValue(schema, 'type') !== 'array' || typeof items !== 'object' || items === null) {
        throw new ProviderDataBoundaryError('invalid_tool_input');
      }
      if (ancestors.has(value)) throw new ProviderDataBoundaryError('invalid_tool_input');
      ancestors.add(value);
      const itemSchema = items as Record<string, unknown>;
      const output = value.map((item) => walk(item, itemSchema, `${pointer}/*`, depth + 1));
      ancestors.delete(value);
      return output;
    }
    if (typeof value === 'object' && value !== null) {
      if (schema === undefined || ownValue(schema, 'type') !== 'object' || ancestors.has(value)) {
        throw new ProviderDataBoundaryError('invalid_tool_input');
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ProviderDataBoundaryError('invalid_tool_input');
      }
      ancestors.add(value);
      const properties = schemaProperties(schema);
      const hasDeclaredProperties = Object.hasOwn(schema, 'properties');
      const additionalProperties = ownValue(schema, 'additionalProperties');
      const required = ownValue(schema, 'required');
      if (Array.isArray(required) && required.some((key) => (
        typeof key !== 'string' || !Object.hasOwn(value, key)
      ))) {
        throw new ProviderDataBoundaryError('invalid_tool_input');
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) {
          throw new ProviderDataBoundaryError('invalid_tool_input');
        }
        if (containsProviderAliasSyntax(key)) throw new ProviderDataBoundaryError('unauthorized_field');
        const childSchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (childSchema === undefined) {
          if (
            typeof additionalProperties === 'object'
            && additionalProperties !== null
            && !Array.isArray(additionalProperties)
          ) {
            const additionalSchema = additionalProperties as Record<string, unknown>;
            output[key] = Reflect.ownKeys(additionalSchema).length === 0
              ? cloneUnclassified(child, depth + 1)
              : walk(
                  child,
                  additionalSchema,
                  `${pointer}/${escapePointerSegment(key)}`,
                  depth + 1,
                );
          } else if (additionalProperties === true || (!hasDeclaredProperties && additionalProperties === undefined)) {
            output[key] = cloneUnclassified(child, depth + 1);
          } else {
            throw new ProviderDataBoundaryError('unauthorized_field');
          }
        } else {
          output[key] = walk(child, childSchema, `${pointer}/${escapePointerSegment(key)}`, depth + 1);
        }
      }
      ancestors.delete(value);
      return output;
    }
    if (!matchesScalarSchema(value, schema)) throw new ProviderDataBoundaryError('invalid_tool_input');
    return value;
  };

  return { output: walk(input.value, advertised.inputSchema, '', 0) as Record<string, unknown>, aliasCount };
}

/** Validate provider tool JSON before JSON.parse can collapse duplicate keys. */
export function assertProviderToolJsonSafe(rawJson: string): void {
  if (rawJson.length > MAX_BOUNDARY_TEXT_LENGTH) throw new ProviderDataBoundaryError('limit_exceeded');
  let cursor = 0;
  let nodes = 0;
  const fail = (): never => { throw new ProviderDataBoundaryError('invalid_tool_input'); };
  const whitespace = (): void => {
    while (cursor < rawJson.length && /\s/u.test(rawJson[cursor]!)) cursor += 1;
  };
  const parseString = (): string => {
    if (rawJson[cursor] !== '"') fail();
    const start = cursor++;
    while (cursor < rawJson.length) {
      const char = rawJson[cursor]!;
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      cursor += 1;
      if (char === '"') {
        try { return JSON.parse(rawJson.slice(start, cursor)) as string; } catch { fail(); }
      }
      if (char.charCodeAt(0) < 0x20) fail();
    }
    return fail();
  };
  const parseValue = (depth: number): void => {
    nodes += 1;
    if (depth > MAX_TOOL_DEPTH || nodes > MAX_TOOL_NODES) throw new ProviderDataBoundaryError('limit_exceeded');
    whitespace();
    const char = rawJson[cursor];
    if (char === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (rawJson[cursor] === '}') { cursor += 1; return; }
      while (cursor < rawJson.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') fail();
        keys.add(key);
        whitespace();
        if (rawJson[cursor++] !== ':') fail();
        parseValue(depth + 1);
        whitespace();
        if (rawJson[cursor] === '}') { cursor += 1; return; }
        if (rawJson[cursor++] !== ',') fail();
      }
      fail();
    }
    if (char === '[') {
      cursor += 1;
      whitespace();
      if (rawJson[cursor] === ']') { cursor += 1; return; }
      while (cursor < rawJson.length) {
        parseValue(depth + 1);
        whitespace();
        if (rawJson[cursor] === ']') { cursor += 1; return; }
        if (rawJson[cursor++] !== ',') fail();
      }
      fail();
    }
    if (char === '"') { parseString(); return; }
    const start = cursor;
    while (cursor < rawJson.length && !/[\s,\]}]/u.test(rawJson[cursor]!)) cursor += 1;
    if (start === cursor) fail();
    try { JSON.parse(rawJson.slice(start, cursor)); } catch { fail(); }
  };
  parseValue(0);
  whitespace();
  if (cursor !== rawJson.length) fail();
}
