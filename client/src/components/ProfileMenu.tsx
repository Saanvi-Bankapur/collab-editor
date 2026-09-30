import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, timeAgo } from '../api'
import { useAuth } from '../auth'
import { Avatar } from './Avatar'

interface Profile {
  id: string
  name: string
  email: string
  color: string
  created_at: string
  owned: number
  shared_with_me: number
  collaborators: number
  versions_saved: number
  edit_sessions_7d: number
  last_active: string | null
}

/** Click your avatar: who you're signed in as (in this tab) and a few stats. */
export function ProfileMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState('')
  const [ai, setAi] = useState<{ enabled: boolean; model?: string; hint?: string | null } | null>(null)
  const [aiTest, setAiTest] = useState<string>('')
  const ref = useRef<HTMLDivElement>(null)

  async function testAi() {
    setAiTest('Testing…')
    try {
      const r = await api<{ ok: boolean; reply?: string; ms?: number; error?: string; model: string }>('/ai/test', { method: 'POST' })
      setAiTest(r.ok ? `✓ Working (${r.model}, ${r.ms} ms)` : `✗ ${r.error}`)
    } catch (e) {
      setAiTest(`✗ ${(e as Error).message}`)
    }
  }

  useEffect(() => {
    if (!open) return
    setError('')
    setAiTest('')
    api<{ enabled: boolean; model?: string; hint?: string | null }>('/ai/status').then(setAi).catch(() => setAi(null))
    api<{ profile: Profile }>('/auth/profile')
      .then((r) => setProfile(r.profile))
      .catch((e) => setError(e.message))
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  if (!user) return null
  return (
    <div className="dropdown" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen((v) => !v)} aria-label="Your profile" title={`${user.name} (${user.email})`}>
        <Avatar name={user.name} color={user.color} />
      </button>
      {open && (
        <div className="menu right profile-card">
          <div className="profile-head">
            <Avatar name={user.name} color={user.color} size={48} />
            <div className="profile-id">
              <b>{user.name}</b>
              <span className="muted small">{user.email}</span>
              {profile && (
                <span className="muted tiny">
                  Member since {new Date(profile.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  {profile.last_active && ` · active ${timeAgo(profile.last_active)}`}
                </span>
              )}
            </div>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="profile-stats">
            <Stat n={profile?.owned} label="Documents you own" />
            <Stat n={profile?.shared_with_me} label="Shared with you" />
            <Stat n={profile?.collaborators} label="Collaborators" />
            <Stat n={profile?.versions_saved} label="Versions saved" />
            <Stat n={profile?.edit_sessions_7d} label="Editing sessions (7 days)" />
            <Stat n={profile ? profile.owned + profile.shared_with_me : undefined} label="Total documents" />
          </div>
          {ai && (
            <div className="profile-ai small">
              <span>
                AI assist: {ai.enabled ? <b className="ok-text">on</b> : <b className="error-text">off</b>}
                {ai.enabled && ai.model && <span className="muted"> · {ai.model}</span>}
              </span>
              <button className="btn small" onClick={testAi}>
                Test AI
              </button>
              {!ai.enabled && ai.hint && <div className="muted tiny">{ai.hint}</div>}
              {aiTest && <div className={'tiny ' + (aiTest.startsWith('✓') ? 'ok-text' : aiTest.startsWith('✗') ? 'error-text' : 'muted')}>{aiTest}</div>}
            </div>
          )}
          <p className="muted tiny profile-note">
            You're signed in as this account <b>in this tab</b>. To work as a second person at the same time, use{' '}
            <b>Use another account</b>: it opens a new tab where you can log in as someone else, and this tab stays as{' '}
            {user.name}.
          </p>
          <div className="profile-actions">
            <button
              className="btn small primary"
              onClick={() => {
                setOpen(false)
                window.open('/login?fresh=1', '_blank', 'noopener')
              }}
            >
              Use another account
            </button>
            <Link to="/" className="btn small" onClick={() => setOpen(false)}>
              My documents
            </Link>
            <Link to="/status" className="btn small" onClick={() => setOpen(false)} title="Server monitoring: connections, edits per second, database speed">
              Server status
            </Link>
            <button className="btn small danger" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ n, label }: { n: number | undefined; label: string }) {
  return (
    <div className="profile-stat">
      <div className="profile-stat-n">{n ?? '–'}</div>
      <div className="muted tiny">{label}</div>
    </div>
  )
}
