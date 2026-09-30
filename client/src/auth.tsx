import { createContext, useContext, useState, type ReactNode } from 'react'
import { api, session, type User } from './api'

interface AuthCtx {
  user: User | null
  login(email: string, password: string): Promise<void>
  signup(name: string, email: string, password: string): Promise<void>
  logout(): void
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  // Read from localStorage so the app (and offline editing) works without a round trip.
  const [user, setUser] = useState<User | null>(session.user)

  const value: AuthCtx = {
    user,
    async login(email, password) {
      const r = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { email, password } })
      session.save(r.token, r.user)
      setUser(r.user)
    },
    async signup(name, email, password) {
      const r = await api<{ token: string; user: User }>('/auth/signup', {
        method: 'POST',
        body: { name, email, password },
      })
      session.save(r.token, r.user)
      setUser(r.user)
    },
    logout() {
      session.clear()
      setUser(null)
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
