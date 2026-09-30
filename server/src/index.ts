import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import { config } from './config.js'
import { migrate, pool } from './db.js'
import { HttpError } from './access.js'
import { authRouter } from './routes/auth.js'
import { docsRouter } from './routes/docs.js'
import { sharingRouter } from './routes/sharing.js'
import { versionsRouter } from './routes/versions.js'
import { searchRouter } from './routes/search.js'
import { uploadsRouter } from './routes/uploads.js'
import { exportRouter } from './routes/export.js'
import { activityRouter } from './routes/activity.js'
import { aiRouter } from './routes/aiRoutes.js'
import { collab } from './collab/instance.js'
import { aiEnabled } from './ai.js'
import { metrics, metricsJson, metricsPrometheus } from './metrics.js'

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use('/api', (_req, _res, next) => {
  metrics.httpRequests.inc()
  next()
})

// Monitoring: Prometheus text format + JSON (the /status page in the app reads the JSON).
app.get('/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(metricsPrometheus()))
app.get('/api/metrics', async (_req, res) => res.json({ instances: await collab.clusterMetrics(metricsJson()) }))
setInterval(() => collab.reportMetrics(metricsJson()), 2000).unref()

app.get('/api/health', (_req, res) => res.json({ ok: true, ...collab.stats() }))
app.use('/api/auth', authRouter)
// Mounted before the routers below: those apply requireAuth to everything under /api,
// but <img> tags fetch /api/uploads/:id without an auth header.
app.use('/api', uploadsRouter)
app.use('/api/docs', docsRouter)
app.use('/api', sharingRouter)
app.use('/api', versionsRouter)
app.use('/api', searchRouter)
app.use('/api', exportRouter)
app.use('/api', activityRouter)
app.use('/api', aiRouter)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))

// In production, serve the built React app from the same port.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'Something went wrong on the server' })
})

const server = http.createServer(app)
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws/')) collab.handleUpgrade(req, socket, head)
  else socket.destroy()
})

async function main() {
  try {
    await migrate()
  } catch (e) {
    console.error(`\nCould not connect to Postgres at ${config.databaseUrl}.`)
    console.error('Is it running? (docker compose up -d)  Error:', (e as Error).message, '\n')
    process.exit(1)
  }
  server.listen(config.port, () => {
    console.log(`[${config.instanceId}] listening on http://localhost:${config.port}`)
    const envFile = path.resolve(process.cwd(), '.env')
    if (aiEnabled()) {
      console.log(`[ai] enabled: ${config.aiProvider} · model ${config.aiModel} · ${config.aiBaseUrl}`)
    } else {
      console.log(
        `[ai] disabled: AI_API_KEY is empty. ` +
          (fs.existsSync(envFile) ? `Add your key to ${envFile}` : `No ${envFile} found: copy .env.example to .env and add your key`) +
          ', then restart.',
      )
    }
  })
}

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  console.log(`[${config.instanceId}] shutting down, flushing documents...`)
  server.close()
  await collab.shutdown()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main()
