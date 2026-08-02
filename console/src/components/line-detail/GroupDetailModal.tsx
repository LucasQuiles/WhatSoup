/**
 * GroupDetailModal — migrated to Modal primitive (B3 wave-3).
 *
 * Migration:
 *   - Removes ad-hoc backdrop div, stopPropagation, and bubble-phase Escape effect
 *     (the console's LAST hand-rolled document.addEventListener('keydown', …) Escape
 *     copy outside hooks/primitives — both UpdateModal's and this one die in wave 3).
 *   - dismissable=false: scrim click was silently discarding unsaved InfoTab edits
 *     (subject, desc) and any in-progress participant selection. modal.md protective
 *     default applied. Escape and X remain available for explicit cancel.
 *   - Shell: Modal size="lg" (720px exact match to --panel-wizard, tokens-v3 §6.12);
 *     labelledById="group-detail-dialog-title" wires the custom header title element
 *     to aria-labelledby without ceding control to ModalHeader (C-B3W3-4).
 *   - Header: custom direct shell child with className="soup-modal-header"; avatar
 *     KEPT (identity-bearing content, not decoration); subject span retains id
 *     "group-detail-dialog-title" and adopts soup-modal-title; X → ActionButton
 *     label="Close dialog".
 *   - Hand-rolled tablist → Tabs primitive (roving tabindex, Arrow/Home/End, MANUAL
 *     activation). Tab ids unchanged: info/participants/settings. aria contract wired.
 *   - Four settings binary toggle pairs → ToolbarTimeRange segs with disabled prop
 *     (C-B3W3-2): announce (Messaging), locked (Edit group info), memberAddMode
 *     (Who can add members), joinApproval (Join approval). Preserves double-fire
 *     protection from disabled={saving === key}.
 *   - Per-tab padding wrappers die; ModalBody provides padding (wave-2 pattern).
 *   - `if (!group) return null` guard STAYS; Modal owns the open gate.
 *   - Token deletions: --panel-max-inline retired (last consumer gone; verified).
 *   - GAINS: stacking-aware Escape, pointerdown outside-click semantics, focus trap,
 *     focus restoration, keyboard tablist contract.
 *   - Public prop interface, tab-reset derivation, query, admin resolution, API
 *     handlers, toasts, nested ConfirmDialogs unchanged.
 */
import { useState, useEffect, useCallback, useId } from 'react'
import { X, Copy, Link, LogOut, UserMinus, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { formatLongDate } from '../../lib/format-time'
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
import { Modal, ModalBody, SelectInput, TextArea, TextInput } from '../primitives'
import { Button } from '../primitives/Button'
import { ActionButton } from '../primitives/ActionButton'
import { Tabs, Tab } from '../primitives/Tabs'
import { ToolbarTimeRange } from '../primitives/Toolbar'

type TabId = 'info' | 'participants' | 'settings'

interface GroupDetailModalProps {
  open: boolean
  group: GroupInfo | null
  lineName: string
  myJid?: string
  onClose: () => void
}

const metaLabelStyle: React.CSSProperties = {
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
  const subjectInputId = useId()
  const descriptionInputId = useId()

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
    if (!navigator.clipboard) {
      toast.error('Clipboard unavailable (insecure context)')
      return
    }
    navigator.clipboard.writeText(inviteLink)
      .then(() => toast.success('Invite link copied'))
      .catch(() => toast.error('Failed to copy invite link'))
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
    ? formatLongDate(detail.creation)
    : null

  const owner = detail.participants.find(p => p.admin === 'superadmin')

  return (
    <div className="flex flex-col gap-[var(--sp-4)]">

      {/* Subject */}
      <div>
        <label htmlFor={isAdmin ? subjectInputId : undefined} className="c-field-label">
          Subject
        </label>
        {isAdmin ? (
          <TextInput
            id={subjectInputId}
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            onBlur={handleSubjectSave}
            className="text-text-2"
          />
        ) : (
          <div className="c-body">{detail.subject}</div>
        )}
      </div>

      {/* Description */}
      <div>
        <label htmlFor={isAdmin ? descriptionInputId : undefined} className="c-field-label">
          Description
        </label>
        {isAdmin ? (
          <TextArea
            id={descriptionInputId}
            value={desc}
            onChange={e => setDesc(e.target.value)}
            onBlur={handleDescSave}
            rows={3}
            placeholder="Group description..."
            minHeight={72}
            className="text-text-2 h-auto"
          />
        ) : (
          <div className="c-body text-text-2">
            {detail.desc || <span className="text-text-2">No description</span>}
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="flex flex-col gap-[var(--sp-2)]">
        {createdDate && (
          <div className="flex items-center gap-2">
            <span className="c-label" style={metaLabelStyle}>Created</span>
            <span className="c-data">{createdDate}</span>
          </div>
        )}
        {owner && (
          <div className="flex items-center gap-2">
            <span className="c-label" style={metaLabelStyle}>Owner</span>
            <span className="c-data">{owner.id}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="c-label" style={metaLabelStyle}>Group JID</span>
          <span className="c-data text-text-2">{detail.id}</span>
        </div>
      </div>

      {/* Invite link */}
      <div>
        <span className="c-field-label">
          Invite link
        </span>
        {inviteLink ? (
          <div className="flex flex-col gap-[var(--sp-2)]">
            <div
              title={inviteLink}
              className="c-data text-text-2 truncate py-[var(--sp-2)] px-[var(--sp-3)] bg-surface-inset rounded-md [border:var(--bw)_solid_var(--border-hairline)]"
            >
              {inviteLink}
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyLink}
                className="font-mono"
                icon={<Copy size={15} strokeWidth={1.75} />}
              >
                Copy
              </Button>
              {isAdmin && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmRevoke(true)}
                  className="font-mono"
                  icon={<X size={15} strokeWidth={1.75} />}
                >
                  Revoke
                </Button>
              )}
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleFetchInviteLink}
            disabled={loadingLink}
            className="font-mono"
            icon={<Link size={15} strokeWidth={1.75} />}
          >
            {loadingLink ? 'Fetching...' : 'Fetch invite link'}
          </Button>
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
    <div className="flex flex-col gap-[var(--sp-3)]">

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
            <Button
              variant="primary"
              size="sm"
              onClick={handleAdd}
              disabled={adding}
              className="font-mono mt-[var(--sp-2)]"
              icon={<UserPlus size={15} strokeWidth={1.75} />}
            >
              {adding ? 'Adding...' : `Add ${addContacts.length}`}
            </Button>
          )}
        </div>
      )}

      {/* Pending requests (admin only) */}
      {isAdmin && pendingRequests.length > 0 && (
        <div>
          <div className="font-mono text-text-2 c-col-header mb-[var(--sp-2)]">
            Join requests ({pendingRequests.length})
          </div>
          <div className="flex flex-col gap-[var(--sp-1)]">
            {pendingRequests.map(req => (
              <div key={req.jid} className="flex items-center gap-2 py-[var(--sp-2)] px-[var(--sp-3)] bg-[var(--s-warn-wash)] rounded-md">
                <span title={req.jid} className="c-data flex-1 truncate">{req.jid}</span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleRequestAction(req.jid, 'add')}
                  className="font-mono"
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleRequestAction(req.jid, 'remove')}
                  className="font-mono"
                >
                  Reject
                </Button>
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
              <span title={p.id} className="c-data flex-1 truncate">
                {p.id}
                {isMe && <span className="text-text-2 ml-[var(--sp-1)]">(you)</span>}
              </span>
              {badge && (
                <span
                  className="c-meta flex-shrink-0 py-[var(--bw)] px-[var(--sp-1)] rounded-sm"
                  style={{
                    background: badge.bg,
                    color: badge.color,
                  }}
                >
                  {roleLabel(p.admin)}
                </span>
              )}
              {isAdmin && !isMe && (
                <div className="flex gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggleAdmin(p)}
                    className="font-mono"
                    title={p.admin ? 'Demote' : 'Promote to admin'}
                    aria-label={p.admin ? 'Demote' : 'Promote to admin'}
                    icon={p.admin ? <ShieldOff size={15} strokeWidth={1.75} /> : <ShieldCheck size={15} strokeWidth={1.75} />}
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmRemove(p)}
                    className="font-mono"
                    title="Remove participant"
                    aria-label="Remove participant"
                    icon={<UserMinus size={15} strokeWidth={1.75} />}
                  />
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

const ANNOUNCE_OPTIONS = [
  { label: 'All', value: 'not_announcement' },
  { label: 'Admins only', value: 'announcement' },
]

const LOCKED_OPTIONS = [
  { label: 'All', value: 'unlocked' },
  { label: 'Admins only', value: 'locked' },
]

const MEMBER_ADD_OPTIONS = [
  { label: 'All', value: 'all_member_add' },
  { label: 'Admins only', value: 'admin_add' },
]

const JOIN_APPROVAL_OPTIONS = [
  { label: 'Off', value: 'off' },
  { label: 'On', value: 'on' },
]

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
  const ephemeralSelectId = useId()

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
    borderBottomColor: 'var(--border-hairline)',
  }

  return (
    <div className="flex flex-col gap-[var(--sp-1)]">

      {/* Messaging — announce (DD-15 closure) */}
      <div style={rowStyle}>
        <div>
          <div className="c-body">Messaging</div>
          <div className="c-body text-text-2">
            {detail.announce ? 'Only admins can send' : 'All participants can send'}
          </div>
        </div>
        {isAdmin && (
          <ToolbarTimeRange
            label="Messaging"
            options={ANNOUNCE_OPTIONS}
            value={detail.announce ? 'announcement' : 'not_announcement'}
            disabled={saving === 'announce'}
            onChange={(v) => handleSetting(v, 'announce')}
          />
        )}
      </div>

      {/* Edit info — locked (DD-15 closure) */}
      <div style={rowStyle}>
        <div>
          <div className="c-body">Edit group info</div>
          <div className="c-body text-text-2">
            {detail.locked ? 'Only admins can edit info' : 'All participants can edit info'}
          </div>
        </div>
        {isAdmin && (
          <ToolbarTimeRange
            label="Edit group info"
            options={LOCKED_OPTIONS}
            value={detail.locked ? 'locked' : 'unlocked'}
            disabled={saving === 'locked'}
            onChange={(v) => handleSetting(v, 'locked')}
          />
        )}
      </div>

      {/* Member add mode (DD-15 closure) */}
      {isAdmin && (
        <div style={rowStyle}>
          <div>
            <div className="c-body">Who can add members</div>
            <div className="c-body text-text-2">
              {detail.memberAddMode === 'admin_add' ? 'Admins only' : 'All members'}
            </div>
          </div>
          <ToolbarTimeRange
            label="Who can add members"
            options={MEMBER_ADD_OPTIONS}
            value={detail.memberAddMode ?? 'all_member_add'}
            disabled={saving === 'memberAddMode'}
            onChange={(v) => handleMemberAddMode(v as 'all_member_add' | 'admin_add')}
          />
        </div>
      )}

      {/* Join approval (DD-15 closure) */}
      {isAdmin && (
        <div style={rowStyle}>
          <div>
            <div className="c-body">Join approval</div>
            <div className="c-body text-text-2">
              {detail.joinApprovalMode === 'on' ? 'Admin approval required' : 'No approval required'}
            </div>
          </div>
          <ToolbarTimeRange
            label="Join approval"
            options={JOIN_APPROVAL_OPTIONS}
            value={detail.joinApprovalMode ?? 'off'}
            disabled={saving === 'joinApproval'}
            onChange={(v) => handleJoinApproval(v as 'on' | 'off')}
          />
        </div>
      )}

      {/* Disappearing messages */}
      <div style={rowStyle}>
        <div>
          <label htmlFor={isAdmin ? ephemeralSelectId : undefined} className="c-body">Disappearing messages</label>
          <div className="c-body text-text-2">
            {ephemeralLabel(detail.ephemeralDuration)}
          </div>
        </div>
        {isAdmin && (
          <SelectInput
            id={ephemeralSelectId}
            value={detail.ephemeralDuration ?? 0}
            disabled={saving === 'ephemeral'}
            onChange={e => handleEphemeral(Number(e.target.value))}
            className="font-mono text-text-2 bg-surface-inset max-w-[var(--input-number-w)] shrink-0"
          >
            {EPHEMERAL_OPTIONS.map(opt => (
              <option key={opt.seconds} value={opt.seconds}>{opt.label}</option>
            ))}
          </SelectInput>
        )}
      </div>

      {/* Leave group */}
      <div className="mt-[var(--sp-4)]">
        <Button
          variant="danger"
          onClick={() => setConfirmLeave(true)}
          className="font-mono"
          icon={<LogOut size={14} />}
        >
          Leave group
        </Button>
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
  const groupId = group?.id
  const [tabState, setTabState] = useState<{ groupId?: string; activeTab: TabId }>({
    groupId: undefined,
    activeTab: 'info',
  })
  const activeTab = tabState.groupId === groupId ? tabState.activeTab : 'info'
  const handleTabChange = useCallback((id: string) => {
    setTabState({ groupId, activeTab: id as TabId })
  }, [groupId])

  const { data: detail, isLoading, error, refetch } = useQuery({
    queryKey: ['group-detail', lineName, groupId],
    queryFn: () => api.getGroupDetail(lineName, group!.id),
    enabled: open && !!group,
    staleTime: 30_000,
  })

  // `if (!group) return null` guard stays — header/body cannot render without group.
  // Modal owns the open gate (the `open` half of the legacy guard dies).
  if (!group) return null

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
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      dismissable={false}
      labelledById="group-detail-dialog-title"
    >
      {/* Custom header region — avatar (identity-bearing, kept) + two-line title block
          + close X. Direct shell child with soup-modal-header class, title wired via
          labelledById (C-B3W3-4). */}
      <div className="soup-modal-header gap-3 shrink-0">
        <div
          className="shrink-0 flex items-center justify-center font-sans font-semibold w-[var(--avatar-sm)] h-[var(--avatar-sm)] rounded-full text-[var(--avatar-ink)] text-sm"
          style={{ background: color }}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div id="group-detail-dialog-title" title={group.subject} className="soup-modal-title truncate">
            {group.subject}
          </div>
          <div className="c-label">
            {group.participants.length} participant{group.participants.length !== 1 ? 's' : ''}
          </div>
        </div>
        <ActionButton
          label="Close dialog"
          icon={<X size={18} strokeWidth={1.75} />}
          onClick={onClose}
          className="shrink-0"
        />
      </div>

      {/* Tab strip — direct shell child between header and body (C-B3W3-4, wave-2
          fourth-region precedent). Tabs primitive: roving tabindex, Arrow/Home/End,
          MANUAL activation. Tab ids unchanged: info/participants/settings. */}
      <Tabs
        label="Group detail sections"
        value={activeTab}
        onChange={handleTabChange}
        inset
      >
        <Tab id="info">{capitalize('info')}</Tab>
        <Tab id="participants">{capitalize('participants')}</Tab>
        <Tab id="settings">{capitalize('settings')}</Tab>
      </Tabs>

      {/* Body — conditional-mount pattern (Tabs header 11-13 sanctions it).
          Per-tab padding wrappers die; ModalBody provides padding (wave-2 pattern). */}
      <ModalBody>
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
          <div role="tabpanel" id="tabpanel-info" aria-labelledby="tab-info">
            <InfoTab
              detail={detail}
              lineName={lineName}
              isAdmin={isAdmin}
              onRefresh={() => refetch()}
            />
          </div>
        )}
        {detail && activeTab === 'participants' && (
          <div role="tabpanel" id="tabpanel-participants" aria-labelledby="tab-participants">
            <ParticipantsTab
              detail={detail}
              lineName={lineName}
              isAdmin={isAdmin}
              myJid={myJid}
              onRefresh={() => refetch()}
            />
          </div>
        )}
        {detail && activeTab === 'settings' && (
          <div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings">
            <SettingsTab
              detail={detail}
              lineName={lineName}
              isAdmin={isAdmin}
              onRefresh={() => refetch()}
              onClose={onClose}
            />
          </div>
        )}
      </ModalBody>
    </Modal>
  )
}
