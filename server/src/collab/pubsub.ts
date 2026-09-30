import { Redis } from 'ioredis'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { config, redisEnabled } from '../config.js'
import { metrics } from '../metrics.js'

/**
 * Message types exchanged between server instances over Redis pub/sub.
 * Every document has its own channel (`doc:<id>`), and an instance only subscribes
 * while it has that document open, so traffic only goes where it is needed.
 */
export const enum PeerMsg {
  /** A Yjs document update produced by one of the sender's clients. */
  Update = 0,
  /** An awareness (cursor / presence) update. */
  Awareness = 1,
  /** "I just opened this doc, here is my state vector, send me what I'm missing." */
  SyncRequest = 2,
  /** Reply to SyncRequest, addressed to one instance: missing updates + known awareness states. */
  SyncResponse = 3,
  /** A user's access changed: close their connections (they will reconnect with the new role). */
  Kick = 4,
  /** The document was deleted: close every connection. */
  Close = 5,
}

export type PeerHandler = (docId: string, from: string, type: PeerMsg, decoder: decoding.Decoder) => void

const CHANNEL_PREFIX = 'doc:'
const METRICS_KEY = 'coedit:metrics'

export class PubSub {
  private pub: Redis | null = null
  private sub: Redis | null = null
  private handler: PeerHandler = () => {}

  constructor() {
    if (!redisEnabled) {
      console.log(`[pubsub] Redis disabled: running as a single instance`)
      return
    }
    const opts = { maxRetriesPerRequest: null, lazyConnect: false }
    this.pub = new Redis(config.redisUrl, opts)
    this.sub = new Redis(config.redisUrl, opts)
    for (const [name, r] of [['pub', this.pub], ['sub', this.sub]] as const) {
      r.on('error', (e) => console.error(`[pubsub] redis ${name} error: ${e.message}`))
    }
    this.sub.on('ready', () => console.log(`[pubsub] connected to Redis at ${config.redisUrl}`))
    this.sub.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      const ch = channel.toString()
      if (!ch.startsWith(CHANNEL_PREFIX)) return
      try {
        const decoder = decoding.createDecoder(new Uint8Array(message))
        const from = decoding.readVarString(decoder)
        if (from === config.instanceId) return // our own message echoed back
        const type = decoding.readVarUint(decoder) as PeerMsg
        metrics.redisReceived.inc()
        this.handler(ch.slice(CHANNEL_PREFIX.length), from, type, decoder)
      } catch (e) {
        console.error('[pubsub] bad message', e)
      }
    })
  }

  get enabled() {
    return this.pub !== null
  }

  onMessage(handler: PeerHandler) {
    this.handler = handler
  }

  async subscribe(docId: string) {
    await this.sub?.subscribe(CHANNEL_PREFIX + docId)
  }

  async unsubscribe(docId: string) {
    await this.sub?.unsubscribe(CHANNEL_PREFIX + docId)
  }

  publish(docId: string, type: PeerMsg, writePayload: (enc: encoding.Encoder) => void = () => {}) {
    if (!this.pub) return
    const enc = encoding.createEncoder()
    encoding.writeVarString(enc, config.instanceId)
    encoding.writeVarUint(enc, type)
    writePayload(enc)
    metrics.redisPublished.inc()
    this.pub.publish(CHANNEL_PREFIX + docId, Buffer.from(encoding.toUint8Array(enc))).catch((e) => {
      console.error('[pubsub] publish failed', e.message)
    })
  }

  /**
   * Cluster-wide monitoring: every instance writes its metrics snapshot into one Redis hash,
   * so /api/metrics on ANY instance can show the whole cluster (works behind any load balancer).
   */
  async reportMetrics(snapshot: object) {
    if (!this.pub) return
    await this.pub
      .hset(METRICS_KEY, config.instanceId, JSON.stringify({ ...snapshot, reportedAt: Date.now() }))
      .catch(() => {})
  }

  async clusterMetrics(): Promise<object[] | null> {
    if (!this.pub) return null
    const all = await this.pub.hgetall(METRICS_KEY)
    const fresh: object[] = []
    for (const [id, json] of Object.entries(all)) {
      const m = JSON.parse(json) as { reportedAt: number }
      if (Date.now() - m.reportedAt > 15_000) this.pub.hdel(METRICS_KEY, id).catch(() => {})
      else fresh.push(m)
    }
    return fresh
  }

  async close() {
    await Promise.all([this.pub?.quit(), this.sub?.quit()].map((p) => p?.catch(() => {})))
  }
}
