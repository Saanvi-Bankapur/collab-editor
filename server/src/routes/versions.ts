import { Router } from 'express'
import { z } from 'zod'
import { diffArrays } from 'diff'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { HttpError, requireRole, UUID_RE } from '../access.js'
import { collab } from '../collab/instance.js'
import { insertVersion } from '../collab/persistence.js'
import { stateToLines } from '../collab/docModel.js'
import { notify, recordActivity } from '../activity.js'

export const versionsRouter = Router()
versionsRouter.use(requireAuth)

async function loadVersion(docId: string, versionId: string) {
  if (!UUID_RE.test(versionId)) throw new HttpError(404, 'Version not found')
  const r = await pool.query<{ id: string; name: string | null; kind: string; created_at: Date; state: Buffer }>(
    'SELECT id, name, kind, created_at, state FROM doc_versions WHERE doc_id = $1 AND id = $2',
    [docId, versionId],
  )
  if (!r.rows[0]) throw new HttpError(404, 'Version not found')
  return r.rows[0]
}

/** Timeline: every version of the document, newest first. */
versionsRouter.get('/docs/:id/versions', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const r = await pool.query(
    `SELECT v.id, v.name, v.kind, v.created_at, u.name AS created_by_name, u.color AS created_by_color,
            octet_length(v.state) AS size
       FROM doc_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.doc_id = $1
      ORDER BY v.created_at DESC`,
    [req.params.id],
  )
  res.json({ versions: r.rows })
})

/** Save a named snapshot of the current state. */
versionsRouter.post('/docs/:id/versions', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'editor')
  const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Give the version a name (1-120 characters)')
  const state = await collab.currentState(req.params.id)
  const id = await insertVersion(req.params.id, state, 'named', parsed.data.name, req.user!.id)
  collab.markVersioned(req.params.id)
  await recordActivity(req.params.id, req.user!.id, 'version_saved', { versionId: id, name: parsed.data.name })
  res.status(201).json({ version: { id, name: parsed.data.name } })
})

/** Raw Yjs state of a version (base64) so the client can render it read-only. */
versionsRouter.get('/docs/:id/versions/:vid', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const v = await loadVersion(req.params.id, req.params.vid)
  res.json({ version: { id: v.id, name: v.name, kind: v.kind, created_at: v.created_at, state: v.state.toString('base64') } })
})

/** Line diff between a version and another version (or the current document). */
versionsRouter.get('/docs/:id/versions/:vid/diff', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const target = await loadVersion(req.params.id, req.params.vid)
  const against = String(req.query.against ?? 'current')
  const base =
    against === 'current'
      ? await collab.currentState(req.params.id)
      : new Uint8Array((await loadVersion(req.params.id, against)).state)
  // "old" = the selected version, "new" = what we compare against (current by default).
  const changes = diffArrays(stateToLines(new Uint8Array(target.state)), stateToLines(base))
  const lines: { type: 'same' | 'added' | 'removed'; text: string }[] = []
  for (const c of changes) {
    const type = c.added ? 'added' : c.removed ? 'removed' : 'same'
    for (const text of c.value) lines.push({ type, text })
  }
  res.json({
    lines,
    added: lines.filter((l) => l.type === 'added').length,
    removed: lines.filter((l) => l.type === 'removed').length,
  })
})

/** Restore: checkpoint the current state, then replace the content with the chosen version. */
versionsRouter.post('/docs/:id/versions/:vid/restore', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'editor')
  const v = await loadVersion(req.params.id, req.params.vid)
  const current = await collab.currentState(req.params.id)
  const label = v.name ?? `auto-save from ${v.created_at.toISOString()}`
  await insertVersion(req.params.id, current, 'restore', `Before restoring "${label}"`, req.user!.id)
  await collab.restore(req.params.id, new Uint8Array(v.state))
  await recordActivity(req.params.id, req.user!.id, 'version_restored', { versionId: v.id, name: label })
  const doc = await pool.query<{ owner_id: string; title: string }>('SELECT owner_id, title FROM documents WHERE id = $1', [
    req.params.id,
  ])
  if (doc.rows[0]) {
    await notify({
      userId: doc.rows[0].owner_id,
      docId: req.params.id,
      actorId: req.user!.id,
      type: 'restored',
      message: `${req.user!.name} restored "${doc.rows[0].title}" to "${label}"`,
    })
  }
  res.json({ ok: true })
})
