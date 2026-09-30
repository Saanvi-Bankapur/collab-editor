import { Router } from 'express'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { buildTsQuery } from '../searchQuery.js'

export const searchRouter = Router()
searchRouter.use(requireAuth)

/** Markers ts_headline puts around matches; private-use characters so they can't clash with text. */
const HL_START = ''
const HL_END = ''

/**
 * Full-text search across every document the user can access.
 * Uses the GIN index on documents.search_tsv; title matches rank above body matches (weights A/B).
 */
searchRouter.get('/search', async (req, res) => {
  const tsq = buildTsQuery(String(req.query.q ?? ''))
  if (!tsq) {
    res.json({ results: [] })
    return
  }
  const headline = `StartSel=${HL_START}, StopSel=${HL_END}, MaxFragments=2, MaxWords=18, MinWords=6, FragmentDelimiter=" … "`
  const started = performance.now()
  const r = await pool.query(
    `SELECT d.id, d.title, m.role, d.updated_at,
            ts_rank_cd(d.search_tsv, q) AS rank,
            ts_headline('english', d.title, q, 'HighlightAll=true, StartSel=${HL_START}, StopSel=${HL_END}') AS title_hl,
            ts_headline('english', d.content_text, q, '${headline}') AS snippet
       FROM documents d
       JOIN document_members m ON m.doc_id = d.id AND m.user_id = $1,
            ${tsq.sql} q
      WHERE d.search_tsv @@ q
      ORDER BY rank DESC, d.updated_at DESC
      LIMIT 25`,
    [req.user!.id, tsq.param],
  )
  res.json({
    results: r.rows,
    tookMs: Math.round((performance.now() - started) * 10) / 10,
    markers: { start: HL_START, end: HL_END },
  })
})
