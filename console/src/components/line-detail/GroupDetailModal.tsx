import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Copy, Link, LogOut, UserMinus, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { useToast } from '../../hooks/toast-context.js'
import ConfirmDialog from '../ConfirmDialog.js'
import EmptyState from '../EmptyState.js'
import { ContactSearchPicker } from '../shared/ContactSearchPicker.js'
import { SearchInput } from '../shared/SearchInput.js'
import {
  roleLabel,
  roleBadgeStyle,
  avatarColor,
  EPHEMERAL_OPTIONS,
  ephemeralLabel,
} from './groups-utils.js'
import { getInitials, capitalize } from '../../lib/text-utils.js'
import type { GroupInfo, GroupDetail, GroupParticipant } from '../../types.js'

type TabId = 'info' | 'participants' | 'settings'

interface GroupDetailModalProps {
  open: boolean
  group: GroupInfo | null
  lineName: string
  myJid?: string
  onClose: () => void
}

const metaLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-xs)',
  minWidth: 'calc(var(--sp-10) * 2)',
}

// ── Info Tab ──────────────────────────────────────────────────────────────────

function InfoTab({
  detail,
  lineName,
  isAdmin,
  onRefresh,
}: {
  detail: GroupDetail
  lineName: string
  isAdmin: boolean
  onRefresh: () => void
}) {
  const toast = useToast()
  const [subject, setSubject] = useState(detail.subject)
  const [desc, setDesc] = useState(detail.desc ?? '')
  const [inviteLink, setInviteLink] = useState(detail.inviteLink ?? '')
  const [loadingLink, setLoadingLink] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  useEffect(() => {
    setSubject(detail.subject)
    setDesc(detail.desc ?? '')
    setInviteLink(detail.inviteLink ?? '')
  }, [detail])

  const handleSubjectSave = useCallback(async () => {
    if (subject.trim() === detail.subject) return
    try {
      await api.updateGroupSubject(lineName, detail.id, subject.trim())
      toast.success('Group subject updated')
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
      setSubject(detail.subject)
    }
  }, [subject, detail, lineName, toast, onRefresh])

  const handleDescSave = useCallback(async () => {
    if (desc === (detail.desc ?? '')) return
    try {
      await api.updateGroupDescription(lineName, detail.id, desc || undefined)
      toast.success('Description updated')
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
      setDesc(detail.desc ?? '')
    }
  }, [desc, detail, lineName, toast, onRefresh])

  const handleFetchInviteLink = async () => {
    setLoadingLink(true)
    try {
      const res = await api.getGroupInviteLink(lineName, detail.id)
      setInviteLink(res.inviteLink)
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setLoadingLink(false)
    }
  }

  const handleCopyLink = () => {
    if (!inviteLink) return
    navigator.clipboard.writeText(inviteLink).then(() => toast.success('Invite link copied'))
  }

  const handleRevoke = async () => {
    try {
      await api.revokeGroupInvite(lineName, detail.id)
      toast.success('Invite link revoked')
      setInviteLink('')
      onRefresh()
    } catch (e) {
      toast.error(`Revoke failed: ${(e as Error).message}`)
    } finally {
      setConfirmRevoke(false)
    }
  }

  const createdDate = detail.creation
    ? new Date(detail.creation * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null

  const owner = detail.participants.find(p => p.admin === 'superadmin')

  return (
    <div className="flex flex-col gap-[var(--sp-4)] py-[var(--sp-4)] px-[var(--sp-5)]">

      {/* Subject */}
      <div>
        <label className="c-field-label">
          Subject
        </label>
        {isAdmin ? (
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            onBlur={handleSubjectSave}
            className="c-input font-mono text-t2"
          />
        ) : (
          <div className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{detail.subject}</div>
        )}
      </div>

      {/* Description */}
      <div>
        <label className="c-field-label">
          Description
        </label>
        {isAdmin ? (
          <textarea
            value={desc}
            onChange={e => setDesc(e.target.value)}
            onBlur={handleDescSave}
            rows={3}
            placeholder="Group description..."
            className="c-input font-mono text-t2 resize-vertical min-h-[var(--sp-16,calc(var(--sp-12)+var(--sp-6)))]"
            style={{ height: 'auto' }}
          />
        ) : (
          <div className="font-mono text-t3" style={{ fontSize: 'var(--font-size-data)' }}>
            {detail.desc || <span className="text-t4">No description</span>}
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="flex flex-col gap-[var(--sp-2)]">
        {createdDate && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-t4" style={metaLabelStyle}>Created</span>
            <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{createdDate}</span>
          </div>
        )}
        {owner && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-t4" style={metaLabelStyle}>Owner</span>
            <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{owner.id}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="font-mono text-t4" style={metaLabelStyle}>Group JID</span>
          <span className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs) ' }}>{detail.id}</span>
        </div>
      </div>

      {/* Invite link */}
      <div>
        <label className="c-field-label">
          Invite link
        </label>
        {inviteLink ? (
          <div className="flex flex-col gap-[var(--sp-2)]">
            <div
              className="font-mono text-t3 truncate py-[var(--sp-2)] px-[var(--sp-3)] bg-d1 rounded-md [border:var(--bw)_solid_var(--b1)]"
              style={{
                fontSize: 'var(--font-size-xs)',
              }}
            >
              {inviteLink}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCopyLink}
                className="c-btn c-btn-xs c-btn-ghost font-mono"
              >
                <Copy size={11} /> Copy
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setConfirmRevoke(true)}
                  className="c-btn c-btn-xs c-btn-danger font-mono"
                >
                  <X size={11} /> Revoke
                </button>
              )}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleFetchInviteLink}
            disabled={loadingLink}
            className="c-btn c-btn-xs c-btn-ghost font-mono"
          >
            <Link size={11} /> {loadingLink ? 'Fetching...' : 'Fetch invite link'}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke invite link?"
        confirmLabel="Revoke"
        confirmVariant="danger"
        onConfirm={handleRevoke}
        onCancel={() => setConfirmRevoke(false)}
      >
        This will invalidate the current invite link. A new link can be generated afterwards.
      </ConfirmDialog>
    </div>
  )
}

// ── Participants Tab ──────────────────────────────────────────────────────────

function ParticipantsTab({
  detail,
  lineName,
  isAdmin,
  myJid,
  onRefresh,
}: {
  detail: GroupDetail
  lineName: string
  isAdmin: boolean
  myJid?: string
  onRefresh: () => void
}) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<GroupParticipant | null>(null)
  const [addContacts, setAddContacts] = useState<{ jid: string; name?: string; notify?: string; number?: string }[]>([])
  const [adding, setAdding] = useState(false)

  const filtered = detail.participants.filter(p =>
    search ? p.id.toLowerCase().includes(search.toLowerCase()) : true
  )

  const handleRemove = async () => {
    if (!confirmRemove) return
    try {
      await api.updateGroupParticipants(lineName, detail.id, [confirmRemove.id], 'remove')
      toast.success(`Removed ${confirmRemove.id}`)
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setConfirmRemove(null)
    }
  }

  const handleToggleAdmin = async (p: GroupParticipant) => {
    const action = p.admin ? 'demote' : 'promote'
    try {
      await api.updateGroupParticipants(lineName, detail.id, [p.id], action)
      toast.success(`${action === 'promote' ? 'Promoted' : 'Demoted'} ${p.id}`)
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    }
  }

  const handleAdd = async () => {
    if (addContacts.length === 0) return
    setAdding(true)
    try {
      await api.updateGroupParticipants(lineName, detail.id, addContacts.map(c => c.jid), 'add')
      toast.success(`Added ${addContacts.length} participant${addContacts.length !== 1 ? 's' : ''}`)
      setAddContacts([])
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setAdding(false)
    }
  }

  const pendingRequests = detail.pendingRequests ?? []

  const handleRequestAction = async (jid: string, action: 'add' | 'remove') => {
    try {
      await api.updateGroupParticipants(lineName, detail.id, [jid], action)
      toast.success(action === 'add' ? `Approved ${jid}` : `Rejected ${jid}`)
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--sp-3)] py-[var(--sp-4)] px-[var(--sp-5)]">

      {/* Add participants (admin only) */}
      {isAdmin && (
        <div>
          <label className="c-field-label">
            Add participants
          </label>
          <ContactSearchPicker
            lineName={lineName}
            selected={addContacts}
            onAdd={c => setAddContacts(prev => [...prev, c])}
            onRemove={jid => setAddContacts(prev => prev.filter(c => c.jid !== jid))}
            placeholder="Search contacts to add..."
          />
          {addContacts.length > 0 && (
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding}
              className="c-btn c-btn-xs c-btn-primary font-mono mt-[var(--sp-2)]"
            >
              <UserPlus size={11} /> {adding ? 'Adding...' : `Add ${addContacts.length}`}
            </button>
          )}
        </div>
      )}

      {/* Pending requests (admin only) */}
      {isAdmin && pendingRequests.length > 0 && (
        <div>
          <div className="font-mono text-t4 c-col-header mb-[var(--sp-2)]" style={{ fontSize: 'var(--font-size-xs)' }}>
            Join requests ({pendingRequests.length})
          </div>
          <div className="flex flex-col gap-[var(--sp-1)]">
            {pendingRequests.map(req => (
              <div key={req.jid} className="flex items-center gap-2 py-[var(--sp-2)] px-[var(--sp-3)] bg-[var(--s-warn-wash)] rounded-md">
                <span className="font-mono text-t2 flex-1 truncate" style={{ fontSize: 'var(--font-size-data)' }}>{req.jid}</span>
                <button
                  type="button"
                  onClick={() => handleRequestAction(req.jid, 'add')}
                  className="c-btn c-btn-xs c-btn-primary font-mono"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => handleRequestAction(req.jid, 'remove')}
                  className="c-btn c-btn-xs c-btn-danger font-mono"
                >
                  Reject
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <SearchInput
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={`Search ${detail.participants.length} participants...`}
        aria-label={`Search ${detail.participants.length} participants`}
      />

      {/* Participant list */}
      <div className="flex flex-col gap-[var(--sp-1)]">
        {filtered.map(p => {
          const badge = roleBadgeStyle(p.admin)
          const myPhoneNum = myJid?.split('@')[0]
          const isMe = myJid ? (p.id === myJid || (myPhoneNum ? p.id.split('@')[0] === myPhoneNum : false)) : false
          return (
            <div
              key={p.id}
              className="flex items-center gap-2 py-[var(--sp-2)] px-[var(--sp-3)] rounded-md"
            >
              <span className="font-mono text-t2 flex-1 truncate" style={{ fontSize: 'var(--font-size-data)' }}>
                {p.id}
                {isMe && <span className="text-t4 ml-[var(--sp-1)]">(you)</span>}
              </span>
              {badge && (
                <span
                  className="font-mono flex-shrink-0 py-[var(--bw)] px-[var(--sp-1)] rounded-sm"
                  style={{
                    fontSize: 'var(--font-size-xs)',
                    background: badge.bg,
                    color: badge.color,
                  }}
                >
                  {roleLabel(p.admin)}
                </span>
              )}
              {isAdmin && !isMe && (
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleToggleAdmin(p)}
                    className="c-btn c-btn-xs c-btn-ghost font-mono"
                    title={p.admin ? 'Demote' : 'Promote to admin'}
                  >
                    {p.admin ? <ShieldOff size={11} /> : <ShieldCheck size={11} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(p)}
                    className="c-btn c-btn-xs c-btn-danger font-mono"
                    title="Remove participant"
                  >
                    <UserMinus size={11} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={!!confirmRemove}
        title={`Remove ${confirmRemove?.id ?? ''}?`}
        confirmLabel="Remove"
        confirmVariant="danger"
        confirmIcon={<UserMinus size={14} />}
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(null)}
      >
        This will remove <strong>{confirmRemove?.id}</strong> from the group.
      </ConfirmDialog>
    </div>
  )
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

function SettingsTab({
  detail,
  lineName,
  isAdmin,
  onRefresh,
  onClose,
}: {
  detail: GroupDetail
  lineName: string
  isAdmin: boolean
  onRefresh: () => void
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)

  const handleSetting = async (setting: string, key: string) => {
    setSaving(key)
    try {
      await api.updateGroupSettings(lineName, detail.id, setting)
      toast.success('Setting updated')
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setSaving(null)
    }
  }

  const handleEphemeral = async (seconds: number) => {
    setSaving('ephemeral')
    try {
      await api.updateGroupEphemeral(lineName, detail.id, seconds)
      toast.success('Disappearing messages updated')
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setSaving(null)
    }
  }

  const handleMemberAddMode = async (mode: 'all_member_add' | 'admin_add') => {
    setSaving('memberAddMode')
    try {
      await api.updateGroupMemberAddMode(lineName, detail.id, mode)
      toast.success('Member add mode updated')
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setSaving(null)
    }
  }

  const handleJoinApproval = async (mode: 'on' | 'off') => {
    setSaving('joinApproval')
    try {
      await api.updateGroupJoinApproval(lineName, detail.id, mode)
      toast.success('Join approval updated')
      onRefresh()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setSaving(null)
    }
  }

  const handleLeave = async () => {
    try {
      await api.leaveGroup(lineName, detail.id)
      toast.success('Left group')
      queryClient.invalidateQueries({ queryKey: ['groups', lineName] })
      onClose()
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`)
    } finally {
      setConfirmLeave(false)
    }
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-3) 0',
    borderBottomWidth: 'var(--bw)',
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--b1)',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-data)',
  }

  return (
    <div className="flex flex-col py-[var(--sp-4)] px-[var(--sp-5)] gap-[var(--sp-1)]">

      {/* Messaging — announce */}
      <div style={rowStyle}>
        <div>
          <div className="font-mono text-t2" style={labelStyle}>Messaging</div>
          <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
            {detail.announce ? 'Only admins can send' : 'All participants can send'}
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-1">
            <button
              type="button"
              disabled={saving === 'announce'}
              onClick={() => handleSetting('not_announcement', 'announce')}
              className={`c-btn c-btn-xs font-mono ${!detail.announce ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              All
            </button>
            <button
              type="button"
              disabled={saving === 'announce'}
              onClick={() => handleSetting('announcement', 'announce')}
              className={`c-btn c-btn-xs font-mono ${detail.announce ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              Admins only
            </button>
          </div>
        )}
      </div>

      {/* Edit info — locked */}
      <div style={rowStyle}>
        <div>
          <div className="font-mono text-t2" style={labelStyle}>Edit group info</div>
          <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
            {detail.locked ? 'Only admins can edit info' : 'All participants can edit info'}
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-1">
            <button
              type="button"
              disabled={saving === 'locked'}
              onClick={() => handleSetting('unlocked', 'locked')}
              className={`c-btn c-btn-xs font-mono ${!detail.locked ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              All
            </button>
            <button
              type="button"
              disabled={saving === 'locked'}
              onClick={() => handleSetting('locked', 'locked')}
              className={`c-btn c-btn-xs font-mono ${detail.locked ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              Admins only
            </button>
          </div>
        )}
      </div>

      {/* Member add mode */}
      {isAdmin && (
        <div style={rowStyle}>
          <div>
            <div className="font-mono text-t2" style={labelStyle}>Who can add members</div>
            <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
              {detail.memberAddMode === 'admin_add' ? 'Admins only' : 'All members'}
            </div>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={saving === 'memberAddMode'}
              onClick={() => handleMemberAddMode('all_member_add')}
              className={`c-btn c-btn-xs font-mono ${detail.memberAddMode !== 'admin_add' ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              All
            </button>
            <button
              type="button"
              disabled={saving === 'memberAddMode'}
              onClick={() => handleMemberAddMode('admin_add')}
              className={`c-btn c-btn-xs font-mono ${detail.memberAddMode === 'admin_add' ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              Admins only
            </button>
          </div>
        </div>
      )}

      {/* Join approval */}
      {isAdmin && (
        <div style={rowStyle}>
          <div>
            <div className="font-mono text-t2" style={labelStyle}>Join approval</div>
            <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
              {detail.joinApprovalMode === 'on' ? 'Admin approval required' : 'No approval required'}
            </div>
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={saving === 'joinApproval'}
              onClick={() => handleJoinApproval('off')}
              className={`c-btn c-btn-xs font-mono ${detail.joinApprovalMode !== 'on' ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              Off
            </button>
            <button
              type="button"
              disabled={saving === 'joinApproval'}
              onClick={() => handleJoinApproval('on')}
              className={`c-btn c-btn-xs font-mono ${detail.joinApprovalMode === 'on' ? 'c-btn-primary' : 'c-btn-ghost'}`}
            >
              On
            </button>
          </div>
        </div>
      )}

      {/* Disappearing messages */}
      <div style={rowStyle}>
        <div>
          <div className="font-mono text-t2" style={labelStyle}>Disappearing messages</div>
          <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
            {ephemeralLabel(detail.ephemeralDuration)}
          </div>
        </div>
        {isAdmin && (
          <select
            value={detail.ephemeralDuration ?? 0}
            disabled={saving === 'ephemeral'}
            onChange={e => handleEphemeral(Number(e.target.value))}
            className="font-mono text-t2 c-btn c-btn-xs c-btn-ghost bg-d1"
          >
            {EPHEMERAL_OPTIONS.map(opt => (
              <option key={opt.seconds} value={opt.seconds}>{opt.label}</option>
            ))}
          </select>
        )}
      </div>

      {/* Leave group */}
      <div className="mt-[var(--sp-4)]">
        <button
          type="button"
          onClick={() => setConfirmLeave(true)}
          className="c-btn c-btn-danger font-mono"
          style={{ fontSize: 'var(--font-size-data)' }}
        >
          <LogOut size={14} /> Leave group
        </button>
      </div>

      <ConfirmDialog
        open={confirmLeave}
        title="Leave group?"
        confirmLabel="Leave"
        confirmVariant="danger"
        confirmIcon={<LogOut size={14} />}
        onConfirm={handleLeave}
        onCancel={() => setConfirmLeave(false)}
      >
        You will leave <strong>{detail.subject}</strong> and lose access to its messages.
      </ConfirmDialog>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function GroupDetailModal({ open, group, lineName, myJid, onClose }: GroupDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('info')
  const prevGroupId = useRef<string | undefined>(undefined)

  const { data: detail, isLoading, error, refetch } = useQuery({
    queryKey: ['group-detail', lineName, group?.id],
    queryFn: () => api.getGroupDetail(lineName, group!.id),
    enabled: open && !!group,
    staleTime: 30_000,
  })

  // Escape key handler
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Reset tab when group changes — render-time derivation avoids setState-in-effect
  if (group?.id !== prevGroupId.current) {
    prevGroupId.current = group?.id
    if (activeTab !== 'info') setActiveTab('info')
  }

  if (!open || !group) return null

  // Determine admin status — use detail if available, fall back to group from list
  const source = detail ?? group
  const myPhone = myJid?.split('@')[0]
  const myParticipant = myJid
    ? source.participants.find(p => p.id === myJid || (myPhone && p.id.split('@')[0] === myPhone))
    : undefined
  const isAdmin = !!myParticipant?.admin

  const color = avatarColor(group.id)
  const initials = getInitials(group.subject)

  return (
    <div className="c-dialog-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-detail-dialog-title"
        className="c-dialog flex flex-col w-[var(--panel-wizard)] max-w-[var(--panel-max-inline)]"
        style={{
          maxHeight: 'var(--modal-max-h)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="c-dialog-header gap-3 flex-shrink-0">
        <div
          className="flex-shrink-0 flex items-center justify-center font-sans font-semibold w-[var(--avatar-sm)] h-[var(--avatar-sm)] rounded-full text-t1"
          style={{ background: color, fontSize: 'var(--font-size-data)' }}
        >
          {initials}
        </div>
          <div className="flex-1 min-w-0">
            <div id="group-detail-dialog-title" className="font-sans font-semibold truncate" style={{ fontSize: 'var(--font-size-lg)' }}>
              {group.subject}
            </div>
            <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
              {group.participants.length} participant{group.participants.length !== 1 ? 's' : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="c-btn c-btn-ghost c-btn-sm flex-shrink-0">
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Tab bar */}
        <div
          className="flex gap-1 flex-shrink-0 py-[var(--sp-2)] px-[var(--sp-4)] c-border-b"
          role="tablist"
        >
          {(['info', 'participants', 'settings'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              role="tab"
              onClick={() => setActiveTab(tab)}
              className="c-tab"
              aria-selected={activeTab === tab}
            >
              {capitalize(tab)}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <EmptyState title="Loading group details..." description="Fetching from MCP socket." />
          )}
          {error && (
            <EmptyState
              variant="error"
              title="Failed to load group"
              description={(error as Error).message}
              onRetry={() => refetch()}
            />
          )}
          {detail && activeTab === 'info' && (
            <InfoTab
              detail={detail}
              lineName={lineName}
              isAdmin={isAdmin}
              onRefresh={() => refetch()}
            />
          )}
          {detail && activeTab === 'participants' && (
            <ParticipantsTab
              detail={detail}
              lineName={lineName}
              isAdmin={isAdmin}
              myJid={myJid}
              onRefresh={() => refetch()}
            />
          )}
          {detail && activeTab === 'settings' && (
            <SettingsTab
              detail={detail}
              lineName={lineName}
              isAdmin={isAdmin}
              onRefresh={() => refetch()}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  )
}
