import { config } from './config.js'

/**
 * Tiny in-process metrics registry (no dependencies).
 * Exposed as Prometheus text at GET /metrics and as JSON at GET /api/metrics.
 */

/** Monotonic counter that also remembers per-second buckets, so we can report a rate (ops/sec). */
class Counter {
  total = 0
  private buckets = new Map<number, number>()

  constructor(public name: string, public help: string) {}

  inc(n = 1) {
    this.total += n
    const sec = Math.floor(Date.now() / 1000)
    this.buckets.set(sec, (this.buckets.get(sec) ?? 0) + n)
    if (this.buckets.size > 120) {
      for (const k of this.buckets.keys()) if (k < sec - 60) this.buckets.delete(k)
    }
  }

  /** Average events per second over the last `windowSec` complete seconds. */
  rate(windowSec = 10) {
    const now = Math.floor(Date.now() / 1000)
    let sum = 0
    for (let s = now - windowSec; s < now; s++) sum += this.buckets.get(s) ?? 0
    return sum / windowSec
  }
}

/** Keeps the last N samples of a duration so we can report percentiles. */
class Summary {
  private samples: number[] = []
  count = 0
  sum = 0

  constructor(public name: string, public help: string, private max = 1000) {}

  observe(ms: number) {
    this.count++
    this.sum += ms
    this.samples.push(ms)
    if (this.samples.length > this.max) this.samples.shift()
  }

  quantile(q: number) {
    if (this.samples.length === 0) return 0
    const sorted = [...this.samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  }
}

export const metrics = {
  opsIn: new Counter('coedit_ops_received_total', 'Document updates (CRDT ops) received from clients'),
  opsRelayed: new Counter('coedit_ops_relayed_total', 'Document updates received from other instances via Redis'),
  messagesOut: new Counter('coedit_ws_messages_sent_total', 'WebSocket messages sent to clients'),
  awarenessIn: new Counter('coedit_awareness_updates_total', 'Cursor/presence updates received from clients'),
  redisPublished: new Counter('coedit_redis_published_total', 'Messages published to Redis'),
  redisReceived: new Counter('coedit_redis_received_total', 'Messages received from Redis (from other instances)'),
  wsConnects: new Counter('coedit_ws_connections_opened_total', 'WebSocket connections accepted'),
  wsRejected: new Counter('coedit_ws_connections_rejected_total', 'WebSocket connections rejected (auth/permission)'),
  persistedRows: new Counter('coedit_persisted_updates_total', 'Rows written to the doc_updates op log'),
  persistedBytes: new Counter('coedit_persisted_bytes_total', 'Bytes written to the doc_updates op log'),
  persistErrors: new Counter('coedit_persist_errors_total', 'Failed op-log writes (retried)'),
  compactions: new Counter('coedit_compactions_total', 'Op-log compactions into snapshots'),
  compactedRows: new Counter('coedit_compacted_rows_total', 'Op-log rows folded into snapshots'),
  httpRequests: new Counter('coedit_http_requests_total', 'HTTP API requests'),
  persistLatency: new Summary('coedit_persist_duration_ms', 'Time to write a batch of updates to Postgres (ms)'),
}

export interface Gauges {
  connections: number
  openDocs: number
  pendingWrites: number
}

let gaugeSource: () => Gauges = () => ({ connections: 0, openDocs: 0, pendingWrites: 0 })
export function setGaugeSource(fn: () => Gauges) {
  gaugeSource = fn
}

const startedAt = Date.now()

export function metricsJson() {
  const g = gaugeSource()
  const mem = process.memoryUsage()
  return {
    instance: config.instanceId,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    connections: g.connections,
    openDocs: g.openDocs,
    pendingWrites: g.pendingWrites,
    opsPerSec: round(metrics.opsIn.rate()),
    relayedOpsPerSec: round(metrics.opsRelayed.rate()),
    messagesOutPerSec: round(metrics.messagesOut.rate()),
    totals: {
      opsReceived: metrics.opsIn.total,
      opsRelayed: metrics.opsRelayed.total,
      messagesSent: metrics.messagesOut.total,
      awarenessUpdates: metrics.awarenessIn.total,
      redisPublished: metrics.redisPublished.total,
      redisReceived: metrics.redisReceived.total,
      connectionsOpened: metrics.wsConnects.total,
      connectionsRejected: metrics.wsRejected.total,
      persistedRows: metrics.persistedRows.total,
      persistedBytes: metrics.persistedBytes.total,
      persistErrors: metrics.persistErrors.total,
      compactions: metrics.compactions.total,
      compactedRows: metrics.compactedRows.total,
      httpRequests: metrics.httpRequests.total,
    },
    persistLatencyMs: {
      p50: round(metrics.persistLatency.quantile(0.5)),
      p95: round(metrics.persistLatency.quantile(0.95)),
      p99: round(metrics.persistLatency.quantile(0.99)),
    },
    memoryMb: round(mem.rss / 1024 / 1024),
  }
}

/** Prometheus text exposition format (scrape with Prometheus/Grafana, or just read it). */
export function metricsPrometheus() {
  const g = gaugeSource()
  const label = `{instance="${config.instanceId}"}`
  const lines: string[] = []
  const gauge = (name: string, help: string, v: number) =>
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${label} ${v}`)

  gauge('coedit_ws_connections', 'Active WebSocket connections', g.connections)
  gauge('coedit_open_documents', 'Documents currently loaded in memory', g.openDocs)
  gauge('coedit_pending_writes', 'Updates buffered and not yet written to Postgres', g.pendingWrites)
  gauge('coedit_ops_per_second', 'Client ops/sec received (10s average)', round(metrics.opsIn.rate()))
  gauge('coedit_process_resident_memory_bytes', 'Resident memory', process.memoryUsage().rss)
  gauge('coedit_uptime_seconds', 'Seconds since start', Math.round((Date.now() - startedAt) / 1000))

  for (const m of Object.values(metrics)) {
    if (m instanceof Counter) {
      lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} counter`, `${m.name}${label} ${m.total}`)
    } else {
      lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} summary`)
      for (const q of [0.5, 0.95, 0.99]) {
        lines.push(`${m.name}{instance="${config.instanceId}",quantile="${q}"} ${round(m.quantile(q))}`)
      }
      lines.push(`${m.name}_sum${label} ${round(m.sum)}`, `${m.name}_count${label} ${m.count}`)
    }
  }
  return lines.join('\n') + '\n'
}

function round(n: number) {
  return Math.round(n * 100) / 100
}
