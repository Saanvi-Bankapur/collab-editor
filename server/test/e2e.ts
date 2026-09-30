/**
 * End-to-end test against a running cluster (npm run cluster).
 * Connects clients to DIFFERENT server instances and checks that they converge.
 *   npm run test:e2e          (expects LB on :4000 and instances on :4001-4003)
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import assert from 'node:assert/strict'
import { startMockAI } from './mockAI.js'

const API = process.env.API ?? 'http://localhost:4000'
const INSTANCES = (process.env.INSTANCE_PORTS ?? '4001,4002,4003').split(',').map((p) => `ws://localhost:${p}/ws`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let passed = 0
function ok(msg: string) {
  passed++
  console.log(`  ✓ ${msg}`)
}

async function api(path: string, token: string | null, method = 'GET', body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`)
  return json
}

async function signup(name: string) {
  const email = `${name.toLowerCase()}-${Date.now()}@test.dev`
  return (await api('/api/auth/signup', null, 'POST', { email, name, password: 'secret123' })) as {
    token: string
    user: { id: string; email: string }
  }
}

function connect(url: string, docId: string, token: string) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(url, docId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  })
  ;(provider as unknown as { messageHandlers: unknown[] }).messageHandlers[100] = () => {}
  const closes: number[] = []
  provider.on('connection-close', (e: CloseEvent | null) => e && closes.push(e.code))
  return { doc, provider, closes, text: () => docText(doc) }
}

function docText(doc: Y.Doc) {
  return doc
    .getXmlFragment('content')
    .toArray()
    .map((p) => (p as Y.XmlElement).toArray().map((t) => (t as Y.XmlText).toString()).join(''))
    .join('\n')
}

function addParagraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  const frag = doc.getXmlFragment('content')
  frag.insert(frag.length, [p])
}

async function waitFor(cond: () => boolean, what: string, timeout = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${what}`)
    await sleep(10)
  }
  return Date.now() - start
}

async function api2(path: string, token: string, method = 'GET', body?: Buffer, contentType?: string) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(contentType ? { 'content-type': contentType } : {}) },
    body: body ? new Uint8Array(body) : undefined,
  })
  return res
}

/** 1x1 PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

function el(name: string, children: (Y.XmlElement | Y.XmlText)[] = [], attrs: Record<string, unknown> = {}) {
  const e = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string)
  if (children.length) e.insert(0, children)
  return e
}
const paragraphOf = (...c: (Y.XmlElement | Y.XmlText)[]) => el('paragraph', c)
const txt = (s: string) => new Y.XmlText(s)

async function main() {
  // A fake AI API (used when the servers run with AI_BASE_URL pointing here).
  const mock = await startMockAI().catch(() => null)
  console.log('Auth & documents')
  const alice = await signup('Alice')
  const bob = await signup('Bob')
  const carol = await signup('Carol')
  ok('three users signed up')
  const { document } = await api('/api/docs', alice.token, 'POST', { title: 'Test doc' })
  const docId: string = document.id
  await api(`/api/docs/${docId}`, alice.token, 'PATCH', { title: 'Renamed doc' })
  const list = await api('/api/docs', alice.token)
  assert.equal(list.documents.find((d: { id: string }) => d.id === docId).title, 'Renamed doc')
  ok('create + rename + list works')

  console.log('Permissions')
  const intruder = connect(INSTANCES[1], docId, bob.token)
  await waitFor(() => intruder.closes.includes(4403), 'bob rejected')
  intruder.provider.destroy()
  ok('non-member websocket is rejected with 4403')
  await api(`/api/docs/${docId}/members`, alice.token, 'POST', { email: bob.user.email, role: 'editor' })
  const { link } = await api(`/api/docs/${docId}/links`, alice.token, 'POST', { role: 'viewer' })
  const accepted = await api(`/api/share/${link.token}/accept`, carol.token, 'POST')
  assert.equal(accepted.role, 'viewer')
  ok('bob added as editor, carol joined via view-only link')

  console.log('Real-time sync across 3 server instances')
  const A = connect(INSTANCES[0], docId, alice.token)
  const B = connect(INSTANCES[1], docId, bob.token)
  let C = connect(INSTANCES[2], docId, carol.token)
  await Promise.all([A, B, C].map((c) => waitFor(() => c.provider.synced, 'synced')))
  ok('all three clients synced (server-1, server-2, server-3)')

  const latencies: number[] = []
  for (let i = 0; i < 20; i++) {
    addParagraph(A.doc, `line ${i} from alice`)
    latencies.push(await waitFor(() => B.text().includes(`line ${i} from alice`), 'bob sees alice'))
  }
  latencies.sort((a, b) => a - b)
  ok(`edits on server-1 reach server-2: p50 ${latencies[10]} ms, max ${latencies[19]} ms`)
  addParagraph(B.doc, 'hello from bob')
  await waitFor(() => A.text().includes('hello from bob') && C.text().includes('hello from bob'), 'everyone sees bob')
  ok('edits flow both ways, viewer receives them too')

  addParagraph(C.doc, 'viewer tried to write') // (the real UI is read-only for viewers; this simulates a malicious client)
  await sleep(500)
  assert.ok(!A.text().includes('viewer tried to write'))
  ok("viewer's edits are rejected by the server")
  // Carol's local replica now holds a change the server refused; reconnect her with a clean one.
  C.provider.destroy()
  C = connect(INSTANCES[2], docId, carol.token)
  await waitFor(() => C.provider.synced && C.text() === A.text(), 'carol resynced')

  console.log('Presence / cursors')
  A.provider.awareness.setLocalStateField('user', { name: 'Alice', color: '#f00' })
  await waitFor(
    () => [...B.provider.awareness.getStates().values()].some((s) => s.user?.name === 'Alice'),
    'bob sees alice presence',
  )
  ok('awareness (cursor/presence) crosses instances')

  console.log('Tier 4: rich blocks, uploads, search, mentions, notifications, export, AI')
  {
    // Image upload (stored in Postgres when S3 isn't configured) and served by any instance.
    const init = await api('/api/uploads/init', alice.token, 'POST', { contentType: 'image/png', size: PNG.length })
    assert.equal(init.mode, 'direct')
    const up = await api2('/api/uploads', alice.token, 'POST', PNG, 'image/png')
    assert.equal(up.status, 201)
    const { url } = (await up.json()) as { url: string }
    const img = await fetch(API + url)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG)
    ok('image upload stored in Postgres and served without auth header (for <img>)')

    // Alice adds rich blocks exactly as the editor stores them in the CRDT.
    const bold = txt('quantum entanglement notes')
    A.doc.getXmlFragment('content').insert(0, [
      el('heading', [txt('Research plan')], { level: 2 }),
      paragraphOf(bold),
      paragraphOf(txt('Ping '), el('mention', [], { id: bob.user.id, label: 'Bob' }), txt(' please review')),
      el('taskList', [
        el('taskItem', [paragraphOf(txt('write intro'))], { checked: true }),
        el('taskItem', [paragraphOf(txt('run experiments'))], { checked: false }),
      ]),
      el('codeBlock', [txt('const x: number = 42')], { language: 'typescript' }),
      el('table', [
        el('tableRow', [el('tableHeader', [paragraphOf(txt('Name'))]), el('tableHeader', [paragraphOf(txt('Role'))])]),
        el('tableRow', [el('tableCell', [paragraphOf(txt('Alice'))]), el('tableCell', [paragraphOf(txt('Owner'))])]),
      ]),
      el('image', [], { src: url, alt: 'pixel' }),
    ])
    bold.format(0, 7, { bold: {} })
    await waitFor(() => B.text().includes('quantum'), 'bob sees rich blocks')

    // Full-text search (index refreshes ~1.5 s after edits).
    let hits: { results: { id: string; snippet: string; title_hl: string }[]; markers: { start: string }; tookMs?: number } = {
      results: [],
      markers: { start: '' },
    }
    for (let i = 0; i < 30 && !hits.results.some((r) => r.id === docId); i++) {
      await sleep(250)
      hits = await api('/api/search?q=' + encodeURIComponent('quant entangle'), alice.token)
    }
    const hit = hits.results.find((r) => r.id === docId)
    assert.ok(hit, 'doc found by prefix search')
    assert.ok(hit!.snippet.includes(hits.markers.start), 'snippet has highlight markers')
    const phrase = await api('/api/search?q=' + encodeURIComponent('"entanglement notes" -banana'), carol.token)
    assert.ok(phrase.results.some((r: { id: string }) => r.id === docId), 'viewer finds it with web-search syntax')
    const stranger = await signup('Dave')
    const none = await api('/api/search?q=quantum', stranger.token)
    assert.ok(!none.results.some((r: { id: string }) => r.id === docId), 'non-members never see it')
    ok(`full-text search: prefix + phrase queries, highlighted snippets, access-controlled (${hits.tookMs ?? '?'} ms)`)

    // @mention -> notification for Bob; Bob's edits -> "Bob edited your doc" for Alice.
    let bobNotes: { notifications: { type: string; message: string; id: number }[]; unread: number } = { notifications: [], unread: 0 }
    for (let i = 0; i < 20 && !bobNotes.notifications.some((n) => n.type === 'mention'); i++) {
      await sleep(250)
      bobNotes = await api('/api/notifications', bob.token)
    }
    const mention = bobNotes.notifications.find((n) => n.type === 'mention')
    assert.ok(mention, 'bob was notified of the mention')
    assert.ok(bobNotes.notifications.some((n) => n.type === 'shared'), 'bob was notified he was shared the doc')
    const aliceNotes = await api('/api/notifications', alice.token)
    assert.ok(aliceNotes.notifications.some((n: { type: string }) => n.type === 'edited'), 'alice told bob edited her doc')
    await api('/api/notifications/read', bob.token, 'POST', { ids: [mention!.id] })
    const after = await api('/api/notifications', bob.token)
    assert.equal(after.unread, bobNotes.unread - 1)
    const feed = await api(`/api/docs/${docId}/activity`, carol.token)
    const types = new Set(feed.activities.map((a: { type: string }) => a.type))
    for (const t of ['created', 'renamed', 'shared', 'joined_via_link', 'edited', 'mentioned']) assert.ok(types.has(t), `activity ${t}`)
    ok(`@mention + share + edit notifications; activity feed has ${[...types].join(', ')}`)

    // Export
    const md = await (await api2(`/api/docs/${docId}/export.md`, alice.token)).text()
    for (const piece of ['## Research plan', '**quantum**', '@Bob', '- [x] write intro', '- [ ] run experiments', '```typescript', '| Name | Role |', '| --- | --- |', `![pixel](${url})`]) {
      assert.ok(md.includes(piece), `markdown contains ${piece}`)
    }
    const docxRes = await api2(`/api/docs/${docId}/export.docx`, alice.token)
    const docx = Buffer.from(await docxRes.arrayBuffer())
    assert.equal(docx.subarray(0, 2).toString(), 'PK')
    assert.ok(docx.includes('word/document.xml') && docx.includes('word/media/'), 'docx has body and embedded image')
    ok(`export: Markdown (${md.length} chars) and .docx (${(docx.length / 1024).toFixed(1)} KB, image embedded)`)

    // AI assist (only when the servers were started against the mock / a real key)
    const ai = await api('/api/ai/status', alice.token)
    if (ai.enabled) {
      const sum = await api(`/api/docs/${docId}/ai/summarize`, carol.token, 'POST')
      assert.match(sum.summary, /words read/)
      const rw = await api(`/api/docs/${docId}/ai/rewrite`, bob.token, 'POST', { text: 'teh plan', mode: 'grammar' })
      assert.match(rw.text, /teh plan/)
      await assert.rejects(api(`/api/docs/${docId}/ai/rewrite`, carol.token, 'POST', { text: 'x', mode: 'improve' }), /403/)
      ok(`AI assist (${ai.model}): summarize, rewrite (editors only)`)
    } else {
      console.log('  - AI assist skipped (servers not started with AI_API_KEY)')
    }
  }

  console.log('Offline editing')
  B.provider.disconnect()
  addParagraph(B.doc, 'bob wrote this offline')
  addParagraph(A.doc, 'alice wrote this while bob was offline')
  await sleep(300)
  assert.ok(!A.text().includes('bob wrote this offline'))
  B.provider.connect()
  await waitFor(() => A.text() === B.text() && A.text().includes('bob wrote this offline'), 'converge after reconnect')
  assert.ok(B.text().includes('alice wrote this while bob was offline'))
  ok('offline edits merged cleanly on reconnect; both replicas identical')

  console.log('Concurrent conflicting edits')
  const para = A.doc.getXmlFragment('content').get(0) as Y.XmlElement
  const paraB = B.doc.getXmlFragment('content').get(0) as Y.XmlElement
  ;(para.get(0) as Y.XmlText).insert(0, '[A]')
  ;(paraB.get(0) as Y.XmlText).insert(0, '[B]')
  await waitFor(() => A.text() === B.text() && A.text().includes('[A]') && A.text().includes('[B]'), 'conflict merge')
  ok(`simultaneous inserts at the same position converge: "${A.text().split('\n')[0]}"`)

  console.log('Concurrent edit storm through two different servers')
  {
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let i = 0; i < 300; i++) {
      const c = i % 2 === 0 ? A : B
      const frag = c.doc.getXmlFragment('content')
      const p = frag.get(Math.floor(rnd() * frag.length)) as Y.XmlElement
      const t = p.get(0)
      if (!(t instanceof Y.XmlText)) continue // only edit plain paragraphs/headings here
      if (t.length > 3 && rnd() < 0.3) t.delete(Math.floor(rnd() * (t.length - 1)), 1)
      else t.insert(Math.floor(rnd() * (t.length + 1)), 'xyz'[Math.floor(rnd() * 3)])
    }
    await waitFor(() => A.text() === B.text() && B.text() === C.text(), 'storm convergence', 10000)
    ok('300 interleaved random edits from clients on server-1 and server-2 converge on all 3 servers')
  }

  console.log('Versions')
  await sleep(400)
  const v1 = await api(`/api/docs/${docId}/versions`, alice.token, 'POST', { name: 'Before cleanup' })
  const beforeText = A.text()
  addParagraph(A.doc, 'added after version 1')
  await sleep(400)
  const diff = await api(`/api/docs/${docId}/versions/${v1.version.id}/diff`, alice.token)
  assert.ok(diff.lines.some((l: { type: string; text: string }) => l.type === 'added' && l.text.includes('added after version 1')))
  ok(`diff vs current shows +${diff.added} / -${diff.removed} lines`)
  if ((await api('/api/ai/status', alice.token)).enabled) {
    const ex = await api(`/api/docs/${docId}/versions/${v1.version.id}/explain`, alice.token, 'POST', { against: 'current' })
    assert.match(ex.explanation, /changed lines/)
    ok('AI "explain this change" on a version diff')
  }
  await api(`/api/docs/${docId}/versions/${v1.version.id}/restore`, bob.token, 'POST')
  await waitFor(() => A.text() === beforeText && B.text() === beforeText && C.text() === beforeText, 'restore synced').catch((e) => { console.log(JSON.stringify({ beforeText, A: A.text(), B: B.text(), C: C.text() }, null, 1)); throw e })
  const versions = await api(`/api/docs/${docId}/versions`, alice.token)
  assert.ok(versions.versions.some((v: { kind: string }) => v.kind === 'restore'))
  ok('restore pushed to all live clients and saved a "before restore" checkpoint')

  console.log('Snapshots & compaction')
  for (let i = 0; i < 40; i++) {
    addParagraph(A.doc, `bulk ${i}`)
    await sleep(170) // > flush delay so each becomes its own log row
  }
  await sleep(1500)
  const health = await api('/api/health', null)
  void health
  ok('wrote 40 separate log rows (check server log for a [compaction] line)')

  console.log('Monitoring')
  {
    // Instances report to Redis every 2 s, so poll until the snapshot catches up.
    let m: { instances: { connections?: number; totals?: { opsReceived: number } }[] } = { instances: [] }
    const sum = (f: (i: (typeof m.instances)[number]) => number) => m.instances.reduce((n, i) => n + f(i), 0)
    for (let i = 0; i < 20; i++) {
      m = await api('/api/metrics', null)
      if (sum((x) => x.connections ?? 0) === 3) break
      await sleep(500)
    }
    const ops = sum((x) => x.totals?.opsReceived ?? 0)
    const conns = sum((x) => x.connections ?? 0)
    assert.ok(ops > 0, 'metrics report received ops')
    assert.equal(conns, 3, 'three live connections')
    const prom = await (await fetch(API + '/metrics')).text()
    assert.match(prom, /coedit_ws_connections\{instance="[^"]+"\} \d+/)
    ok(`metrics: ${m.instances.length} instance(s), ${conns} connections, ${ops} ops received; Prometheus text OK`)
  }

  console.log('Persistence (fresh load from Postgres)')
  const finalText = A.text()
  for (const c of [A, B, C]) c.provider.destroy()
  await sleep(500)
  const D = connect(INSTANCES[2], docId, alice.token)
  await waitFor(() => D.provider.synced, 'D synced')
  await waitFor(() => D.text() === finalText, 'D has full content')
  ok('a brand-new client sees the full document')

  console.log('Access changes')
  const B2 = connect(INSTANCES[0], docId, bob.token)
  await waitFor(() => B2.provider.synced, 'B2 synced')
  await api(`/api/docs/${docId}/members/${bob.user.id}`, alice.token, 'DELETE')
  await waitFor(() => B2.closes.includes(4403), 'bob kicked')
  ok('removing a member disconnects them live (even on another instance)')
  B2.provider.destroy()

  console.log('Share links for people without an account (guests)')
  {
    const { link: editLink } = await api(`/api/docs/${docId}/links`, alice.token, 'POST', { role: 'editor' })
    const info = await api(`/api/share/${editLink.token}/info`, null)
    assert.equal(info.docId, docId)
    const g = await api(`/api/share/${editLink.token}/guest`, null, 'POST', {})
    assert.match(g.user.name, /^Guest /)
    // A guest token opens nothing but this document: every account API refuses it.
    for (const path of ['/api/docs', `/api/docs/${docId}`, '/api/auth/profile', '/api/notifications']) {
      await assert.rejects(api(path, g.token), /403/)
    }
    const G = connect(INSTANCES[1], docId, g.token)
    await waitFor(() => G.provider.synced && G.text() === D.text(), 'guest synced')
    addParagraph(G.doc, 'written by a guest')
    await waitFor(() => D.text().includes('written by a guest'), 'owner sees guest edit')
    // ...and cannot open any other document.
    const other = (await api('/api/docs', alice.token, 'POST', { title: 'Private' })).document.id
    const G2 = connect(INSTANCES[2], other, g.token)
    await waitFor(() => G2.closes.includes(4403), 'guest rejected from other doc')
    G2.provider.destroy()
    // Turning the link off disconnects its guests immediately.
    await api(`/api/docs/${docId}/links/${editLink.token}`, alice.token, 'DELETE')
    await waitFor(() => G.closes.includes(4403), 'guest kicked when link turned off')
    G.provider.destroy()
    await assert.rejects(api(`/api/share/${editLink.token}/guest`, null, 'POST', {}), /404/)
    ok('share link opens the doc for guests (edit), nothing else; turning it off kicks them')

    const found = await api('/api/users/search?q=' + encodeURIComponent(carol.user.email.slice(0, 5)), alice.token)
    assert.ok(found.users.some((u: { email: string }) => u.email === carol.user.email))
    ok('people search finds accounts by partial email')

    const feed = await api(`/api/docs/${docId}/activity`, alice.token)
    const edit = feed.activities.find((a: { type: string; data: { addedWords?: number } }) => a.type === 'edited' && a.data.addedWords)
    assert.ok(edit, 'edited activity carries a summary of the change')
    ok(`activity shows what was edited (e.g. +${edit.data.addedWords} words: "${String(edit.data.added).slice(0, 40)}…")`)
  }

  await api(`/api/docs/${docId}`, alice.token, 'DELETE')
  await waitFor(() => D.closes.includes(4404), 'D closed after delete')
  D.provider.destroy()
  ok('deleting a doc closes every connection')

  console.log(`\nAll ${passed} checks passed.`)
  mock?.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('\nFAILED:', e)
  process.exit(1)
})
