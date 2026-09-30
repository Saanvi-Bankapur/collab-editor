import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, type GuestSession } from '../api'
import { useAuth } from '../auth'
import { EditorPage } from './EditorPage'

const guestKey = (token: string) => `coedit.guest.${token}`

/**
 * What a share link (/s/:token) opens:
 *  - signed in  -> the document is added to your "Shared with me" and opens directly
 *  - not signed in -> the document opens right away as a guest (this document only, no account access)
 */
export function ShareLanding() {
  const { token = '' } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState('')
  const [guest, setGuest] = useState<GuestSession | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(guestKey(token)) ?? 'null')
    } catch {
      return null
    }
  })

  useEffect(() => {
    setError('')
    if (user) {
      api<{ docId: string }>(`/share/${encodeURIComponent(token)}/accept`, { method: 'POST' })
        .then((r) => navigate(`/d/${r.docId}`, { replace: true }))
        .catch((e) => setError(e.message))
      return
    }
    if (guest) return
    fetch(`/api/share/${encodeURIComponent(token)}/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error ?? `Could not open the link (${res.status})`)
        sessionStorage.setItem(guestKey(token), JSON.stringify(data))
        setGuest(data)
      })
      .catch((e) => setError(e.message === 'Failed to fetch' ? 'Could not reach the CoEdit server.' : e.message))
  }, [user, token, guest, navigate])

  if (error) {
    return (
      <main className="center-card">
        <div className="brand brand-lg">
          <img src="/favicon.svg" alt="" /> CoEdit
        </div>
        <h2>This link doesn't work</h2>
        <p className="error">{error}</p>
        <p className="muted small">
          Ask the person who shared it to check that the link is still turned on in their Share settings, and that you
          copied the whole link.
        </p>
        {user && <Link to="/">Go to your documents</Link>}
      </main>
    )
  }
  if (user || !guest) return <p className="muted center-card">Opening the shared document…</p>
  return (
    <EditorPage
      key={guest.token}
      guest={guest}
      onGuestExpired={() => {
        sessionStorage.removeItem(guestKey(token))
        setGuest(null)
      }}
      signInState={{ from: location.pathname }}
    />
  )
}
