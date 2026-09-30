import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { pool } from '../db.js'
import { requireAuth, signToken } from '../auth.js'
import { HttpError } from '../access.js'
import type { AuthUser } from '../types.js'

export const authRouter = Router()

const COLORS = ['#e11d48', '#d97706', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#c026d3', '#db2777', '#0d9488', '#ea580c']

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(60),
  password: z.string().min(6).max(200),
})

authRouter.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Enter a valid email, a name, and a password of at least 6 characters')
  const { email, name, password } = parsed.data
  const hash = await bcrypt.hash(password, 10)
  const color = COLORS[Math.floor(Math.random() * COLORS.length)]
  try {
    const r = await pool.query<AuthUser>(
      'INSERT INTO users (email, name, password_hash, color) VALUES ($1, $2, $3, $4) RETURNING id, email, name, color',
      [email, name, hash, color],
    )
    const user = r.rows[0]
    res.status(201).json({ token: signToken(user), user })
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'An account with that email already exists')
    throw e
  }
})

const loginSchema = z.object({ email: z.string().trim().toLowerCase(), password: z.string() })

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) throw new HttpError(400, 'Email and password are required')
  const r = await pool.query<AuthUser & { password_hash: string }>(
    'SELECT id, email, name, color, password_hash FROM users WHERE email = $1',
    [parsed.data.email],
  )
  const row = r.rows[0]
  if (!row || !(await bcrypt.compare(parsed.data.password, row.password_hash))) {
    throw new HttpError(401, 'Wrong email or password')
  }
  const user: AuthUser = { id: row.id, email: row.email, name: row.name, color: row.color }
  res.json({ token: signToken(user), user })
})

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})

/** Profile card data: who you are + a few stats about your documents and activity. */
authRouter.get('/profile', requireAuth, async (req, res) => {
  const id = req.user!.id
  const r = await pool.query(
    `SELECT u.id, u.name, u.email, u.color, u.created_at,
       (SELECT count(*)::int FROM document_members WHERE user_id = u.id AND role = 'owner') AS owned,
       (SELECT count(*)::int FROM document_members WHERE user_id = u.id AND role <> 'owner') AS shared_with_me,
       (SELECT count(DISTINCT m2.user_id)::int
          FROM document_members m1 JOIN document_members m2 ON m2.doc_id = m1.doc_id
         WHERE m1.user_id = u.id AND m2.user_id <> u.id) AS collaborators,
       (SELECT count(*)::int FROM doc_versions WHERE created_by = u.id AND kind = 'named') AS versions_saved,
       (SELECT count(*)::int FROM activities WHERE actor_id = u.id AND type = 'edited'
           AND created_at > now() - interval '7 days') AS edit_sessions_7d,
       (SELECT max(created_at) FROM activities WHERE actor_id = u.id) AS last_active
     FROM users u WHERE u.id = $1`,
    [id],
  )
  if (!r.rows[0]) throw new HttpError(404, 'User not found')
  res.json({ profile: r.rows[0] })
})
