import { pool } from './db.js'
import type { AuthUser, Role } from './types.js'

const RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 }

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function atLeast(role: Role | null, min: Role): boolean {
  return role !== null && RANK[role] >= RANK[min]
}

export const canEdit = (role: Role | null) => atLeast(role, 'editor')

export function higherRole(a: Role, b: Role): Role {
  return RANK[a] >= RANK[b] ? a : b
}

/** Returns the user's role on a document, or null if they have no access (or the doc doesn't exist). */
export async function getRole(docId: string, userId: string): Promise<Role | null> {
  if (!UUID_RE.test(docId)) return null
  const r = await pool.query<{ role: Role }>(
    'SELECT role FROM document_members WHERE doc_id = $1 AND user_id = $2',
    [docId, userId],
  )
  return r.rows[0]?.role ?? null
}

/** Role for a share-link guest: the link's role, only for that link's document, only while the link is on. */
export async function guestRole(docId: string, user: AuthUser): Promise<Role | null> {
  if (!user.guest || user.guest.docId !== docId) return null
  const r = await pool.query<{ role: Role }>(
    'SELECT role FROM share_links WHERE token = $1 AND doc_id = $2 AND NOT revoked',
    [user.guest.link, docId],
  )
  return r.rows[0]?.role ?? null
}

/** Role of any connecting user (member or guest). */
export async function roleFor(docId: string, user: AuthUser): Promise<Role | null> {
  return user.guest ? guestRole(docId, user) : getRole(docId, user.id)
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function requireRole(docId: string, userId: string, min: Role): Promise<Role> {
  const role = await getRole(docId, userId)
  if (!role) throw new HttpError(404, 'Document not found')
  if (!atLeast(role, min)) throw new HttpError(403, `This action needs ${min} access`)
  return role
}
