/**
 * Storage tests against a real Postgres (skipped automatically if DATABASE_URL is unreachable).
 * Checks that snapshot + compaction never change the document and never lose concurrent writes.
 */
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { pool, migrate } from '../src/db.js'
import { appendUpdate, compact, loadYDoc } from '../src/collab/persistence.js'
import { FRAGMENT } from '../src/collab/docText.js'

let dbAvailable = true
try {
  await migrate()
} catch {
  dbAvailable = false
}
after(() => pool.end())

async function newDoc() {
  const u = await pool.query<{ id: string }>(
    "INSERT INTO users (email, name, password_hash, color) VALUES ($1, 'T', 'x', '#000') RETURNING id",
    [`t-${Date.now()}-${Math.random()}@test.dev`],
  )
  const d = await pool.query<{ id: string }>('INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id', [
    'test',
    u.rows[0].id,
  ])
  return d.rows[0].id
}

/** Produces `n` small updates (one per keystroke) from a single editing session. */
function keystrokes(n: number, doc = new Y.Doc()) {
  const out: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => out.push(u))
  const frag = doc.getXmlFragment(FRAGMENT)
  if (frag.length === 0) {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText('')])
    frag.insert(0, [p])
  }
  const t = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText
  for (let i = 0; i < n; i++) {
    if (i % 5 === 4) t.delete(t.length - 1, 1)
    else t.insert(t.length, String.fromCharCode(97 + (i % 26)))
  }
  return { doc, updates: out }
}

const text = (d: Y.Doc) => d.getXmlFragment(FRAGMENT).toString()

describe('persistence', { skip: !dbAvailable && 'Postgres not reachable (set DATABASE_URL)' }, () => {
  test('op log replays to the same document', async () => {
    const id = await newDoc()
    const { doc, updates } = keystrokes(120)
    for (const u of updates) await appendUpdate(id, u)
    assert.equal(text(await loadYDoc(id)), text(doc))
  })

  test('compaction folds the log into a snapshot without changing the document', async () => {
    const id = await newDoc()
    const { doc, updates } = keystrokes(300)
    for (const u of updates) await appendUpdate(id, u)
    assert.equal(await compact(id), true)
    const rows = await pool.query('SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1', [id])
    assert.equal(rows.rows[0].n, 0)
    assert.equal(text(await loadYDoc(id)), text(doc))
    // More edits after compaction still load correctly (snapshot + new log rows).
    const more = keystrokes(40, doc)
    for (const u of more.updates) await appendUpdate(id, u)
    assert.equal(text(await loadYDoc(id)), text(doc))
  })

  test('writes that race with compaction are never lost', async () => {
    const id = await newDoc()
    const { doc, updates } = keystrokes(400)
    const half = updates.length / 2
    for (const u of updates.slice(0, half)) await appendUpdate(id, u)
    // Compact twice in parallel (like two instances) while the other half is being written.
    await Promise.all([
      compact(id),
      compact(id),
      (async () => {
        for (const u of updates.slice(half)) await appendUpdate(id, u)
      })(),
    ])
    await compact(id)
    assert.equal(text(await loadYDoc(id)), text(doc))
  })
})
