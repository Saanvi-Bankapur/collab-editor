import { Router } from 'express'
import { z } from 'zod'
import { diffArrays } from 'diff'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { HttpError, requireRole, UUID_RE } from '../access.js'
import { collab } from '../collab/instance.js'
import { blocksToLines, blocksToPlainText, stateToBlocks } from '../collab/docModel.js'
import { PROMPTS, REWRITE_MODES, aiEnabled, askAI, checkRateLimit, clip, currentModel } from '../ai.js'
import { config } from '../config.js'

export const aiRouter = Router()
aiRouter.use(requireAuth)

aiRouter.get('/ai/status', (_req, res) => {
  res.json({
    enabled: aiEnabled(),
    provider: config.aiProvider,
    model: currentModel(),
    baseUrl: config.aiBaseUrl,
    hint: aiEnabled() ? null : 'AI_API_KEY is empty. Put your key in server/.env and restart the server.',
  })
})

/** "Test AI connection": sends a tiny request and reports exactly what happened. */
aiRouter.post('/ai/test', async (_req, res) => {
  const info = { provider: config.aiProvider, model: config.aiModel, baseUrl: config.aiBaseUrl }
  if (!aiEnabled()) {
    res.json({ ok: false, ...info, error: 'AI_API_KEY is empty. Put your key in server/.env and restart the server.' })
    return
  }
  const started = Date.now()
  try {
    const reply = await askAI('You are a connectivity check. Reply with exactly: OK', 'ping', 64)
    res.json({ ok: true, ...info, model: currentModel(), reply, ms: Date.now() - started })
  } catch (e) {
    res.json({ ok: false, ...info, error: (e as Error).message })
  }
})

/** Summarize the current document. */
aiRouter.post('/docs/:id/ai/summarize', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  checkRateLimit(req.user!.id)
  const title = (await pool.query<{ title: string }>('SELECT title FROM documents WHERE id = $1', [req.params.id])).rows[0]?.title
  const text = blocksToPlainText(stateToBlocks(await collab.currentState(req.params.id)))
  if (!text.trim()) throw new HttpError(400, 'The document is empty, so there is nothing to summarize yet.')
  const summary = await askAI(PROMPTS.summarize, `Title: ${title}\n\n<document>\n${clip(text)}\n</document>`, 800)
  res.json({ summary })
})

const rewriteSchema = z.object({
  text: z.string().min(1).max(20_000),
  mode: z.string().default('improve'),
  instruction: z.string().max(500).optional(),
})

/** Rewrite a selection (the client replaces the selection with the result). */
aiRouter.post('/docs/:id/ai/rewrite', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'editor')
  const parsed = rewriteSchema.safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Select some text to rewrite')
  checkRateLimit(req.user!.id)
  const { text, mode, instruction } = parsed.data
  const task = mode === 'custom' && instruction ? instruction : (REWRITE_MODES[mode] ?? REWRITE_MODES.improve)
  const result = await askAI(PROMPTS.rewrite, `Task: ${task}\n\n<passage>\n${text}\n</passage>`, 2000)
  res.json({ text: result })
})

/** "Explain this change": describe the diff between a version and the current doc (or another version). */
aiRouter.post('/docs/:id/versions/:vid/explain', async (req, res) => {
  await requireRole(req.params.id, req.user!.id, 'viewer')
  const against = String(req.body?.against ?? 'current')
  const load = async (vid: string) => {
    if (!UUID_RE.test(vid)) throw new HttpError(404, 'Version not found')
    const r = await pool.query<{ state: Buffer; name: string | null; created_at: Date }>(
      'SELECT state, name, created_at FROM doc_versions WHERE doc_id = $1 AND id = $2',
      [req.params.id, vid],
    )
    if (!r.rows[0]) throw new HttpError(404, 'Version not found')
    return r.rows[0]
  }
  const from = await load(req.params.vid)
  const toState = against === 'current' ? await collab.currentState(req.params.id) : new Uint8Array((await load(against)).state)
  const changes = diffArrays(blocksToLines(stateToBlocks(new Uint8Array(from.state))), blocksToLines(stateToBlocks(toState)))
  const diffText = changes
    .flatMap((c) => c.value.map((l) => (c.added ? '+ ' : c.removed ? '- ' : '  ') + l))
    .filter((l, i, all) => !l.startsWith('  ') || all[i - 1]?.[0] !== ' ' || all[i + 1]?.[0] !== ' ') // keep 1 line of context
    .join('\n')
  if (!changes.some((c) => c.added || c.removed)) {
    res.json({ explanation: 'No differences between these versions.' })
    return
  }
  checkRateLimit(req.user!.id)
  const explanation = await askAI(PROMPTS.explain, `<diff>\n${clip(diffText, 40_000)}\n</diff>`, 700)
  res.json({ explanation })
})
