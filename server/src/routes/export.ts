import { Router } from 'express'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { requireRole } from '../access.js'
import { collab } from '../collab/instance.js'
import { blocksToMarkdown, stateToBlocks } from '../collab/docModel.js'
import { buildDocx } from '../collab/docx.js'

/** Export a document as Markdown or Word (.docx). (PDF export is done by the browser's print-to-PDF.) */
export const exportRouter = Router()
exportRouter.use(requireAuth)

async function loadDoc(docId: string) {
  const r = await pool.query<{ title: string }>('SELECT title FROM documents WHERE id = $1', [docId])
  const blocks = stateToBlocks(await collab.currentState(docId))
  return { title: r.rows[0]?.title ?? 'Untitled document', blocks }
}

function filename(title: string, ext: string) {
  const safe = title.replace(/[^\p{L}\p{N} _.,()–-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document'
  // HTTP headers must be ASCII: plain fallback in filename=, the real (UTF-8) name in filename*=.
  const ascii = safe.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '').trim() || 'document'
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(safe)}.${ext}`
}

exportRouter.get('/docs/:id/export.md', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const { title, blocks } = await loadDoc(req.params.id)
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', filename(title, 'md'))
  res.send(blocksToMarkdown(blocks, title))
})

exportRouter.get('/docs/:id/export.docx', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const { title, blocks } = await loadDoc(req.params.id)
  const buf = await buildDocx(title, blocks)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  res.setHeader('Content-Disposition', filename(title, 'docx'))
  res.send(buf)
})

