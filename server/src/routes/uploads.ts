import { Router, raw } from 'express'
import { randomUUID } from 'node:crypto'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { pool } from '../db.js'
import { requireAuth } from '../auth.js'
import { config } from '../config.js'
import { HttpError, UUID_RE } from '../access.js'

/**
 * Image uploads for the editor.
 *  - With S3_BUCKET set: the browser asks for a presigned PUT URL and uploads straight to S3
 *    (the file never passes through our servers).
 *  - Without S3: the browser POSTs the bytes here and they are stored in Postgres, so every
 *    server instance can serve every image (no shared disk needed).
 */
export const uploadsRouter = Router()

const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']
const s3 = config.s3Bucket ? new S3Client({ region: config.s3Region }) : null

const initSchema = z.object({ contentType: z.string(), size: z.number().int().positive() })

uploadsRouter.post('/uploads/init', requireAuth, async (req, res) => {
  const parsed = initSchema.safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'contentType and size are required')
  const { contentType, size } = parsed.data
  if (!ALLOWED.includes(contentType)) throw new HttpError(415, 'Only PNG, JPEG, GIF, WebP and SVG images are supported')
  if (size > config.maxUploadBytes) throw new HttpError(413, `Images must be under ${config.maxUploadBytes / 1024 / 1024} MB`)

  if (s3) {
    const ext = contentType.split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg')
    const key = `uploads/${req.user!.id}/${randomUUID()}.${ext}`
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, ContentType: contentType, ContentLength: size }),
      { expiresIn: 300 },
    )
    const base = config.s3PublicUrl || `https://${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`
    res.json({ mode: 's3', uploadUrl, method: 'PUT', url: `${base}/${key}` })
    return
  }
  res.json({ mode: 'direct', uploadUrl: '/api/uploads', method: 'POST' })
})

uploadsRouter.post(
  '/uploads',
  requireAuth,
  raw({ type: () => true, limit: config.maxUploadBytes }),
  async (req, res) => {
    const contentType = String(req.headers['content-type'] ?? '')
    if (!ALLOWED.includes(contentType)) throw new HttpError(415, 'Unsupported image type')
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'Empty upload')
    const r = await pool.query<{ id: string }>(
      'INSERT INTO uploads (owner_id, content_type, size, data) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.user!.id, contentType, body.length, body],
    )
    res.status(201).json({ url: `/api/uploads/${r.rows[0].id}` })
  },
)

/** Images are addressed by an unguessable id (an <img> tag can't send our auth header). */
uploadsRouter.get('/uploads/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) throw new HttpError(404, 'Not found')
  const r = await pool.query<{ content_type: string; data: Buffer }>(
    'SELECT content_type, data FROM uploads WHERE id = $1',
    [req.params.id],
  )
  if (!r.rows[0]) throw new HttpError(404, 'Not found')
  res.setHeader('Content-Type', r.rows[0].content_type)
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  // SVGs can contain scripts; this stops them from running if opened directly.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.send(r.rows[0].data)
})
