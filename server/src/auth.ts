import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import { config } from './config.js'
import type { AuthUser } from './types.js'

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name, color: user.color }, config.jwtSecret, {
    expiresIn: '7d',
  })
}

/** A guest token only works for the one document behind the share link it came from. */
export function signGuestToken(user: AuthUser & { guest: { docId: string; link: string } }): string {
  return jwt.sign(
    { sub: user.id, email: '', name: user.name, color: user.color, guest: user.guest },
    config.jwtSecret,
    { expiresIn: '12h' },
  )
}

export function verifyToken(token: string | undefined | null): AuthUser | null {
  if (!token) return null
  try {
    const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload
    if (typeof p.sub !== 'string') return null
    const user: AuthUser = { id: p.sub, email: p.email, name: p.name, color: p.color }
    if (p.guest && typeof p.guest.docId === 'string' && typeof p.guest.link === 'string') {
      user.guest = { docId: p.guest.docId, link: p.guest.link }
    }
    return user
  } catch {
    return null
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  const user = verifyToken(token)
  if (!user) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }
  // Guests (share-link visitors) can only use the real-time connection to their one document.
  if (user.guest) {
    res.status(403).json({ error: 'Sign in to CoEdit to do this' })
    return
  }
  req.user = user
  next()
}
