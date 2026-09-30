import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, timeAgo, type Notification } from '../api'
import { Avatar } from './Avatar'

/** In-app notifications (polled every 15 s and whenever the tab regains focus). */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  async function load() {
    try {
      const r = await api<{ notifications: Notification[]; unread: number }>('/notifications')
      setItems(r.notifications)
      setUnread(r.unread)
    } catch {
      /* offline: keep what we have */
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    window.addEventListener('focus', load)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  async function markAllRead() {
    await api('/notifications/read', { method: 'POST', body: {} }).catch(() => {})
    load()
  }

  async function openItem(n: Notification) {
    setOpen(false)
    if (!n.read_at) await api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => {})
    load()
    if (n.doc_id) navigate(`/d/${n.doc_id}`)
  }

  return (
    <div className="dropdown" ref={ref}>
      <button className="btn ghost small bell" onClick={() => setOpen((v) => !v)} aria-label={`Notifications (${unread} unread)`}>
        🔔{unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="menu notif-menu">
          <div className="notif-head">
            <b>Notifications</b>
            {unread > 0 && (
              <button className="btn ghost small" onClick={markAllRead}>
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 && <p className="muted small pad">You're all caught up.</p>}
          {items.map((n) => (
            <button key={n.id} className={'notif' + (n.read_at ? '' : ' unread')} onClick={() => openItem(n)}>
              <Avatar name={n.actor_name ?? '?'} color={n.actor_color ?? '#9ca3af'} size={26} />
              <span>
                <span className="small">{n.message}</span>
                <span className="muted tiny block">{timeAgo(n.created_at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
