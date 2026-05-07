// src/core/substrate/types.ts
export type BeadKind = 'task' | 'project' | 'observation' | 'agent_job' | 'watch';
export type BeadStatus = 'active' | 'proposed' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type TriggerKind =
  | 'schedule.cron' | 'schedule.at_time'
  | 'poll.email' | 'poll.url' | 'poll.file' | 'poll.sqlite' | 'poll.pinecone' | 'poll.shell'
  | 'event.message';
export type TriggerStatus = 'active' | 'paused' | 'expired' | 'cancelled';
export type OnTerminal = 'notify' | 'silent' | 'reopen_bead';
export type EntityKind = 'person' | 'org' | 'project' | 'place' | 'topic' | 'other';
export type AliasKind = 'display_name' | 'handle' | 'email' | 'phone' | 'url' | 'nickname' | 'other';
export type ObservationSourceKind = 'inline' | 'sweep' | 'manual' | 'journal' | 'notes' | 'inbox';
export type BeadEntityRole = 'subject' | 'owner' | 'stakeholder' | 'mentioned' | 'source' | 'blocked_by' | 'project';

export interface BeadRow {
  id: number; kind: BeadKind; status: BeadStatus;
  title: string; body: string | null;
  owner_jid: string; chat_jid: string | null;
  source_message_pk: number | null;
  due_at: number | null; priority: number;
  confidence: number | null; proposal_reason: string | null; review_by_at: number | null;
  parent_bead_id: number | null;
  created_at: number; updated_at: number;
  completed_at: number | null; cancelled_at: number | null;
  metadata_json: string;
}

export interface TriggerRow {
  id: number; bead_id: number; kind: TriggerKind;
  spec_json: string; spec_version: number;
  status: TriggerStatus; interval_seconds: number | null;
  next_fire_at: number | null; last_fire_at: number | null;
  terminal_at: number | null; on_terminal: OnTerminal;
  report_chat_jid: string; dedupe_key: string | null;
  created_at: number; updated_at: number;
}

export interface EntityRow {
  id: number; kind: EntityKind; canonical_name: string;
  contact_jid: string | null; group_jid: string | null;
  created_at: number; updated_at: number;
  merged_into_id: number | null; metadata_json: string;
}

export interface ObservationRow {
  id: number; entity_id: number; kind: string;
  text: string; confidence: number;
  source_message_pk: number | null; source_kind: ObservationSourceKind;
  supersedes_observation_id: number | null;
  forgotten: number; forgotten_reason: string | null;
  created_at: number; metadata_json: string;
}

export interface BeadEventRow {
  id: number; bead_id: number; event_type: string;
  payload_json: string; actor: string;
  source_message_pk: number | null; created_at: number;
}

export interface EntityRef {
  entityId?: number; contactJid?: string; groupJid?: string;
  canonicalName?: string; kind?: EntityKind;
}

export interface ActivityFeedRow {
  source: 'bead_event' | 'entity_observation';
  created_at: number; bead_id?: number; entity_id?: number;
  event_type?: string; observation_kind?: string;
  text: string; actor?: string;
  source_message_pk?: number; owner_jid?: string;
}
