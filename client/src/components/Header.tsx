import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth'
import { NotificationBell } from './NotificationBell'
import { ProfileMenu } from './ProfileMenu'

/** Top bar. Guests (share-link visitors) see only the document: no links into anyone's account. */
export function Header({ children, guest = false }: { children?: ReactNode; guest?: boolean }) {
  const { user, logout } = useAuth()
  return (
    <header className="app-header">
      {guest ? (
        <span className="brand">
          <img src="/favicon.svg" alt="" /> CoEdit
        </span>
      ) : (
        <Link to="/" className="brand">
          <img src="/favicon.svg" alt="" /> CoEdit
        </Link>
      )}
      <div className="header-middle">{children}</div>
      {user && !guest && (
        <div className="header-user">
          <NotificationBell />
          <ProfileMenu />
          <button className="btn ghost small" onClick={logout}>
            Log out
          </button>
        </div>
      )}
    </header>
  )
}
