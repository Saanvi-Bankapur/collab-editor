import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { requireRole } from '../access.js'

export const activityRouter = Router()
activityRouter.use(requireAuth)

const ACTIVITY_SELECT = `
  SELECT a.id, a.doc_id, d.title AS doc_title, a.type, a.data, a.created_at,
         u.id AS actor_id, u.name AS actor_name, u.color AS actor_color
    FROM activities a
    JOIN documents d ON d.id = a.doc_id
    LEFT JOIN users u ON u.id = a.actor_id`

/** Feed across every document the user can see. */
activityRouter.get('/activity', async (req, res) => {
  const r = await pool.query(
    `${ACTIVITY_SELECT}
      WHERE a.doc_id IN (SELECT doc_id FROM document_members WHERE user_id = $1)
      ORDER BY a.created_at DESC LIMIT 40`,
    [req.user!.id],
  )
  res.json({ activities: r.rows })
})

activityRouter.get('/docs/:id/activity', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const r = await pool.query(`${ACTIVITY_SELECT} WHERE a.doc_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [
    req.params.id,
  ])
  res.json({ activities: r.rows })
})

activityRouter.get('/notifications', async (req, res) => {
  const [list, unread] = await Promise.all([
    pool.query(
      `SELECT n.id, n.doc_id, n.type, n.message, n.read_at, n.created_at, u.name AS actor_name, u.color AS actor_color
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
        WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 30`,
      [req.user!.id],
    ),
    pool.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [
      req.user!.id,
    ]),
  ])
  res.json({ notifications: list.rows, unread: unread.rows[0].n })
})

activityRouter.post('/notifications/read', async (req, res) => {
  const ids = z.object({ ids: z.array(z.coerce.number()).optional() }).safeParse(req.body ?? {}).data?.ids
  if (ids?.length) {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [
      req.user!.id,
      ids,
    ])
  } else {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id])
  }
  res.json({ ok: true })
})
