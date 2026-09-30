import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { config } from '../config.js'
import { verifyToken } from '../auth.js'
import { roleFor, canEdit, UUID_RE } from '../access.js'
import type { AuthUser, Role } from '../types.js'
import { PubSub, PeerMsg } from './pubsub.js'
import * as store from './persistence.js'
import { FRAGMENT, docToBlocks, blocksToPlainText, findMentions } from './docModel.js'
import { recordEdit, recordMention, summarizeChange } from '../activity.js'
import { pool } from '../db.js'
import { metrics, setGaugeSource } from '../metrics.js'

// y-websocket wire protocol message types (must match the client).
const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_QUERY_AWARENESS = 3
/** Custom message: tells the client which server instance it is on and its role. */
const MSG_SERVER_INFO = 100

// Close codes. 4400-4499 tell y-websocket's client NOT to reconnect.
export const CLOSE_RECONNECT = 4000
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_FORBIDDEN = 4403
export const CLOSE_NOT_FOUND = 4404

// Transaction origins, so the update handler knows where a change came from.
const REDIS_ORIGIN = Symbol('redis')
const LOAD_ORIGIN = Symbol('load')
const RESTORE_ORIGIN = Symbol('restore')

const FLUSH_DELAY_MS = 150
const ROOM_IDLE_MS = 30_000
const PING_INTERVAL_MS = 30_000
const AFTER_EDIT_DELAY_MS = 1500

interface Conn {
  ws: WebSocket
  user: AuthUser
  role: Role
  readOnly: boolean
  /** Awareness client ids this connection controls (removed when it disconnects). */
  awarenessIds: Set<number>
  alive: boolean
}

class Room {
  doc = new Y.Doc()
  awareness = new awarenessProtocol.Awareness(this.doc)
  conns = new Map<WebSocket, Conn>()
  ready!: Promise<void>
  pending: Uint8Array[] = []
  flushTimer: NodeJS.Timeout | null = null
  flushing: Promise<void> = Promise.resolve()
  idleTimer: NodeJS.Timeout | null = null
  logRows = 0
  lastVersionAt = 0
  closed = false
  // --- after-edit work (search index, activity, @mentions), debounced ---
  afterEditTimer: NodeJS.Timeout | null = null
  /** Users who edited through THIS instance since the last after-edit run. */
  editors = new Map<string, AuthUser>()
  /** Yjs client id -> user, learned from each connection's awareness (who typed what). */
  clientUsers = new Map<number, AuthUser>()
  /** Mention nodes we have already handled (by CRDT item id). */
  knownMentions = new Set<string>()
  indexedText: string | null = null

  constructor(public id: string) {
    // The server itself is not a participant, so it has no awareness state of its own.
    this.awareness.setLocalState(null)
  }
}

export class CollabServer {
  private rooms = new Map<string, Room>()
  private wss = new WebSocketServer({ noServer: true, maxPayload: 20 * 1024 * 1024 })
  private pubsub = new PubSub()
  private pinger: NodeJS.Timeout

  constructor() {
    this.pubsub.onMessage((docId, from, type, decoder) => this.onPeerMessage(docId, from, type, decoder))
    this.pinger = setInterval(() => this.pingAll(), PING_INTERVAL_MS)
    setGaugeSource(() => {
      const s = this.stats()
      return { connections: s.connections, openDocs: s.openDocs, pendingWrites: s.pendingWrites }
    })
  }

  // ---------------------------------------------------------------- connections

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req))
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    ws.binaryType = 'arraybuffer'
    // Buffer messages that arrive while we authenticate and load the document.
    const queue: Uint8Array[] = []
    let conn: Conn | null = null
    let room: Room | null = null
    ws.on('message', (data: RawData) => {
      const buf = toUint8(data)
      if (conn && room) this.onClientMessage(room, conn, buf)
      else queue.push(buf)
    })
    ws.on('pong', () => conn && (conn.alive = true))
    ws.on('close', () => {
      if (conn && room) this.onClose(room, conn)
    })
    ws.on('error', () => ws.terminate())

    const url = new URL(req.url ?? '/', 'http://x')
    const docId = decodeURIComponent(url.pathname.replace(/^\/ws\/?/, '').split('/')[0] ?? '')
    const user = verifyToken(url.searchParams.get('token'))

    ;(async () => {
      const reject = (code: number, reason: string) => {
        metrics.wsRejected.inc()
        ws.close(code, reason)
      }
      if (!user) return reject(CLOSE_UNAUTHORIZED, 'Not signed in')
      if (!UUID_RE.test(docId)) return reject(CLOSE_NOT_FOUND, 'No such document')
      const role = await roleFor(docId, user)
      if (!role) return reject(CLOSE_FORBIDDEN, 'No access to this document')

      const r = await this.getRoom(docId)
      if (ws.readyState !== WebSocket.OPEN) return
      const c: Conn = { ws, user, role, readOnly: !canEdit(role), awarenessIds: new Set(), alive: true }
      r.conns.set(ws, c)
      metrics.wsConnects.inc()
      this.cancelIdle(r)
      console.log(`[ws] ${user.name} joined doc ${docId.slice(0, 8)} as ${role} on ${config.instanceId} (${r.conns.size} local)`)

      // Tell the client where it landed.
      const info = encoding.createEncoder()
      encoding.writeVarUint(info, MSG_SERVER_INFO)
      encoding.writeVarString(info, JSON.stringify({ instance: config.instanceId, role }))
      send(ws, encoding.toUint8Array(info))

      // Sync step 1: send our state vector; the client replies with what we're missing.
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeSyncStep1(enc, r.doc)
      send(ws, encoding.toUint8Array(enc))

      // Send current cursors / presence.
      const states = r.awareness.getStates()
      if (states.size > 0) {
        const aw = encoding.createEncoder()
        encoding.writeVarUint(aw, MSG_AWARENESS)
        encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(r.awareness, [...states.keys()]))
        send(ws, encoding.toUint8Array(aw))
      }

      conn = c
      room = r
      for (const m of queue.splice(0)) this.onClientMessage(r, c, m)
    })().catch((e) => {
      console.error('[ws] connection setup failed', e)
      ws.close(1011, 'Server error')
    })
  }

  private onClientMessage(room: Room, conn: Conn, buf: Uint8Array) {
    try {
      const decoder = decoding.createDecoder(buf)
      const encoder = encoding.createEncoder()
      const type = decoding.readVarUint(decoder)
      switch (type) {
        case MSG_SYNC: {
          encoding.writeVarUint(encoder, MSG_SYNC)
          if (conn.readOnly) {
            // Viewers/commenters may read (step 1) but their updates are dropped.
            const syncType = decoding.readVarUint(decoder)
            if (syncType !== syncProtocol.messageYjsSyncStep1) return
            syncProtocol.readSyncStep1(decoder, encoder, room.doc)
          } else {
            syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn.ws)
          }
          if (encoding.length(encoder) > 1) send(conn.ws, encoding.toUint8Array(encoder))
          break
        }
        case MSG_AWARENESS:
          metrics.awarenessIn.inc()
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn.ws)
          break
        case MSG_QUERY_AWARENESS: {
          encoding.writeVarUint(encoder, MSG_AWARENESS)
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
          )
          send(conn.ws, encoding.toUint8Array(encoder))
          break
        }
      }
    } catch (e) {
      console.error('[ws] bad client message', e)
      conn.ws.close(1003, 'Bad message')
    }
  }

  private onClose(room: Room, conn: Conn) {
    room.conns.delete(conn.ws)
    // Remove this user's cursor for everyone (this also propagates to other instances).
    awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.awarenessIds], 'disconnect')
    console.log(`[ws] ${conn.user.name} left doc ${room.id.slice(0, 8)} (${room.conns.size} local)`)
    if (room.conns.size === 0) this.scheduleIdle(room)
  }

  private pingAll() {
    for (const room of this.rooms.values()) {
      for (const conn of room.conns.values()) {
        if (!conn.alive) {
          conn.ws.terminate()
          continue
        }
        conn.alive = false
        try {
          conn.ws.ping()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---------------------------------------------------------------- rooms

  /** Opens (or returns) the in-memory room for a document, loading it from Postgres and peers. */
  async getRoom(docId: string): Promise<Room> {
    const existing = this.rooms.get(docId)
    if (existing) {
      await existing.ready
      return existing
    }
    const room = new Room(docId)
    this.rooms.set(docId, room)
    this.wireRoom(room)
    room.ready = (async () => {
      // Subscribe first so nothing published while we load is missed.
      await this.pubsub.subscribe(docId)
      const { updates, logRows } = await store.loadDocState(docId)
      Y.transact(room.doc, () => updates.forEach((u) => Y.applyUpdate(room.doc, u)), LOAD_ORIGIN)
      room.logRows = logRows
      room.lastVersionAt = await store.lastVersionTime(docId)
      // Baseline for search indexing and for describing what each edit changed.
      room.indexedText = blocksToPlainText(docToBlocks(room.doc)).slice(0, 1_000_000)
      await pool.query('UPDATE documents SET content_text = $1 WHERE id = $2 AND content_text <> $1', [room.indexedText, docId])
      // Mentions that already exist were handled when they were typed.
      for (const m of findMentions(room.doc)) room.knownMentions.add(m.key)
      // Ask any other instance with this doc open for updates not yet in Postgres.
      this.pubsub.publish(docId, PeerMsg.SyncRequest, (enc) =>
        encoding.writeVarUint8Array(enc, Y.encodeStateVector(room.doc)),
      )
      if (logRows >= config.compactThreshold) this.compactSoon(room)
    })()
    try {
      await room.ready
    } catch (e) {
      this.rooms.delete(docId)
      await this.pubsub.unsubscribe(docId).catch(() => {})
      throw e
    }
    return room
  }

  private wireRoom(room: Room) {
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // 1. Fan out to this instance's clients.
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      const msg = encoding.toUint8Array(enc)
      for (const c of room.conns.values()) send(c.ws, msg)

      if (origin instanceof WebSocket) {
        metrics.opsIn.inc()
        const conn = room.conns.get(origin)
        if (conn) room.editors.set(conn.user.id, conn.user)
        this.scheduleAfterEdit(room)
      } else if (origin === RESTORE_ORIGIN) this.scheduleAfterEdit(room)
      else if (origin === REDIS_ORIGIN) metrics.opsRelayed.inc()
      if (origin === REDIS_ORIGIN || origin === LOAD_ORIGIN) return
      // 2. Fan out to other instances.
      this.pubsub.publish(room.id, PeerMsg.Update, (e) => encoding.writeVarUint8Array(e, update))
      // 3. Persist (the instance that received the edit from a client is the one that stores it).
      room.pending.push(update)
      if (!room.flushTimer) room.flushTimer = setTimeout(() => this.flush(room), FLUSH_DELAY_MS)
    })

    room.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed)
        if (origin instanceof WebSocket) {
          const conn = room.conns.get(origin)
          if (conn) {
            added.forEach((id) => conn.awarenessIds.add(id))
            added.concat(updated).forEach((id) => room.clientUsers.set(id, conn.user))
            removed.forEach((id) => conn.awarenessIds.delete(id))
          }
        }
        const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed)
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MSG_AWARENESS)
        encoding.writeVarUint8Array(enc, update)
        const msg = encoding.toUint8Array(enc)
        for (const c of room.conns.values()) send(c.ws, msg)
        // 'timeout' removals happen independently on every instance, so don't relay them.
        if (origin !== REDIS_ORIGIN && origin !== 'timeout') {
          this.pubsub.publish(room.id, PeerMsg.Awareness, (e) => encoding.writeVarUint8Array(e, update))
        }
      },
    )
  }

  private flush(room: Room): Promise<void> {
    if (room.flushTimer) clearTimeout(room.flushTimer)
    room.flushTimer = null
    room.flushing = room.flushing.then(async () => {
      if (room.pending.length === 0) return
      const batch = room.pending.splice(0)
      const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)
      const started = performance.now()
      try {
        await store.appendUpdate(room.id, merged)
        room.logRows++
        metrics.persistLatency.observe(performance.now() - started)
        metrics.persistedRows.inc()
        metrics.persistedBytes.inc(merged.byteLength)
      } catch (e) {
        if ((e as { code?: string }).code === '23503') return // document was deleted meanwhile
        metrics.persistErrors.inc()
        console.error(`[persist] failed to save doc ${room.id}, will retry`, (e as Error).message)
        room.pending.unshift(merged)
        if (!room.flushTimer) room.flushTimer = setTimeout(() => this.flush(room), 2000)
        return
      }
      if (room.logRows >= config.compactThreshold) this.compactSoon(room)
      await this.maybeAutoVersion(room)
    })
    return room.flushing
  }

  private scheduleAfterEdit(room: Room) {
    if (room.afterEditTimer) return
    room.afterEditTimer = setTimeout(() => {
      room.afterEditTimer = null
      this.afterEdit(room).catch((e) => console.error('[after-edit] failed', e))
    }, AFTER_EDIT_DELAY_MS)
  }

  /**
   * Work that doesn't need to happen on every keystroke:
   *  1. refresh the plain text Postgres indexes for full-text search (tsvector is a generated column)
   *  2. "X edited your doc" activity / notification
   *  3. notify users who were newly @mentioned, attributed to the client that typed the mention
   */
  private async afterEdit(room: Room) {
    if (room.closed && room.doc.isDestroyed) return
    const text = blocksToPlainText(docToBlocks(room.doc)).slice(0, 1_000_000)
    const previous = room.indexedText
    if (text !== previous) {
      room.indexedText = text
      await pool.query('UPDATE documents SET content_text = $1 WHERE id = $2', [text, room.id])
    }
    // What changed since the last run (word diff), attributed to whoever edited through this instance.
    const change = previous !== null && previous !== text ? summarizeChange(previous, text) : null
    const editors = [...room.editors.values()]
    room.editors.clear()
    for (const user of editors) await recordEdit(room.id, user, change)
    for (const m of findMentions(room.doc)) {
      if (room.knownMentions.has(m.key)) continue
      room.knownMentions.add(m.key)
      // Only the instance whose client typed the mention knows who did it, so exactly one instance notifies.
      const actor = room.clientUsers.get(m.client)
      if (actor && !actor.guest) await recordMention(room.id, actor.id, m.userId)
    }
  }

  private compactSoon(room: Room) {
    room.logRows = 0
    store.compact(room.id).catch((e) => console.error('[compaction] failed', e))
  }

  private async maybeAutoVersion(room: Room) {
    const due = room.lastVersionAt + config.autoVersionMinutes * 60_000
    if (Date.now() < due) return
    room.lastVersionAt = Date.now()
    try {
      await store.insertVersion(room.id, Y.encodeStateAsUpdate(room.doc), 'auto', null, null)
    } catch (e) {
      console.error('[versions] auto version failed', e)
    }
  }

  private scheduleIdle(room: Room) {
    this.cancelIdle(room)
    room.idleTimer = setTimeout(() => this.closeRoom(room), ROOM_IDLE_MS)
  }

  private cancelIdle(room: Room) {
    if (room.idleTimer) clearTimeout(room.idleTimer)
    room.idleTimer = null
  }

  private async closeRoom(room: Room) {
    if (room.conns.size > 0 || room.closed) return
    room.closed = true
    this.rooms.delete(room.id)
    await this.flush(room)
    if (room.afterEditTimer) {
      clearTimeout(room.afterEditTimer)
      room.afterEditTimer = null
      await this.afterEdit(room).catch(() => {})
    }
    await this.pubsub.unsubscribe(room.id).catch(() => {})
    room.awareness.destroy()
    room.doc.destroy()
  }

  // ---------------------------------------------------------------- peers (other instances)

  private onPeerMessage(docId: string, from: string, type: PeerMsg, decoder: decoding.Decoder) {
    const room = this.rooms.get(docId)
    if (!room) return
    switch (type) {
      case PeerMsg.Update:
        Y.applyUpdate(room.doc, decoding.readVarUint8Array(decoder), REDIS_ORIGIN)
        break
      case PeerMsg.Awareness:
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), REDIS_ORIGIN)
        break
      case PeerMsg.SyncRequest: {
        const sv = decoding.readVarUint8Array(decoder)
        room.ready.then(() => {
          const diff = Y.encodeStateAsUpdate(room.doc, sv)
          const aw = awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()])
          this.pubsub.publish(docId, PeerMsg.SyncResponse, (e) => {
            encoding.writeVarString(e, from)
            encoding.writeVarUint8Array(e, diff)
            encoding.writeVarUint8Array(e, aw)
          })
        })
        break
      }
      case PeerMsg.SyncResponse: {
        if (decoding.readVarString(decoder) !== config.instanceId) return
        Y.applyUpdate(room.doc, decoding.readVarUint8Array(decoder), REDIS_ORIGIN)
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), REDIS_ORIGIN)
        break
      }
      case PeerMsg.Kick:
        this.kickLocal(room, decoding.readVarString(decoder), decoding.readVarUint(decoder))
        break
      case PeerMsg.Close:
        this.closeAllLocal(room)
        break
    }
  }

  private kickLocal(room: Room, userId: string, code: number) {
    // "link:<token>" targets every guest who joined through that share link.
    const link = userId.startsWith('link:') ? userId.slice(5) : null
    for (const c of room.conns.values()) {
      if (link ? c.user.guest?.link === link : c.user.id === userId) c.ws.close(code, code === CLOSE_FORBIDDEN ? 'Access removed' : 'Access changed')
    }
  }

  private closeAllLocal(room: Room) {
    for (const c of room.conns.values()) c.ws.close(CLOSE_NOT_FOUND, 'Document deleted')
  }

  // ---------------------------------------------------------------- API used by REST routes

  /** Closes a user's live connections on every instance (after their role changed or was removed). */
  kickUser(docId: string, userId: string, removed: boolean) {
    const code = removed ? CLOSE_FORBIDDEN : CLOSE_RECONNECT
    const room = this.rooms.get(docId)
    if (room) this.kickLocal(room, userId, code)
    this.pubsub.publish(docId, PeerMsg.Kick, (e) => {
      encoding.writeVarString(e, userId)
      encoding.writeVarUint(e, code)
    })
  }

  /** Disconnects everyone from a deleted document. */
  documentDeleted(docId: string) {
    const room = this.rooms.get(docId)
    if (room) {
      room.pending = []
      this.closeAllLocal(room)
    }
    this.pubsub.publish(docId, PeerMsg.Close)
  }

  /** Current full state of a document (from memory if open here, else from Postgres). */
  async currentState(docId: string): Promise<Uint8Array> {
    const room = this.rooms.get(docId)
    if (room) {
      await room.ready
      return Y.encodeStateAsUpdate(room.doc)
    }
    const doc = await store.loadYDoc(docId)
    const state = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    return state
  }

  /**
   * Restores a previous version by replacing the live content with a copy of it.
   * This is an ordinary CRDT edit, so it syncs to every connected client and instance
   * (and can itself be undone by restoring the auto-saved "before restore" version).
   */
  async restore(docId: string, versionState: Uint8Array) {
    const room = await this.getRoom(docId)
    const tmp = new Y.Doc()
    Y.applyUpdate(tmp, versionState)
    const src = tmp.getXmlFragment(FRAGMENT)
    const dst = room.doc.getXmlFragment(FRAGMENT)
    room.doc.transact(() => {
      if (dst.length > 0) dst.delete(0, dst.length)
      const copies = src.toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone())
      if (copies.length > 0) dst.insert(0, copies)
    }, RESTORE_ORIGIN)
    tmp.destroy()
    await this.flush(room)
    room.lastVersionAt = Date.now()
    if (room.conns.size === 0) this.scheduleIdle(room)
  }

  markVersioned(docId: string) {
    const room = this.rooms.get(docId)
    if (room) room.lastVersionAt = Date.now()
  }

  stats() {
    return {
      instance: config.instanceId,
      redis: this.pubsub.enabled,
      openDocs: this.rooms.size,
      connections: [...this.rooms.values()].reduce((n, r) => n + r.conns.size, 0),
      pendingWrites: [...this.rooms.values()].reduce((n, r) => n + r.pending.length, 0),
    }
  }

  /** Metrics for every live instance (via Redis), or just this one when running without Redis. */
  async clusterMetrics(self: object): Promise<object[]> {
    await this.pubsub.reportMetrics(self)
    return (await this.pubsub.clusterMetrics().catch(() => null)) ?? [self]
  }

  reportMetrics(self: object) {
    return this.pubsub.reportMetrics(self)
  }

  async shutdown() {
    clearInterval(this.pinger)
    for (const room of this.rooms.values()) {
      for (const c of room.conns.values()) c.ws.close(1012, 'Server restarting')
      await this.flush(room)
    }
    await this.pubsub.close()
  }
}

function send(ws: WebSocket, msg: Uint8Array) {
  if (ws.readyState !== WebSocket.OPEN) return
  metrics.messagesOut.inc()
  ws.send(msg, (err) => err && ws.terminate())
}

function toUint8(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
