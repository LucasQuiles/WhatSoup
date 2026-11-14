import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../lib/clock.ts';
import { bareNumber, isLidJid, JID_PERSONAL, normalizeLid } from './jid-constants.ts';
import { lookupStoredLidPhoneJid } from './lid-resolver.ts';
import { createOutboundSendsWriter, type OutboundSendsWriter } from './outbound-sends.ts';
import { PROTECTED_DELIVERY_PINS, type ProtectedDeliveryPins } from './protected-delivery-pins.ts';
import { isCanonicalManagedLink } from './protected-message.ts';
import type { SendOptions, SubmissionReceipt } from './types.ts';

export type ProtectedDeliveryPurpose = 'login' | 'recovery';
export type ProtectedDeliveryKind = 'rustdesk' | 'secret';
export type ProtectedDeliveryState = 'staging' | 'staged' | 'resolving' | 'submitted' | 'delivered' | 'read' | 'ambiguous' | 'failed' | 'expired';
export type DeliveryEventStatus = 'submitted' | 'delivered' | 'read' | 'ambiguous' | 'failed';
export interface ManagedDeliveryStatus {
  deliveryRef: string; id: string; state: string; deliveryStatus: string; expiresAt: string; issuedAt: string;
  kind: ProtectedDeliveryKind; deviceId: string | null; purpose: ProtectedDeliveryPurpose | null;
}
export interface ManagedDeliveryClient {
  stageRustdesk(r: { deviceId: string; purpose: ProtectedDeliveryPurpose; principal: string; operationId: string }): Promise<{ deliveryRef: string; id: string; expiresAt: string; state: string }>;
  resolve(r: { deliveryRef: string; principal: string; operationId: string }): Promise<{ id: string; link: string; expiresAt: string; state: string }>;
  getStatus(r: { deliveryRef: string; principal: string }): Promise<ManagedDeliveryStatus>;
  reportEvent(e: { deliveryRef: string; eventId: string; status: DeliveryEventStatus; observedAt: string }): Promise<void>;
}
export interface ProtectedDeliveryMessenger {
  sendRaw(jid: string, content: Record<string, unknown>, options?: SendOptions): Promise<SubmissionReceipt>;
}
interface Row {
  id: number; stage_operation_id: string; resolve_operation_id: string; delivery_ref: string | null; delivery_id: string | null;
  principal: string; recipient_jid: string; kind: ProtectedDeliveryKind; device_id: string | null; purpose: ProtectedDeliveryPurpose | null;
  whatsapp_message_id: string; state: ProtectedDeliveryState; expires_at: string | null; issued_at: string;
  first_attempt_at: string | null; attempt_count: number; send_claim_token: string | null; send_claimed_at: string | null;
}
const MAX_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 60_000;
/**
 * A stage or send lease younger than the retry window may still receive its
 * stable acknowledgement or a receipt, so only its holder may clear it. Expiry
 * and retry-limit transitions by any other caller apply only to rows without a
 * fresh lease. Bind: the stale-lease cutoff from leaseCutoff().
 */
const WITHOUT_FRESH_LEASE = '(send_claim_token IS NULL OR send_claimed_at IS NULL OR julianday(send_claimed_at) <= julianday(?))';
function leaseCutoff(now: Date): string { return new Date(now.getTime() - RETRY_WINDOW_MS).toISOString(); }
function hasFreshLease(row: Pick<Row, 'send_claim_token' | 'send_claimed_at'>, now: Date): boolean {
  return !!row.send_claim_token && !!row.send_claimed_at && new Date(row.send_claimed_at).getTime() + RETRY_WINDOW_MS > now.getTime();
}
export const PROTECTED_DELIVERY_RETENTION_DAYS = 90;

export class ProtectedDeliveryService {
  private readonly audit: OutboundSendsWriter;
  private readonly deps: {
    db: DatabaseSync; client: ManagedDeliveryClient; messenger: ProtectedDeliveryMessenger;
    now?: () => Date; randomId?: () => string; auditWriter?: OutboundSendsWriter; pins?: ProtectedDeliveryPins;
  };
  constructor(deps: {
    db: DatabaseSync; client: ManagedDeliveryClient; messenger: ProtectedDeliveryMessenger;
    now?: () => Date; randomId?: () => string; auditWriter?: OutboundSendsWriter; pins?: ProtectedDeliveryPins;
  }) {
    this.deps = deps;
    this.audit = deps.auditWriter ?? createOutboundSendsWriter({ db: deps.db });
  }

  async requestRustdesk(input: { deviceId: string; purpose: ProtectedDeliveryPurpose; principal: string; recipientJid: string }): Promise<{ deliveryRef: string; id: string; expiresAt: string; state: string }> {
    this.assertCanonicalRecipient(input.principal, input.recipientJid);
    const now = this.now();
    const nowIso = now.toISOString();
    this.expireOverdueUncertainDeliveries(now);
    const activeLeaseCutoff = leaseCutoff(now);
    const active = this.deps.db.prepare(`SELECT 1 FROM protected_deliveries
      WHERE kind='rustdesk' AND device_id=? AND purpose=? AND principal=?
        AND state IN ('staging','staged','resolving','failed','ambiguous')
        AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?)
        AND send_claim_token IS NOT NULL AND send_claimed_at IS NOT NULL
        AND julianday(send_claimed_at) > julianday(?)
      LIMIT 1`).get(input.deviceId, input.purpose, input.principal, nowIso, activeLeaseCutoff);
    if (active) throw new Error('protected delivery outcome is still unresolved');
    const old = this.deps.db.prepare(`SELECT * FROM protected_deliveries
      WHERE kind='rustdesk' AND device_id=? AND purpose=? AND principal=?
        AND state IN ('staging','staged','resolving','failed','ambiguous')
        AND expires_at IS NOT NULL AND julianday(expires_at) > julianday(?)
      ORDER BY id DESC LIMIT 1`)
      .get(input.deviceId, input.purpose, input.principal, nowIso) as Row | undefined;
    if (old && !this.matchesCanonicalRecipient(old, input.principal, input.recipientJid)) {
      throw new Error('protected delivery recipient identity is unresolved');
    }
    const row = old ?? this.insertRustdesk(input);
    if (row.delivery_ref && row.delivery_id && row.expires_at && row.state !== 'staging') {
      return { deliveryRef: row.delivery_ref, id: row.delivery_id, expiresAt: row.expires_at, state: row.state };
    }
    if (row.state !== 'staging') throw new Error('protected delivery staging outcome is ambiguous');
    const claimed = this.claimStage(row);
    let staged: { deliveryRef: string; id: string; expiresAt: string; state: string };
    try {
      staged = await this.deps.client.stageRustdesk({ deviceId: claimed.device_id!, purpose: claimed.purpose!, principal: claimed.principal, operationId: claimed.stage_operation_id });
      if (!opaqueId(staged.deliveryRef) || !opaqueId(staged.id) || !instant(staged.expiresAt) || new Date(staged.expiresAt).getTime() <= now.getTime()) throw new Error('invalid');
    } catch {
      this.releaseStage(claimed);
      throw new Error('protected delivery staging failed');
    }
    this.deps.db.prepare(`UPDATE protected_deliveries SET delivery_ref=?,delivery_id=?,expires_at=?,state='staged',attempt_count=0,first_attempt_at=NULL,last_attempt_at=NULL,send_claim_token=NULL,send_claimed_at=NULL,updated_at=? WHERE id=? AND send_claim_token=?`)
      .run(staged.deliveryRef, staged.id, staged.expiresAt, nowIso, claimed.id, claimed.send_claim_token);
    return { ...staged, state: 'staged' };
  }

  /** request_rustdesk_access mints and sends; it never returns the resolved link. */
  async requestRustdeskAccess(input: { deviceId: string; purpose: ProtectedDeliveryPurpose; principal: string; recipientJid: string }): Promise<{ deliveryRef: string; id: string; state: string }> {
    const stage = await this.requestRustdesk(input);
    if (stage.state !== 'staged') return { deliveryRef: stage.deliveryRef, id: stage.id, state: stage.state };
    return this.deliver({ deliveryRef: stage.deliveryRef, principal: input.principal, recipientJid: input.recipientJid });
  }

  async deliver(input: { deliveryRef: string; principal: string; recipientJid: string }): Promise<{ deliveryRef: string; id: string; state: string }> {
    if (!opaqueId(input.deliveryRef)) throw new Error('protected delivery reference is invalid');
    this.assertCanonicalRecipient(input.principal, input.recipientJid);
    let row = this.find(input.deliveryRef, input.principal);
    if (!row) row = await this.adopt(input);
    row = this.canonicalizeLegacyRecipient(row, input.principal, input.recipientJid);
    const claimed = this.claim(row);
    if (sent(claimed.state)) return publicRow(claimed);
    let resolved: { id: string; link: string; expiresAt: string; state: string };
    try {
      resolved = await this.deps.client.resolve({ deliveryRef: claimed.delivery_ref!, principal: claimed.principal, operationId: claimed.resolve_operation_id });
      if (!opaqueId(resolved.id) || !isCanonicalManagedLink(resolved.link, this.deps.pins ?? PROTECTED_DELIVERY_PINS) || !instant(resolved.expiresAt) || resolved.id !== claimed.delivery_id) throw new Error('invalid');
    } catch {
      if (this.fail(claimed)) this.event(claimed, 'failed');
      throw new Error('protected delivery resolution failed');
    }
    if (new Date(resolved.expiresAt).getTime() <= this.now().getTime()) { this.expire(claimed); throw new Error('protected delivery is expired'); }
    const outbound = this.audit.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    this.deps.db.prepare(`UPDATE protected_deliveries SET outbound_send_id=?,expires_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND send_claim_token=?`).run(outbound.id, resolved.expiresAt, claimed.id, claimed.send_claim_token);
    try {
      const result = await this.deps.messenger.sendRaw(claimed.recipient_jid, { text: resolved.link, linkPreview: null }, { messageId: claimed.whatsapp_message_id });
      if (result.waMessageId !== claimed.whatsapp_message_id) throw new Error('stable id rejected');
    } catch {
      // Never persist or reflect a send exception; providers may include the full URL in it.
      const safe = new Error('protected delivery transport outcome is ambiguous');
      this.audit.markFailure(outbound.id, safe);
      if (this.ambiguous(claimed)) this.event(claimed, 'ambiguous');
      throw safe;
    }
    this.audit.markSuccess(outbound.id);
    this.deps.db.prepare(`UPDATE protected_deliveries SET state='submitted',send_claim_token=NULL,send_claimed_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND send_claim_token=?`).run(claimed.id, claimed.send_claim_token);
    this.event(claimed, 'submitted');
    return { deliveryRef: claimed.delivery_ref!, id: resolved.id, state: 'submitted' };
  }

  async status(input: { deliveryId: string; principal: string }): Promise<{ id: string; state: string; deliveryStatus: string; expiresAt: string }> {
    if (!opaqueId(input.deliveryId)) throw new Error('protected delivery id is invalid');
    const row = this.deps.db.prepare('SELECT * FROM protected_deliveries WHERE delivery_id=? AND principal=?').get(input.deliveryId, input.principal) as Row | undefined;
    if (!row?.delivery_ref || !row.delivery_id) throw new Error('protected delivery not found');
    let remote: ManagedDeliveryStatus;
    try { remote = await this.deps.client.getStatus({ deliveryRef: row.delivery_ref, principal: row.principal }); validStatus(remote, row.delivery_ref, row.delivery_id); }
    catch { throw new Error('protected delivery status is unavailable'); }
    // A claimed RustDesk grant has a session that can outlive its original
    // unclaimed-link deadline. The backend's grant state is authoritative.
    const expired = remote.state === 'expired';
    // A send in flight settles its own row; polling must not clear its lease.
    if (expired) this.expireWithoutFreshLease(row, this.now());
    this.deps.db.prepare(`UPDATE protected_deliveries SET expires_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(remote.expiresAt, row.id);
    return {
      id: row.delivery_id,
      state: remote.state,
      deliveryStatus: projectDeliveryStatus(row.state, remote.deliveryStatus),
      expiresAt: remote.expiresAt,
    };
  }

  async recordReceipt(input: { whatsappMessageId: string; recipientJid: string; type: string }): Promise<boolean> {
    const status = input.type === 'delivery' ? 'delivered' : input.type === 'read' ? 'read' : null;
    if (!status) return false;
    const row = this.deps.db.prepare('SELECT * FROM protected_deliveries WHERE whatsapp_message_id=? AND recipient_jid=?').get(input.whatsappMessageId, input.recipientJid) as Row | undefined;
    if (!row?.delivery_ref) return false;
    const next = status === 'read' || row.state !== 'read' ? status : row.state;
    this.deps.db.prepare(`UPDATE protected_deliveries SET state=?,send_claim_token=NULL,send_claimed_at=NULL,terminal_at=CASE WHEN ?='read' THEN COALESCE(terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE terminal_at END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(next, next, row.id);
    this.event(row, status, row.delivery_ref + ':wa:' + input.whatsappMessageId + ':' + status);
    return true;
  }

  async flushPendingEvents(): Promise<{ relayed: number; pending: number; failed: boolean }> {
    const events = this.deps.db.prepare('SELECT event_id,delivery_ref,status,observed_at FROM protected_delivery_events WHERE relayed_at IS NULL ORDER BY created_at ASC LIMIT 100').all() as Array<{ event_id: string; delivery_ref: string; status: DeliveryEventStatus; observed_at: string }>;
    let relayed = 0;
    for (const e of events) {
      try {
        await this.deps.client.reportEvent({ eventId: e.event_id, deliveryRef: e.delivery_ref, status: e.status, observedAt: e.observed_at });
        this.deps.db.prepare(`UPDATE protected_delivery_events SET relayed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id=? AND relayed_at IS NULL`).run(e.event_id);
        relayed += 1;
      } catch {
        return { relayed, pending: events.length - relayed, failed: true };
      }
    }
    return { relayed, pending: 0, failed: false };
  }

  /**
   * Startup recovery sends only the already-minted staged rows that are still
   * within the short retry window. It never stages or adopts a replacement.
   */
  async recoverPendingDeliveries(): Promise<{ resumed: number; skipped: number }> {
    const now = this.now();
    this.expireOverdueUncertainDeliveries(now);
    const cutoff = new Date(now.getTime() - RETRY_WINDOW_MS).toISOString();
    const rows = this.deps.db.prepare(`SELECT delivery_ref,principal,recipient_jid FROM protected_deliveries
      WHERE state='staged' AND delivery_ref IS NOT NULL AND delivery_id IS NOT NULL
        AND expires_at IS NOT NULL AND julianday(expires_at) > julianday(?)
        AND attempt_count < ? AND julianday(updated_at) >= julianday(?)
      ORDER BY id ASC LIMIT 100`).all(now.toISOString(), MAX_ATTEMPTS, cutoff) as Array<Pick<Row, 'delivery_ref' | 'principal' | 'recipient_jid'>>;
    let resumed = 0;
    let skipped = 0;
    for (const row of rows) {
      const recipientJid = this.canonicalRecipient(row.principal);
      if (!this.matchesCanonicalRecipient(row, row.principal, recipientJid)) {
        skipped += 1;
        continue;
      }
      try {
        await this.deliver({ deliveryRef: row.delivery_ref!, principal: row.principal, recipientJid });
        resumed += 1;
      } catch {
        skipped += 1;
      }
    }
    return { resumed, skipped };
  }

  maintain(mode: 'preview' | 'apply'): { mode: 'preview' | 'apply'; eligibleRows: number; deletedRows: number } {
    const eligibleRows = countExpiredProtectedDeliveries(this.deps.db);
    return mode === 'preview' || eligibleRows === 0 ? { mode, eligibleRows, deletedRows: 0 } : { mode, eligibleRows, deletedRows: deleteExpiredProtectedDeliveries(this.deps.db) };
  }

  private insertRustdesk(i: { deviceId: string; purpose: ProtectedDeliveryPurpose; principal: string; recipientJid: string }): Row {
    const issuedAt = this.nowIso();
    // RustDesk issuances are capped at five minutes. A local deadline bounds a lost stage response.
    const expiresAt = new Date(this.now().getTime() + 300_000).toISOString();
    const row: Row = { id: 0, stage_operation_id: this.id(), resolve_operation_id: this.id(), delivery_ref: null, delivery_id: null, principal: i.principal, recipient_jid: i.recipientJid, kind: 'rustdesk', device_id: i.deviceId, purpose: i.purpose, whatsapp_message_id: this.id(), state: 'staging', expires_at: expiresAt, issued_at: issuedAt, first_attempt_at: null, attempt_count: 0, send_claim_token: null, send_claimed_at: null };
    row.id = Number(this.deps.db.prepare('INSERT INTO protected_deliveries (stage_operation_id,resolve_operation_id,principal,recipient_jid,kind,device_id,purpose,whatsapp_message_id,state,expires_at,issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.stage_operation_id,row.resolve_operation_id,row.principal,row.recipient_jid,row.kind,row.device_id,row.purpose,row.whatsapp_message_id,row.state,row.expires_at,row.issued_at).lastInsertRowid);
    return row;
  }
  private claimStage(row: Row): Row {
    const now = this.now(); const at = now.toISOString(); let claim: Row | undefined; let rejected: Error | undefined;
    this.deps.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.deps.db.prepare('SELECT * FROM protected_deliveries WHERE id=?').get(row.id) as Row | undefined;
      if (!current || current.state !== 'staging') rejected = new Error('protected delivery is no longer staging');
      else if (hasFreshLease(current, now)) rejected = new Error('protected delivery is already being staged');
      else if (!current.expires_at || new Date(current.expires_at).getTime() <= now.getTime()) { this.expire(current); rejected = new Error('protected delivery is expired'); }
      else if (current.attempt_count >= MAX_ATTEMPTS || (current.first_attempt_at && new Date(current.first_attempt_at).getTime() + RETRY_WINDOW_MS <= now.getTime())) { this.fail(current); rejected = new Error('protected delivery staging retry limit reached'); }
      else {
        const token = this.id();
        this.deps.db.prepare(`UPDATE protected_deliveries SET attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,?),last_attempt_at=?,send_claim_token=?,send_claimed_at=?,updated_at=? WHERE id=?`).run(at,at,token,at,at,current.id);
        claim = { ...current, attempt_count: current.attempt_count + 1, first_attempt_at: current.first_attempt_at ?? at, send_claim_token: token, send_claimed_at: at };
      }
      this.deps.db.exec('COMMIT');
    } catch (error) { this.deps.db.exec('ROLLBACK'); throw error; }
    if (rejected) throw rejected;
    if (!claim) throw new Error('protected delivery could not be staged');
    return claim;
  }
  private releaseStage(row: Row): void {
    this.deps.db.prepare(`UPDATE protected_deliveries SET state=CASE WHEN attempt_count>=? THEN 'failed' ELSE 'staging' END,send_claim_token=NULL,send_claimed_at=NULL,terminal_at=CASE WHEN attempt_count>=? THEN COALESCE(terminal_at,?) ELSE terminal_at END,updated_at=? WHERE id=? AND send_claim_token=?`)
      .run(MAX_ATTEMPTS, MAX_ATTEMPTS, this.nowIso(), this.nowIso(), row.id, row.send_claim_token);
  }
  private find(ref: string, principal: string): Row | undefined {
    return this.deps.db.prepare('SELECT * FROM protected_deliveries WHERE delivery_ref=? AND principal=?').get(ref, principal) as Row | undefined;
  }
  private canonicalRecipient(principal: string): string { return principal + JID_PERSONAL; }
  private assertCanonicalRecipient(principal: string, recipientJid: string): void {
    if (recipientJid !== this.canonicalRecipient(principal)) {
      throw new Error('protected delivery recipient does not match the verified principal');
    }
  }
  private matchesCanonicalRecipient(row: Pick<Row, 'recipient_jid'>, principal: string, canonicalJid: string): boolean {
    if (canonicalJid !== this.canonicalRecipient(principal)) return false;
    if (row.recipient_jid === canonicalJid) return true;
    if (!isLidJid(row.recipient_jid)) return false;
    const lid = normalizeLid(bareNumber(row.recipient_jid));
    return lookupStoredLidPhoneJid(this.deps.db, lid) === canonicalJid;
  }
  private canonicalizeLegacyRecipient(row: Row, principal: string, canonicalJid: string): Row {
    if (row.recipient_jid === canonicalJid) return row;
    if (!this.matchesCanonicalRecipient(row, principal, canonicalJid)) {
      throw new Error('protected delivery recipient identity is unresolved');
    }
    if (row.state !== 'staging' && row.state !== 'staged' && row.state !== 'failed') {
      throw new Error('protected delivery recipient does not match the direct conversation');
    }
    const changed = this.deps.db.prepare(`UPDATE protected_deliveries
      SET recipient_jid=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND recipient_jid=? AND send_claim_token IS NULL AND state IN ('staging','staged','failed')`)
      .run(canonicalJid, row.id, row.recipient_jid).changes;
    if (changed !== 1) throw new Error('protected delivery recipient does not match the direct conversation');
    const updated = this.deps.db.prepare('SELECT * FROM protected_deliveries WHERE id=?').get(row.id) as Row | undefined;
    if (!updated || updated.recipient_jid !== canonicalJid) throw new Error('protected delivery recipient does not match the direct conversation');
    return updated;
  }
  private async adopt(i: { deliveryRef: string; principal: string; recipientJid: string }): Promise<Row> {
    let remote: ManagedDeliveryStatus;
    try { remote = await this.deps.client.getStatus({ deliveryRef: i.deliveryRef, principal: i.principal }); validStatus(remote, i.deliveryRef); }
    catch { throw new Error('protected delivery could not be adopted'); }
    if (new Date(remote.expiresAt).getTime() <= this.now().getTime() || remote.state !== 'unclaimed' || remote.deliveryStatus !== 'staged') {
      throw new Error('protected delivery is not available for first send');
    }
    this.deps.db.prepare(`INSERT OR IGNORE INTO protected_deliveries (stage_operation_id,resolve_operation_id,delivery_ref,delivery_id,principal,recipient_jid,kind,device_id,purpose,whatsapp_message_id,state,expires_at,issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,'staged',?,?)`).run(this.id(),this.id(),remote.deliveryRef,remote.id,i.principal,i.recipientJid,remote.kind,remote.deviceId,remote.purpose,this.id(),remote.expiresAt,remote.issuedAt);
    const row = this.find(i.deliveryRef, i.principal);
    if (!row) throw new Error('protected delivery could not be adopted');
    return row;
  }

  /** SQLite IMMEDIATE prevents two in-process or multi-process callers from sending twice. */
  private claim(row: Row): Row {
    const now = this.now(); const at = now.toISOString(); let claim: Row | undefined; let rejected: Error | undefined;
    this.deps.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.deps.db.prepare('SELECT * FROM protected_deliveries WHERE id=?').get(row.id) as Row | undefined;
      if (!current?.delivery_ref || !current.delivery_id) rejected = new Error('protected delivery not found');
      else if (sent(current.state)) claim = current;
      // Checked before expiry and retry limits: those transitions would clear a lease that may still settle.
      else if (hasFreshLease(current, now)) rejected = new Error('protected delivery is already being sent');
      else if (!current.expires_at || new Date(current.expires_at).getTime() <= now.getTime()) { this.expire(current); rejected = new Error('protected delivery is expired'); }
      else if (current.attempt_count >= MAX_ATTEMPTS) { this.fail(current); rejected = new Error('protected delivery retry limit reached'); }
      else if (current.first_attempt_at && new Date(current.first_attempt_at).getTime() + RETRY_WINDOW_MS <= now.getTime()) { this.fail(current); rejected = new Error('protected delivery retry window elapsed'); }
      else if (current.state === 'staging') rejected = new Error('protected delivery is still staging');
      else {
        const token = this.id();
        this.deps.db.prepare(`UPDATE protected_deliveries SET state='resolving',attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,?),last_attempt_at=?,send_claim_token=?,send_claimed_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(at,at,token,at,current.id);
        claim = { ...current, state: 'resolving', attempt_count: current.attempt_count + 1, first_attempt_at: current.first_attempt_at ?? at, send_claim_token: token, send_claimed_at: at };
      }
      this.deps.db.exec('COMMIT');
    } catch (error) { this.deps.db.exec('ROLLBACK'); throw error; }
    if (rejected) throw rejected;
    if (!claim) throw new Error('protected delivery could not be claimed');
    return claim;
  }
  private expire(row: Row): void {
    this.deps.db.prepare(`UPDATE protected_deliveries SET state='expired',send_claim_token=NULL,send_claimed_at=NULL,terminal_at=COALESCE(terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state IN ('staging','staged','resolving','failed','ambiguous')`).run(row.id);
  }
  private expireWithoutFreshLease(row: Row, now: Date): void {
    this.deps.db.prepare(`UPDATE protected_deliveries SET state='expired',send_claim_token=NULL,send_claimed_at=NULL,terminal_at=COALESCE(terminal_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state IN ('staging','staged','resolving','failed','ambiguous') AND ${WITHOUT_FRESH_LEASE}`).run(row.id, leaseCutoff(now));
  }
  private expireOverdueUncertainDeliveries(now: Date): void {
    const nowIso = now.toISOString();
    this.deps.db.prepare(`UPDATE protected_deliveries
      SET state='expired',send_claim_token=NULL,send_claimed_at=NULL,
          terminal_at=COALESCE(terminal_at,?),updated_at=?
      WHERE state IN ('staging','staged','resolving','failed','ambiguous')
        AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?)
        AND ${WITHOUT_FRESH_LEASE}`)
      .run(nowIso, nowIso, nowIso, leaseCutoff(now));
  }
  private fail(row: Row): boolean {
    return this.deps.db.prepare(`UPDATE protected_deliveries SET state='failed',send_claim_token=NULL,send_claimed_at=NULL,terminal_at=CASE WHEN attempt_count>=? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE terminal_at END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state IN ('staging','staged','resolving','failed','ambiguous')`).run(MAX_ATTEMPTS,row.id).changes > 0;
  }
  private ambiguous(row: Row): boolean {
    return this.deps.db.prepare(`UPDATE protected_deliveries SET state='ambiguous',send_claim_token=NULL,send_claimed_at=NULL,terminal_at=CASE WHEN attempt_count>=? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE terminal_at END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state IN ('staging','staged','resolving','failed','ambiguous')`).run(MAX_ATTEMPTS,row.id).changes > 0;
  }
  private event(row: Row, status: DeliveryEventStatus, eventId = row.delivery_ref + ':' + status): void {
    if (!row.delivery_ref) return;
    this.deps.db.prepare('INSERT OR IGNORE INTO protected_delivery_events (event_id,delivery_ref,status,observed_at) VALUES (?,?,?,?)').run(eventId,row.delivery_ref,status,this.nowIso());
  }
  private now(): Date { return this.deps.now?.() ?? new Date(systemClock.now()); }
  private nowIso(): string { return this.now().toISOString(); }
  private id(): string { return this.deps.randomId?.() ?? randomUUID(); }
}

export function countExpiredProtectedDeliveries(db: DatabaseSync): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM protected_deliveries WHERE julianday(issued_at)<julianday('now',?)`).get('-' + PROTECTED_DELIVERY_RETENTION_DAYS + ' days') as { count: number }).count);
}
export function deleteExpiredProtectedDeliveries(db: DatabaseSync): number {
  const cutoff = '-' + PROTECTED_DELIVERY_RETENTION_DAYS + ' days';
  db.prepare(`DELETE FROM protected_delivery_events WHERE delivery_ref IN (SELECT delivery_ref FROM protected_deliveries WHERE julianday(issued_at)<julianday('now',?))`).run(cutoff);
  return Number(db.prepare(`DELETE FROM protected_deliveries WHERE julianday(issued_at)<julianday('now',?)`).run(cutoff).changes);
}
function validStatus(v: ManagedDeliveryStatus, ref: string, id?: string): void {
  if (v.deliveryRef !== ref || !opaqueId(v.deliveryRef) || !opaqueId(v.id) || (id !== undefined && v.id !== id) || !instant(v.expiresAt) || !instant(v.issuedAt) || !grantState(v.state) || !deliveryStatus(v.deliveryStatus) || (v.kind !== 'secret' && v.kind !== 'rustdesk') || (v.kind === 'secret' && (v.deviceId !== null || v.purpose !== null)) || (v.kind === 'rustdesk' && (!text(v.deviceId ?? '') || (v.purpose !== 'login' && v.purpose !== 'recovery')))) throw new Error('invalid status');
}
function text(v: string): boolean { return typeof v === 'string' && v.length > 0; }
function opaqueId(v: string): boolean { return typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v); }
function instant(v: string): boolean { return Number.isFinite(new Date(v).getTime()); }
function sent(v: ProtectedDeliveryState): v is 'submitted' | 'delivered' | 'read' { return v === 'submitted' || v === 'delivered' || v === 'read'; }
function publicRow(row: Row): { deliveryRef: string; id: string; state: string } { return { deliveryRef: row.delivery_ref!, id: row.delivery_id!, state: row.state }; }
function grantState(value: string): boolean { return value === 'unclaimed' || value === 'claimed' || value === 'revoked' || value === 'expired' || value === 'done' || value === 'replaced'; }
function deliveryStatus(value: string): boolean { return value === 'staged' || value === 'submitted' || value === 'delivered' || value === 'read' || value === 'ambiguous' || value === 'failed'; }
function projectDeliveryStatus(local: ProtectedDeliveryState, remote: string): string {
  const ranks: Record<string, number> = { staging: 0, staged: 1, resolving: 2, submitted: 3, ambiguous: 3, failed: 3, delivered: 4, read: 5, expired: 0 };
  return (ranks[local] ?? 0) >= (ranks[remote] ?? 0) ? local : remote;
}
