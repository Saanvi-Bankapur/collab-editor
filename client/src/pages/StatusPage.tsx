import { useEffect, useState } from 'react'
import { Header } from '../components/Header'

interface InstanceMetrics {
  instance: string
  down?: boolean
  uptimeSec: number
  connections: number
  openDocs: number
  pendingWrites: number
  opsPerSec: number
  relayedOpsPerSec: number
  messagesOutPerSec: number
  totals: Record<string, number>
  persistLatencyMs: { p50: number; p95: number; p99: number }
  memoryMb: number
}

/** Live monitoring page: polls /api/metrics (the load balancer merges all instances in cluster mode). */
export function StatusPage() {
  const [data, setData] = useState<InstanceMetrics[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const r = await fetch('/api/metrics')
        const j = (await r.json()) as { instances: InstanceMetrics[] }
        if (!stop) {
          setData(j.instances.sort((a, b) => a.instance.localeCompare(b.instance)))
          setError('')
        }
      } catch {
        if (!stop) setError('Backend unreachable')
      }
    }
    load()
    const t = setInterval(load, 2000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])

  const up = (data ?? []).filter((d) => !d.down)
  const sum = (f: (d: InstanceMetrics) => number) => up.reduce((n, d) => n + f(d), 0)

  return (
    <>
      <Header />
      <main className="dashboard">
        <h1>System status</h1>
        <p className="muted">
          Live numbers from every backend instance, refreshed every 2 s. Raw Prometheus format is at <code>/metrics</code>.
        </p>
        {error && <div className="error">{error}</div>}
        {data && (
          <>
            <div className="stat-row">
              <Stat label="Instances up" value={`${up.length} / ${data.length}`} />
              <Stat label="Active connections" value={sum((d) => d.connections)} />
              <Stat label="Open documents" value={sum((d) => d.openDocs)} />
              <Stat label="Client ops/sec" value={sum((d) => d.opsPerSec).toFixed(1)} />
            </div>
            <table className="doc-table metrics-table">
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Connections</th>
                  <th>Open docs</th>
                  <th>Ops/sec in</th>
                  <th>Relayed ops/sec</th>
                  <th>Msgs/sec out</th>
                  <th>DB write p50 / p95</th>
                  <th>Ops total</th>
                  <th>Compactions</th>
                  <th>Memory</th>
                  <th>Uptime</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) =>
                  d.down ? (
                    <tr key={d.instance}>
                      <td>{d.instance}</td>
                      <td colSpan={10} className="error-text">unreachable</td>
                    </tr>
                  ) : (
                    <tr key={d.instance}>
                      <td><code>{d.instance}</code></td>
                      <td>{d.connections}</td>
                      <td>{d.openDocs}</td>
                      <td>{d.opsPerSec}</td>
                      <td>{d.relayedOpsPerSec}</td>
                      <td>{d.messagesOutPerSec}</td>
                      <td>{d.persistLatencyMs.p50} / {d.persistLatencyMs.p95} ms</td>
                      <td>{d.totals.opsReceived}</td>
                      <td>{d.totals.compactions}</td>
                      <td>{d.memoryMb} MB</td>
                      <td>{formatUptime(d.uptimeSec)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </>
        )}
      </main>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  )
}

function formatUptime(s: number) {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
