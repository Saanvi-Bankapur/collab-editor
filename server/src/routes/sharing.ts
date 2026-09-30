import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { pool } from '../db.js'
import { requireAuth, signGuestToken } from '../auth.js'
import { HttpError, requireRole, getRole, higherRole, UUID_RE } from '../access.js'
import { collab } from '../collab/instance.js'
import type { Role } from '../types.js'
import { notify, recordActivity } from '../activity.js'

async function docTitle(docId: string) {
  const r = await pool.query<{ title: string }>('SELECT title FROM documents WHERE id = $1', [docId])
  return r.rows[0]?.title ?? 'a document'
}
async function userName(userId: string) {
  const r = await pool.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId])
  return r.rows[0]?.name ?? 'Someone'
}

export const sharingRouter = Router()

// ---- share-link guests (no account needed) ---------------------------------
// Mounted BEFORE requireAuth: opening a link must work for people who aren't signed in.

const GUEST_ANIMALS = ['Fox', 'Otter', 'Panda', 'Koala', 'Falcon', 'Dolphin', 'Tiger', 'Owl', 'Lynx', 'Heron', 'Bison', 'Gecko']
const GUEST_COLORS = ['#e11d48', '#d97706', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#c026d3', '#0d9488', '#ea580c']
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

/** Public info about a link (so the landing page can say what it opens). */
sharingRouter.get('/share/:token/info', async (req, res) => {
  const link = await findLink(req.params.token)
  res.json({ docId: link.doc_id, title: link.title, ownerName: link.owner_name, role: link.role })
})

/**
 * Opening a link without an account: returns a guest token that works for THIS document only
 * (never the owner's or anyone's account), with the link's access level, for as long as the link is on.
 */
sharingRouter.post('/share/:token/guest', async (req, res) => {
  const link = await findLink(req.params.token)
  const name = z.string().trim().min(1).max(40).safeParse(req.body?.name).data ?? `Guest ${pick(GUEST_ANIMALS)}`
  const user = {
    id: `guest-${randomBytes(8).toString('hex')}`,
    email: '',
    name,
    color: pick(GUEST_COLORS),
    guest: { docId: link.doc_id, link: req.params.token },
  }
  res.json({
    token: signGuestToken(user),
    user: { id: user.id, email: '', name: user.name, color: user.color },
    docId: link.doc_id,
    title: link.title,
    ownerName: link.owner_name,
    role: link.role,
  })
})

sharingRouter.use(requireAuth)

// ---- people search (for the "Add people" box) ------------------------------

/** Type-ahead: CoEdit accounts whose name or email matches, people you already work with first. */
sharingRouter.get('/users/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100)
  const docId = String(req.query.docId ?? '')
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.color,
            EXISTS (SELECT 1 FROM document_members a JOIN document_members b ON a.doc_id = b.doc_id
                     WHERE a.user_id = $1 AND b.user_id = u.id) AS collaborator
       FROM users u
      WHERE u.id <> $1
        AND ($2 = '' OR lower(u.name) LIKE $3 OR lower(u.email) LIKE $3)
        AND NOT EXISTS (SELECT 1 FROM document_members m WHERE m.doc_id::text = $4 AND m.user_id = u.id)
      ORDER BY collaborator DESC, (lower(u.email) LIKE $5) DESC, u.name
      LIMIT 8`,
    [req.user!.id, q, like, docId, `${q}%`],
  )
  res.json({ users: r.rows })
})

const shareRole = z.enum(['editor', 'commenter', 'viewer'])

// ---- members ---------------------------------------------------------------

sharingRouter.get('/docs/:id/members', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.color, m.role, m.added_at
       FROM document_members m JOIN users u ON u.id = m.user_id
      WHERE m.doc_id = $1
      ORDER BY (m.role = 'owner') DESC, m.added_at`,
    [req.params.id],
  )
  res.json({ members: r.rows })
})

sharingRouter.post('/docs/:id/members', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'owner')
  const parsed = z.object({ email: z.string().trim().toLowerCase(), role: shareRole }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Email and a role (editor, commenter, viewer) are required')
  const u = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [parsed.data.email])
  if (!u.rows[0]) throw new HttpError(404, 'No user with that email. Ask them to sign up first.')
  const userId = u.rows[0].id
  const existing = await getRole(req.params.id, userId)
  if (existing === 'owner') throw new HttpError(400, 'That user owns this document')
  await pool.query(
    `INSERT INTO document_members (doc_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [req.params.id, userId, parsed.data.role],
  )
  if (existing) collab.kickUser(req.params.id, userId, false)
  const [title, target] = await Promise.all([docTitle(req.params.id), userName(userId)])
  const role = parsed.data.role
  await recordActivity(req.params.id, req.user!.id, existing ? 'role_changed' : 'shared', { targetId: userId, targetName: target, role })
  await notify({
    userId,
    docId: req.params.id,
    actorId: req.user!.id,
    type: existing ? 'role_changed' : 'shared',
    message: existing
      ? `${req.user!.name} changed your access to "${title}" to ${role}`
      : `${req.user!.name} shared "${title}" with you as ${role}`,
    email: !existing,
  })
  res.status(201).json({ ok: true })
})

sharingRouter.patch('/docs/:id/members/:userId', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'owner')
  const parsed = z.object({ role: shareRole }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Invalid role')
  if (!UUID_RE.test(req.params.userId)) throw new HttpError(404, 'Member not found')
  const r = await pool.query(
    "UPDATE document_members SET role = $1 WHERE doc_id = $2 AND user_id = $3 AND role <> 'owner'",
    [parsed.data.role, req.params.id, req.params.userId],
  )
  if (!r.rowCount) throw new HttpError(404, 'Member not found')
  collab.kickUser(req.params.id, req.params.userId, false)
  const [title, target] = await Promise.all([docTitle(req.params.id), userName(req.params.userId)])
  await recordActivity(req.params.id, req.user!.id, 'role_changed', {
    targetId: req.params.userId,
    targetName: target,
    role: parsed.data.role,
  })
  await notify({
    userId: req.params.userId,
    docId: req.params.id,
    actorId: req.user!.id,
    type: 'role_changed',
    message: `${req.user!.name} changed your access to "${title}" to ${parsed.data.role}`,
  })
  res.json({ ok: true })
})

sharingRouter.delete('/docs/:id/members/:userId', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'owner')
  if (!UUID_RE.test(req.params.userId)) throw new HttpError(404, 'Member not found')
  const r = await pool.query("DELETE FROM document_members WHERE doc_id = $1 AND user_id = $2 AND role <> 'owner'", [
    req.params.id,
    req.params.userId,
  ])
  if (!r.rowCount) throw new HttpError(404, 'Member not found')
  collab.kickUser(req.params.id, req.params.userId, true)
  await recordActivity(req.params.id, req.user!.id, 'unshared', { targetId: req.params.userId, targetName: await userName(req.params.userId) })
  res.status(204).end()
})

// ---- shareable links -------------------------------------------------------

sharingRouter.get('/docs/:id/links', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'owner')
  const r = await pool.query(
    'SELECT token, role, created_at FROM share_links WHERE doc_id = $1 AND NOT revoked ORDER BY created_at',
    [req.params.id],
  )
  res.json({ links: r.rows })
})

sharingRouter.post('/docs/:id/links', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'owner')
  const parsed = z.object({ role: shareRole }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Invalid role')
  const token = randomBytes(18).toString('base64url')
  await pool.query('INSERT INTO share_links (token, doc_id, role, created_by) VALUES ($1, $2, $3, $4)', [
    token,
    req.params.id,
    parsed.data.role,
    req.user!.id,
  ])
  await recordActivity(req.params.id, req.user!.id, 'link_created', { role: parsed.data.role })
  res.status(201).json({ link: { token, role: parsed.data.role } })
})

sharingRouter.delete('/docs/:id/links/:token', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'owner')
  await pool.query('UPDATE share_links SET revoked = true WHERE token = $1 AND doc_id = $2', [
    req.params.token,
    req.params.id,
  ])
  // Guests who came in through this link lose access immediately.
  collab.kickUser(req.params.id, `link:${req.params.token}`, true)
  res.status(204).end()
})

async function findLink(rawToken: string) {
  const token = decodeURIComponent(rawToken).trim().replace(/[^A-Za-z0-9_-]/g, '')
  const r = await pool.query<{ doc_id: string; role: Role; title: string; owner_name: string }>(
    `SELECT l.doc_id, l.role, d.title, u.name AS owner_name
       FROM share_links l JOIN documents d ON d.id = l.doc_id JOIN users u ON u.id = d.owner_id
      WHERE l.token = $1 AND NOT l.revoked`,
    [token],
  )
  if (!r.rows[0]) throw new HttpError(404, 'This link is invalid or has been turned off')
  return r.rows[0]
}

sharingRouter.get('/share/:token', async (req, res) => {
  const link = await findLink(req.params.token)
  res.json({ docId: link.doc_id, title: link.title, ownerName: link.owner_name, role: link.role })
})

/** Opening a share link adds the user as a member with the link's access level (never downgrades). */
sharingRouter.post('/share/:token/accept', async (req, res) => {
  const link = await findLink(req.params.token)
  const current = await getRole(link.doc_id, req.user!.id)
  const role = current ? higherRole(current, link.role) : link.role
  if (role !== current) {
    await pool.query(
      `INSERT INTO document_members (doc_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [link.doc_id, req.user!.id, role],
    )
    await recordActivity(link.doc_id, req.user!.id, 'joined_via_link', { role })
  }
  res.json({ docId: link.doc_id, role })
})
