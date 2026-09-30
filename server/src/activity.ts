import nodemailer, { type Transporter } from 'nodemailer'
import { pool } from './db.js'
import { config } from './config.js'
import { diffWords } from 'diff'
import type { AuthUser } from './types.js'

/**
 * Activity feed + notifications.
 *  - activities:     what happened to a document (visible to its members)
 *  - notifications:  what a specific user should know about (bell icon, optional email)
 */

export type ActivityType =
  | 'created'
  | 'renamed'
  | 'edited'
  | 'shared'
  | 'role_changed'
  | 'unshared'
  | 'link_created'
  | 'joined_via_link'
  | 'version_saved'
  | 'version_restored'
  | 'mentioned'
  | 'imported'

export async function recordActivity(docId: string, actorId: string | null, type: ActivityType, data: object = {}) {
  try {
    await pool.query('INSERT INTO activities (doc_id, actor_id, type, data) VALUES ($1, $2, $3, $4)', [
      docId,
      actorId,
      type,
      JSON.stringify(data),
    ])
  } catch (e) {
    console.error('[activity] failed to record', (e as Error).message)
  }
}

interface NotifyInput {
  userId: string
  docId: string | null
  actorId: string | null
  type: 'shared' | 'mention' | 'edited' | 'restored' | 'role_changed'
  message: string
  email?: boolean
}

export async function notify(n: NotifyInput) {
  if (n.actorId && n.actorId === n.userId) return // never notify people about their own actions
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, doc_id, actor_id, type, message) VALUES ($1, $2, $3, $4, $5)',
      [n.userId, n.docId, n.actorId, n.type, n.message],
    )
    if (n.email) await sendEmail(n.userId, n.message, n.docId)
  } catch (e) {
    console.error('[notify] failed', (e as Error).message)
  }
}

// ---------------------------------------------------------------- email

let transport: Transporter | null = null
if (config.smtpUrl) transport = nodemailer.createTransport(config.smtpUrl)

async function sendEmail(userId: string, message: string, docId: string | null) {
  const r = await pool.query<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = $1', [userId])
  const to = r.rows[0]
  if (!to) return
  const link = docId ? `${config.appUrl}/d/${docId}` : config.appUrl
  const text = `Hi ${to.name},\n\n${message}\n\nOpen it: ${link}\n\n— CoEdit`
  if (!transport) {
    console.log(`[email] (SMTP not configured, printing instead) to=${to.email}: ${message} -> ${link}`)
    return
  }
  try {
    await transport.sendMail({ from: config.mailFrom, to: to.email, subject: message, text })
  } catch (e) {
    console.error('[email] send failed', (e as Error).message)
  }
}

// ---------------------------------------------------------------- helpers used by the collab server

export interface EditChange {
  addedWords: number
  removedWords: number
  /** Short previews of the added / removed text. */
  added: string
  removed: string
}

const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

/** Word-level diff between two versions of the document text, summarized for the activity feed. */
export function summarizeChange(before: string, after: string): EditChange | null {
  const parts = diffWords(before, after)
  const added: string[] = []
  const removed: string[] = []
  let addedWords = 0
  let removedWords = 0
  const count = (t: string) => (t.match(/[\p{L}\p{N}]+/gu) ?? []).length
  for (const p of parts) {
    const t = p.value.replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (p.added) {
      added.push(t)
      addedWords += count(t)
    } else if (p.removed) {
      removed.push(t)
      removedWords += count(t)
    }
  }
  if (!added.length && !removed.length) return null
  return { addedWords, removedWords, added: clip(added.join(' … ')), removed: clip(removed.join(' … ')) }
}

/**
 * "Adya edited your doc": edits by one person within 10 minutes are merged into ONE activity entry
 * whose details (words added/removed + previews) accumulate. The owner is notified at most every
 * 30 minutes. Done in SQL so it stays correct when the same user edits through several instances.
 */
export async function recordEdit(docId: string, user: AuthUser, change: EditChange | null) {
  const actorId = user.guest ? null : user.id
  const who = user.guest ? { guestName: user.name } : {}
  const recent = await pool.query<{ id: string; data: Partial<EditChange> & { guestName?: string } }>(
    `SELECT id, data FROM activities
      WHERE doc_id = $1 AND type = 'edited' AND created_at > now() - interval '10 minutes'
        AND (actor_id = $2 OR ($2::uuid IS NULL AND actor_id IS NULL AND data->>'guestName' = $3))
      ORDER BY created_at DESC LIMIT 1`,
    [docId, actorId, user.name],
  )
  if (recent.rows[0]) {
    if (!change) return
    const old = recent.rows[0].data
    const merged = {
      ...who,
      addedWords: (old.addedWords ?? 0) + change.addedWords,
      removedWords: (old.removedWords ?? 0) + change.removedWords,
      added: clip([change.added, old.added].filter(Boolean).join(' … ')),
      removed: clip([change.removed, old.removed].filter(Boolean).join(' … ')),
    }
    await pool.query('UPDATE activities SET data = $2, created_at = now() WHERE id = $1', [recent.rows[0].id, JSON.stringify(merged)])
    return
  }
  await recordActivity(docId, actorId, 'edited', { ...who, ...(change ?? {}) })
  if (!actorId) return
  const doc = await pool.query<{ owner_id: string; title: string }>('SELECT owner_id, title FROM documents WHERE id = $1', [docId])
  const d = doc.rows[0]
  if (!d || d.owner_id === actorId) return
  const notified = await pool.query(
    `SELECT 1 FROM notifications WHERE user_id = $1 AND doc_id = $2 AND actor_id = $3 AND type = 'edited'
       AND created_at > now() - interval '30 minutes' LIMIT 1`,
    [d.owner_id, docId, actorId],
  )
  if (!notified.rowCount) {
    const what = change?.added ? `: added “${clip(change.added, 60)}”` : ''
    await notify({ userId: d.owner_id, docId, actorId, type: 'edited', message: `${user.name} edited your doc "${d.title}"${what}` })
  }
}

export async function recordMention(docId: string, actorId: string, mentionedUserId: string) {
  const r = await pool.query<{ title: string; actor: string; target: string; is_member: boolean }>(
    `SELECT d.title, a.name AS actor, t.name AS target,
            EXISTS (SELECT 1 FROM document_members m WHERE m.doc_id = d.id AND m.user_id = t.id) AS is_member
       FROM documents d, users a, users t
      WHERE d.id = $1 AND a.id = $2 AND t.id = $3`,
    [docId, actorId, mentionedUserId],
  )
  const row = r.rows[0]
  if (!row || !row.is_member || actorId === mentionedUserId) return
  await recordActivity(docId, actorId, 'mentioned', { targetId: mentionedUserId, targetName: row.target })
  await notify({
    userId: mentionedUserId,
    docId,
    actorId,
    type: 'mention',
    message: `${row.actor} mentioned you in "${row.title}"`,
    email: true,
  })
}
