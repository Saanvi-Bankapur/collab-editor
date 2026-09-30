import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { HttpError, requireRole } from '../access.js'
import { collab } from '../collab/instance.js'
import { recordActivity } from '../activity.js'

export const docsRouter = Router()
docsRouter.use(requireAuth)

/** "My documents": everything the user owns or has been shared. */
docsRouter.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT d.id, d.title, m.role, d.created_at, d.updated_at,
            o.name AS owner_name, o.id AS owner_id
       FROM document_members m
       JOIN documents d ON d.id = m.doc_id
       JOIN users o ON o.id = d.owner_id
      WHERE m.user_id = $1
      ORDER BY d.updated_at DESC`,
    [req.user!.id],
  )
  res.json({ documents: r.rows })
})

const titleSchema = z.object({ title: z.string().trim().min(1).max(200) })

docsRouter.post('/', async (req, res) => {
  const title = titleSchema.safeParse(req.body).data?.title ?? 'Untitled document'
  // Where the doc came from, for the activity feed: e.g. "template:Meeting notes" or "import:notes.md".
  const source = z.string().max(200).optional().safeParse(req.body?.source).data
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const d = await client.query('INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING *', [
      title,
      req.user!.id,
    ])
    await client.query("INSERT INTO document_members (doc_id, user_id, role) VALUES ($1, $2, 'owner')", [
      d.rows[0].id,
      req.user!.id,
    ])
    await client.query('COMMIT')
    await recordActivity(d.rows[0].id, req.user!.id, 'created', source ? { source } : {})
    res.status(201).json({ document: { ...d.rows[0], role: 'owner' } })
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
})

docsRouter.get('/:id', async (req, res) => {
  const role = await requireRole(req.params.id, req.user!.id, 'viewer')
  const r = await pool.query(
    `SELECT d.id, d.title, d.created_at, d.updated_at, o.name AS owner_name, o.id AS owner_id
       FROM documents d JOIN users o ON o.id = d.owner_id WHERE d.id = $1`,
    [req.params.id],
  )
  res.json({ document: { ...r.rows[0], role } })
})

docsRouter.patch('/:id', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'editor')
  const parsed = titleSchema.safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Title must be 1-200 characters')
  const old = await pool.query<{ title: string }>('SELECT title FROM documents WHERE id = $1', [req.params.id])
  const r = await pool.query('UPDATE documents SET title = $1, updated_at = now() WHERE id = $2 RETURNING id, title', [
    parsed.data.title,
    req.params.id,
  ])
  if (old.rows[0]?.title !== parsed.data.title) {
    await recordActivity(req.params.id, req.user!.id, 'renamed', { from: old.rows[0]?.title, to: parsed.data.title })
  }
  res.json({ document: r.rows[0] })
})

docsRouter.delete('/:id', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'owner')
  await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id])
  collab.documentDeleted(req.params.id)
  res.status(204).end()
})
