import * as Y from 'yjs'
import { pool } from '../db.js'
import { config } from '../config.js'
import { metrics } from '../metrics.js'

/**
 * Storage model (event sourcing):
 *   doc_snapshots  - one compacted Yjs state per document
 *   doc_updates    - append-only log of Yjs updates written since that snapshot
 * Loading = snapshot + every remaining log row. Yjs updates are commutative and idempotent,
 * so the order rows are applied in (and even duplicates) does not matter.
 */

export async function loadDocState(docId: string): Promise<{ updates: Uint8Array[]; logRows: number }> {
  const [snap, log] = await Promise.all([
    pool.query<{ state: Buffer }>('SELECT state FROM doc_snapshots WHERE doc_id = $1', [docId]),
    pool.query<{ data: Buffer }>('SELECT data FROM doc_updates WHERE doc_id = $1 ORDER BY id', [docId]),
  ])
  const updates: Uint8Array[] = []
  if (snap.rows[0]) updates.push(new Uint8Array(snap.rows[0].state))
  for (const row of log.rows) updates.push(new Uint8Array(row.data))
  return { updates, logRows: log.rowCount ?? 0 }
}

/** Builds a Y.Doc from what is stored in Postgres (used when the doc isn't open in memory). */
export async function loadYDoc(docId: string): Promise<Y.Doc> {
  const { updates } = await loadDocState(docId)
  const doc = new Y.Doc()
  Y.transact(doc, () => updates.forEach((u) => Y.applyUpdate(doc, u)))
  return doc
}

export async function appendUpdate(docId: string, update: Uint8Array) {
  await pool.query('INSERT INTO doc_updates (doc_id, data, instance_id) VALUES ($1, $2, $3)', [
    docId,
    Buffer.from(update),
    config.instanceId,
  ])
  await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docId])
}

/**
 * Folds the operation log into the snapshot. Runs in a transaction guarded by a per-document
 * advisory lock, so if several instances try at once only one does the work.
 * Only the rows actually read are deleted, so updates committed concurrently are never lost.
 */
export async function compact(docId: string): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [docId])
    if (!lock.rows[0].ok) {
      await client.query('ROLLBACK')
      return false
    }
    const snap = await client.query<{ state: Buffer }>('SELECT state FROM doc_snapshots WHERE doc_id = $1', [docId])
    const log = await client.query<{ id: string; data: Buffer }>(
      'SELECT id, data FROM doc_updates WHERE doc_id = $1 ORDER BY id',
      [docId],
    )
    if (log.rows.length === 0) {
      await client.query('ROLLBACK')
      return false
    }
    const doc = new Y.Doc()
    let bytesBefore = 0
    Y.transact(doc, () => {
      if (snap.rows[0]) {
        bytesBefore += snap.rows[0].state.length
        Y.applyUpdate(doc, new Uint8Array(snap.rows[0].state))
      }
      for (const row of log.rows) {
        bytesBefore += row.data.length
        Y.applyUpdate(doc, new Uint8Array(row.data))
      }
    })
    const state = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    await client.query(
      `INSERT INTO doc_snapshots (doc_id, state, compacted_at) VALUES ($1, $2, now())
       ON CONFLICT (doc_id) DO UPDATE SET state = EXCLUDED.state, compacted_at = now()`,
      [docId, Buffer.from(state)],
    )
    await client.query('DELETE FROM doc_updates WHERE id = ANY($1::bigint[])', [log.rows.map((r) => r.id)])
    await client.query('COMMIT')
    metrics.compactions.inc()
    metrics.compactedRows.inc(log.rows.length)
    console.log(
      `[compaction] doc ${docId.slice(0, 8)}: folded ${log.rows.length} log rows into snapshot ` +
        `(${bytesBefore} B -> ${state.length} B)`,
    )
    return true
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function lastVersionTime(docId: string): Promise<number> {
  const r = await pool.query<{ t: Date | null }>('SELECT max(created_at) AS t FROM doc_versions WHERE doc_id = $1', [
    docId,
  ])
  return r.rows[0]?.t?.getTime() ?? 0
}

export async function insertVersion(
  docId: string,
  state: Uint8Array,
  kind: 'named' | 'auto' | 'restore',
  name: string | null,
  userId: string | null,
) {
  const r = await pool.query<{ id: string }>(
    'INSERT INTO doc_versions (doc_id, name, kind, state, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [docId, name, kind, Buffer.from(state), userId],
  )
  return r.rows[0].id
}
