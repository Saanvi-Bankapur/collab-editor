import { useEffect, useState, type FormEvent } from 'react'
import { api, ROLE_LABEL, type Member, type Role, type ShareLink } from '../api'
import { Avatar } from './Avatar'
import { Modal } from './Modal'
import { PeoplePicker } from './PeoplePicker'

const SHARE_ROLES: Role[] = ['editor', 'commenter', 'viewer']

export function ShareDialog({ docId, title, isOwner, meId, onClose }: {
  docId: string
  title: string
  isOwner: boolean
  meId: string
  onClose: () => void
}) {
  const [members, setMembers] = useState<Member[]>([])
  const [links, setLinks] = useState<ShareLink[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [linkRole, setLinkRole] = useState<Role>('viewer')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  async function load() {
    try {
      const m = await api<{ members: Member[] }>(`/docs/${docId}/members`)
      setMembers(m.members)
      if (isOwner) setLinks((await api<{ links: ShareLink[] }>(`/docs/${docId}/links`)).links)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  const run = (fn: () => Promise<unknown>) => async () => {
    setError('')
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    await run(async () => {
      await api(`/docs/${docId}/members`, { method: 'POST', body: { email, role } })
      setEmail('')
    })()
  }

  const linkUrl = (t: string) => `${location.origin}/s/${t}`
  async function copy(t: string) {
    try {
      await navigator.clipboard.writeText(linkUrl(t))
      setCopied(t)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      prompt('Copy this link:', linkUrl(t))
    }
  }

  return (
    <Modal title={`Share "${title}"`} onClose={onClose}>
      {isOwner && (
        <form className="invite-row" onSubmit={invite}>
          <PeoplePicker docId={docId} value={email} onChange={setEmail} onPick={setEmail} />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {SHARE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <button className="btn primary">Invite</button>
        </form>
      )}
      {error && <div className="error">{error}</div>}

      <h4>People with access</h4>
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.id}>
            <Avatar name={m.name} color={m.color} size={28} />
            <div className="member-info">
              <b>
                {m.name}
                {m.id === meId && ' (you)'}
              </b>
              <span className="muted">{m.email}</span>
            </div>
            {isOwner && m.role !== 'owner' ? (
              <>
                <select
                  value={m.role}
                  onChange={(e) =>
                    run(() => api(`/docs/${docId}/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }))()
                  }
                >
                  {SHARE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <button
                  className="btn ghost small danger"
                  title="Remove access"
                  onClick={run(() => api(`/docs/${docId}/members/${m.id}`, { method: 'DELETE' }))}
                >
                  ✕
                </button>
              </>
            ) : (
              <span className={`role-badge role-${m.role}`}>{ROLE_LABEL[m.role]}</span>
            )}
          </li>
        ))}
      </ul>

      {isOwner && (
        <>
          <h4>Shareable links</h4>
          <p className="muted small">
            The link opens <b>only this document</b>. People without a CoEdit account join as a guest; signed-in people also
            get it in their "Shared with me".
          </p>
          <ul className="link-list">
            {links.map((l) => (
              <li key={l.token}>
                <span className={`role-badge role-${l.role}`}>Anyone with the link can {verb(l.role)}</span>
                <input className="link-url" readOnly value={linkUrl(l.token)} onFocus={(e) => e.target.select()} aria-label="Share link" />
                <button className="btn small" onClick={() => copy(l.token)}>
                  {copied === l.token ? 'Copied!' : 'Copy'}
                </button>
                <button
                  className="btn ghost small danger"
                  onClick={run(() => api(`/docs/${docId}/links/${l.token}`, { method: 'DELETE' }))}
                >
                  Turn off
                </button>
              </li>
            ))}
            {links.length === 0 && <li className="muted small">No links yet.</li>}
          </ul>
          <div className="invite-row">
            <span>Create a link where anyone can</span>
            <select value={linkRole} onChange={(e) => setLinkRole(e.target.value as Role)}>
              {SHARE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {verb(r)}
                </option>
              ))}
            </select>
            <button
              className="btn"
              onClick={run(() => api(`/docs/${docId}/links`, { method: 'POST', body: { role: linkRole } }))}
            >
              Create link
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function verb(r: Role) {
  return r === 'editor' ? 'edit' : r === 'commenter' ? 'comment' : 'view'
}
