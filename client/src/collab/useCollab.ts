import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as decoding from 'lib0/decoding'
import { session, type Role, type User } from '../api'

export type ConnStatus = 'connecting' | 'connected' | 'offline'

export interface CollabSession {
  ydoc: Y.Doc
  provider: WebsocketProvider
}

export interface CollabStatus {
  status: ConnStatus
  /** The server has sent us the full document at least once on this connection. */
  synced: boolean
  /** The local IndexedDB copy has loaded (lets you open & edit the doc with no network). */
  localLoaded: boolean
  /** Edits made while disconnected that the server hasn't received yet. */
  pendingOffline: boolean
  /** Which backend instance we are connected to (for the horizontal-scaling demo). */
  instance: string | null
  /** Role reported by the server on this connection. */
  serverRole: Role | null
  /** Set when the server closed the connection for good (access removed, doc deleted...). */
  closedReason: string | null
}

const MSG_SERVER_INFO = 100
const IDLE_AFTER_MS = 60_000

/**
 * Wires up the CRDT for one document:
 *   Y.Doc  <->  IndexedDB (offline copy)
 *          <->  WebSocket server (real-time sync, auto-reconnect)
 * Because Yjs updates are commutative & idempotent, edits made offline simply merge on reconnect.
 */
/** `token` overrides the signed-in session (used by share-link guests). */
export function useCollab(docId: string, user: User, token?: string) {
  const [sessionObj, setSessionObj] = useState<CollabSession | null>(null)
  const [state, setState] = useState<CollabStatus>({
    status: 'connecting',
    synced: false,
    localLoaded: false,
    pendingOffline: false,
    instance: null,
    serverRole: null,
    closedReason: null,
  })

  useEffect(() => {
    const patch = (p: Partial<CollabStatus>) => setState((s) => ({ ...s, ...p }))
    setState({
      status: 'connecting',
      synced: false,
      localLoaded: false,
      pendingOffline: false,
      instance: null,
      serverRole: null,
      closedReason: null,
    })

    const ydoc = new Y.Doc()
    const idb = new IndexeddbPersistence(`coedit:${user.id}:${docId}`, ydoc)
    idb.on('synced', () => patch({ localLoaded: true }))

    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const provider = new WebsocketProvider(wsUrl, docId, ydoc, {
      params: { token: token ?? session.token ?? '' },
      maxBackoffTime: 4000,
    })

    // Custom message from our server: which instance we're on and our role.
    ;(provider as unknown as { messageHandlers: unknown[] }).messageHandlers[MSG_SERVER_INFO] = (
      _enc: unknown,
      dec: decoding.Decoder,
    ) => {
      const info = JSON.parse(decoding.readVarString(dec)) as { instance: string; role: Role }
      patch({ instance: info.instance, serverRole: info.role })
    }

    provider.on('status', ({ status }: { status: string }) => {
      patch({
        status: status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'offline',
        ...(status !== 'connected' ? { synced: false } : {}),
      })
    })
    provider.on('sync', (isSynced: boolean) => {
      patch(isSynced ? { synced: true, pendingOffline: false } : { synced: false })
    })
    provider.on('connection-close', (event: CloseEvent | null) => {
      const code = event?.code
      if (code === 4403) patch({ closedReason: 'Your access to this document was removed.' })
      else if (code === 4404) patch({ closedReason: 'This document was deleted or does not exist.' })
      else if (code === 4401) patch({ closedReason: 'Your session expired. Please log in again.' })
    })

    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin !== provider && origin !== idb && !provider.wsconnected) patch({ pendingOffline: true })
    }
    ydoc.on('update', onUpdate)

    // React to the browser's offline/online events right away instead of waiting for a timeout.
    const goOnline = () => provider.connect()
    const goOffline = () => provider.disconnect()
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    setSessionObj({ ydoc, provider })
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      ydoc.off('update', onUpdate)
      provider.destroy()
      idb.destroy()
      ydoc.destroy()
      setSessionObj(null)
    }
  }, [docId, user.id, token])

  // Presence: mark ourselves idle after a minute without activity or when the tab is hidden.
  useEffect(() => {
    if (!sessionObj) return
    const aw = sessionObj.provider.awareness
    let idle = false
    let timer: ReturnType<typeof setTimeout>
    const setIdle = (v: boolean) => {
      if (v === idle) return
      idle = v
      aw.setLocalStateField('idle', v)
    }
    const activity = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), IDLE_AFTER_MS)
    }
    const visibility = () => (document.hidden ? setIdle(true) : activity())
    aw.setLocalStateField('idle', false)
    activity()
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'focus'] as const
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }))
    document.addEventListener('visibilitychange', visibility)
    return () => {
      clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, activity))
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [sessionObj])

  return { session: sessionObj, ...state }
}

export interface PresenceUser {
  id: string
  name: string
  color: string
  idle: boolean
  isMe: boolean
  tabs: number
}

/** Everyone currently viewing the doc (deduplicated per user, across tabs and server instances). */
export function usePresence(provider: WebsocketProvider | undefined, me: User): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([])
  useEffect(() => {
    if (!provider) return
    const aw = provider.awareness
    let lastKey = ''
    const compute = () => {
      const byId = new Map<string, PresenceUser>()
      for (const st of aw.getStates().values()) {
        const u = st.user as { id?: string; name?: string; color?: string } | undefined
        if (!u?.id || !u.name) continue
        const prev = byId.get(u.id)
        const idle = Boolean(st.idle)
        if (prev) {
          prev.idle = prev.idle && idle
          prev.tabs++
        } else {
          byId.set(u.id, { id: u.id, name: u.name, color: u.color ?? '#888', idle, isMe: u.id === me.id, tabs: 1 })
        }
      }
      const next = [...byId.values()].sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name))
      // Awareness also changes on every cursor move; only re-render when who/idle actually changed.
      const key = JSON.stringify(next)
      if (key !== lastKey) {
        lastKey = key
        setUsers(next)
      }
    }
    compute()
    aw.on('change', compute)
    return () => aw.off('change', compute)
  }, [provider, me.id])
  return users
}
