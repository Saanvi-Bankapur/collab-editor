/**
 * Runs N server instances plus a round-robin load balancer, to demo horizontal scaling.
 *   npm run cluster            -> 3 instances on :4001-4003, load balancer on :4000
 *   INSTANCES=5 npm run cluster
 * Every HTTP request and WebSocket goes to the next instance in turn, so two browser tabs
 * on the same document usually land on different servers; Redis pub/sub keeps them in sync.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import httpProxy from 'http-proxy'
import 'dotenv/config'

const COUNT = Number(process.env.INSTANCES ?? 3)
const LB_PORT = Number(process.env.PORT ?? 4000)
const BASE = LB_PORT + 1
const targets = Array.from({ length: COUNT }, (_, i) => ({ id: `server-${i + 1}`, port: BASE + i }))

const children: ChildProcess[] = targets.map(({ id, port }) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(port), INSTANCE_ID: id },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = `[${id}] `
  child.stdout!.on('data', (d: Buffer) => process.stdout.write(indent(prefix, d)))
  child.stderr!.on('data', (d: Buffer) => process.stderr.write(indent(prefix, d)))
  child.on('exit', (code) => console.log(`${prefix}exited with code ${code}`))
  return child
})

function indent(prefix: string, d: Buffer) {
  return d
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => (l.startsWith(prefix.trim()) ? l : prefix + l))
    .join('\n') + '\n'
}

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true })
proxy.on('error', (err, _req, res) => {
  console.error('[lb] proxy error:', err.message)
  if (res && 'writeHead' in res && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Server instance unavailable' }))
  } else if (res && 'destroy' in res) res.destroy()
})

let next = 0
const pick = () => targets[next++ % targets.length]

/** Prometheus text for the whole cluster: the LB asks every instance and merges the answers. */
async function clusterMetrics(_req: http.IncomingMessage, res: http.ServerResponse) {
  const texts = await Promise.all(
    targets.map(async (t) => {
      try {
        return await (await fetch(`http://localhost:${t.port}/metrics`)).text()
      } catch {
        return `# ${t.id} unreachable\n`
      }
    }),
  )
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
  res.end(mergePrometheus(texts))
}

/** Merges several Prometheus texts so each metric's HELP/TYPE appears once, followed by all instances' samples. */
function mergePrometheus(texts: string[]) {
  const groups = new Map<string, { meta: string[]; samples: string[] }>()
  const extra: string[] = []
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line) continue
      const meta = line.match(/^# (HELP|TYPE) (\S+)/)
      const name = meta ? meta[2] : line.match(/^([a-zA-Z_:][\w:]*?)(_sum|_count)?[{ ]/)?.[1]
      if (!name) {
        extra.push(line)
        continue
      }
      const g = groups.get(name) ?? { meta: [], samples: [] }
      groups.set(name, g)
      if (meta) {
        if (!g.meta.includes(line)) g.meta.push(line)
      } else g.samples.push(line)
    }
  }
  return [...extra, ...[...groups.values()].flatMap((g) => [...g.meta, ...g.samples])].join('\n') + '\n'
}

const lb = http.createServer((req, res) => {
  // (/api/metrics needs no special handling: every instance already reports the whole cluster via Redis.)
  if (req.method === 'GET' && req.url === '/metrics') {
    clusterMetrics(req, res)
    return
  }
  const t = pick()
  proxy.web(req, res, { target: `http://localhost:${t.port}` })
})
lb.on('upgrade', (req, socket, head) => {
  const t = pick()
  console.log(`[lb] websocket ${req.url?.split('?')[0]} -> ${t.id}`)
  proxy.ws(req, socket, head, { target: `ws://localhost:${t.port}` })
})
lb.listen(LB_PORT, () => {
  console.log(`[lb] load balancer on http://localhost:${LB_PORT} -> ${targets.map((t) => `${t.id}:${t.port}`).join(', ')}`)
})

function stop() {
  for (const c of children) c.kill('SIGTERM')
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
