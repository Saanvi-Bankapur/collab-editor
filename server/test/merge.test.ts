/**
 * Merge-correctness tests for the CRDT layer.
 *
 * The core property (Strong Eventual Consistency): replicas that have received the same
 * set of updates are in the same state, regardless of delivery order, duplication or delay.
 * These tests use the exact document shape the editor produces (a Y.XmlFragment of
 * paragraphs/headings containing Y.XmlText with formatting marks).
 *
 *   npm test -w server
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { FRAGMENT, stateToLines } from '../src/collab/docText.js'

// ------------------------------------------------------------------ helpers

/** Deterministic PRNG (mulberry32) so failing fuzz runs can be replayed from their seed. */
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  }
}

interface Replica {
  doc: Y.Doc
  /** Updates this replica produced, in order. */
  outbox: Uint8Array[]
}

function replica(clientID: number): Replica {
  const doc = new Y.Doc()
  doc.clientID = clientID // fixed ids => deterministic tie-breaking, reproducible tests
  const r: Replica = { doc, outbox: [] }
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') r.outbox.push(u)
  })
  return r
}

const frag = (r: Replica) => r.doc.getXmlFragment(FRAGMENT)

function paragraph(text: string, name = 'paragraph') {
  const p = new Y.XmlElement(name)
  p.insert(0, [new Y.XmlText(text)])
  return p
}

function textAt(r: Replica, i: number) {
  return (frag(r).get(i) as Y.XmlElement).get(0) as Y.XmlText
}

/** Full comparable state: structure + text + formatting of every block. */
function snapshot(r: Replica) {
  return frag(r)
    .toArray()
    .map((n) => {
      const el = n as Y.XmlElement
      return {
        type: el.nodeName,
        attrs: el.getAttributes(),
        content: el.toArray().map((c) => (c instanceof Y.XmlText ? c.toDelta() : (c as Y.XmlElement).toString())),
      }
    })
}

function deliver(to: Replica, updates: Uint8Array[]) {
  for (const u of updates) Y.applyUpdate(to.doc, u, 'remote')
}

/** Full anti-entropy exchange (what the sync protocol does on reconnect). */
function syncAll(rs: Replica[]) {
  for (const a of rs) for (const b of rs) if (a !== b) {
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), 'remote')
  }
}

function assertConverged(rs: Replica[], msg = '') {
  const first = snapshot(rs[0])
  for (const r of rs.slice(1)) assert.deepEqual(snapshot(r), first, `replicas diverged ${msg}`)
  const sv = Buffer.from(Y.encodeStateVector(rs[0].doc)).toString('hex')
  for (const r of rs.slice(1)) {
    assert.equal(Buffer.from(Y.encodeStateVector(r.doc)).toString('hex'), sv, `state vectors differ ${msg}`)
  }
  for (const r of rs) {
    assert.equal(r.doc.store.pendingStructs, null, `replica has undelivered dependencies ${msg}`)
    assert.equal(r.doc.store.pendingDs, null, `replica has pending deletes ${msg}`)
  }
}

/** Two replicas that already share one paragraph with the given text. */
function sharedPair(text: string): [Replica, Replica] {
  const a = replica(1)
  const b = replica(2)
  frag(a).insert(0, [paragraph(text)])
  deliver(b, a.outbox.splice(0))
  return [a, b]
}

// ------------------------------------------------------------------ deterministic scenarios

describe('concurrent edits converge', () => {
  test('two users type at the same position at the same time', () => {
    const [a, b] = sharedPair('Hello world')
    textAt(a, 0).insert(5, ' there')
    textAt(b, 0).insert(5, ' dear')
    deliver(b, a.outbox.splice(0))
    deliver(a, b.outbox.splice(0))
    assertConverged([a, b])
    const t = textAt(a, 0).toString()
    // Both insertions survive intact (no interleaving of characters).
    assert.ok(t === 'Hello there dear world' || t === 'Hello dear there world', t)
  })

  test('result does not depend on delivery order', () => {
    const results = new Set<string>()
    for (const order of ['ab', 'ba']) {
      const [a, b] = sharedPair('abc')
      const c = replica(3)
      deliver(c, [Y.encodeStateAsUpdate(a.doc)]) // c starts with the shared base text
      textAt(a, 0).insert(1, 'X')
      textAt(b, 0).insert(1, 'Y')
      const [first, second] = order === 'ab' ? [a, b] : [b, a]
      deliver(c, first.outbox)
      deliver(c, second.outbox)
      results.add(textAt(c, 0).toString())
    }
    assert.equal(results.size, 1, `different orders gave ${[...results].join(' vs ')}`)
  })

  test('one user deletes a range while another types inside it', () => {
    const [a, b] = sharedPair('The quick brown fox')
    textAt(a, 0).delete(4, 6) // delete "quick "
    textAt(b, 0).insert(7, 'ZZ') // type inside "quick"
    deliver(b, a.outbox.splice(0))
    deliver(a, b.outbox.splice(0))
    assertConverged([a, b])
    // Deleted text stays deleted, the concurrent insertion is preserved.
    assert.equal(textAt(a, 0).toString(), 'The ZZbrown fox')
  })

  test('both users delete overlapping ranges', () => {
    const [a, b] = sharedPair('0123456789')
    textAt(a, 0).delete(2, 5) // 2..6
    textAt(b, 0).delete(4, 5) // 4..8
    deliver(b, a.outbox.splice(0))
    deliver(a, b.outbox.splice(0))
    assertConverged([a, b])
    assert.equal(textAt(a, 0).toString(), '019')
  })

  test('concurrent formatting (bold vs italic on overlapping ranges)', () => {
    const [a, b] = sharedPair('format me please')
    textAt(a, 0).format(0, 9, { bold: {} })
    textAt(b, 0).format(7, 9, { italic: {} })
    deliver(b, a.outbox.splice(0))
    deliver(a, b.outbox.splice(0))
    assertConverged([a, b])
    const delta = textAt(a, 0).toDelta() as { insert: string; attributes?: Record<string, unknown> }[]
    const overlap = delta.find((d) => d.insert.includes('me'))
    assert.ok(overlap?.attributes?.bold && overlap?.attributes?.italic, 'overlap should be bold AND italic')
  })

  test('concurrent conflicting attribute: heading level set to 2 and 3', () => {
    const a = replica(1)
    const b = replica(2)
    frag(a).insert(0, [paragraph('Title', 'heading')])
    ;(frag(a).get(0) as Y.XmlElement).setAttribute('level', '1')
    deliver(b, a.outbox.splice(0))
    ;(frag(a).get(0) as Y.XmlElement).setAttribute('level', '2')
    ;(frag(b).get(0) as Y.XmlElement).setAttribute('level', '3')
    deliver(b, a.outbox.splice(0))
    deliver(a, b.outbox.splice(0))
    assertConverged([a, b]) // last-writer-wins, decided identically everywhere
  })

  test('one user deletes a paragraph while another edits it', () => {
    const a = replica(1)
    const b = replica(2)
    frag(a).insert(0, [paragraph('keep'), paragraph('doomed'), paragraph('also keep')])
    deliver(b, a.outbox.splice(0))
    frag(a).delete(1, 1)
    textAt(b, 1).insert(6, ' but edited')
    deliver(b, a.outbox.splice(0))
    deliver(a, b.outbox.splice(0))
    assertConverged([a, b])
    assert.deepEqual(stateToLines(Y.encodeStateAsUpdate(a.doc)), ['keep', 'also keep'])
  })

  test('both users insert new paragraphs at the top', () => {
    const [a, b] = sharedPair('existing')
    frag(a).insert(0, [paragraph('from A')])
    frag(b).insert(0, [paragraph('from B')])
    deliver(b, a.outbox.splice(0))
    deliver(a, b.outbox.splice(0))
    assertConverged([a, b])
    assert.equal(frag(a).length, 3)
  })
})

describe('network faults', () => {
  test('duplicate delivery is idempotent', () => {
    const [a, b] = sharedPair('dup')
    textAt(a, 0).insert(3, 'licate')
    const u = a.outbox.splice(0)
    deliver(b, u)
    deliver(b, u)
    deliver(b, u)
    assertConverged([a, b])
    assert.equal(textAt(b, 0).toString(), 'duplicate')
  })

  test('out-of-order delivery is buffered until dependencies arrive', () => {
    const a = replica(1)
    const b = replica(2)
    frag(a).insert(0, [paragraph('')])
    for (const ch of 'ordering') textAt(a, 0).insert(textAt(a, 0).length, ch)
    const updates = a.outbox.splice(0)
    // Deliver everything except the first update (which creates the paragraph), reversed.
    deliver(b, updates.slice(1).reverse())
    assert.equal(frag(b).length, 0, 'nothing is visible before the dependency arrives')
    assert.notEqual(b.doc.store.pendingStructs, null)
    deliver(b, updates.slice(0, 1))
    assertConverged([a, b])
    assert.equal(textAt(b, 0).toString(), 'ordering')
  })

  test('long offline divergence merges cleanly', () => {
    const [a, b] = sharedPair('base')
    const rnd = prng(7)
    for (let i = 0; i < 300; i++) {
      for (const r of [a, b]) {
        const t = textAt(r, 0)
        if (t.length > 0 && rnd.chance(0.3)) t.delete(rnd.int(t.length), 1)
        else t.insert(rnd.int(t.length + 1), rnd.pick(['a', 'b', 'c', ' ']))
      }
    }
    syncAll([a, b])
    assertConverged([a, b])
  })

  test('batched updates (server merges them before writing) equal individual updates', () => {
    const a = replica(1)
    frag(a).insert(0, [paragraph('x')])
    for (let i = 0; i < 50; i++) textAt(a, 0).insert(i % 3, String(i % 10))
    const one = replica(2)
    const batched = replica(3)
    deliver(one, a.outbox)
    deliver(batched, [Y.mergeUpdates(a.outbox)])
    assertConverged([a, one, batched])
  })
})

// ------------------------------------------------------------------ randomized (property-based)

/**
 * Simulates N editors over an unreliable network: random edits (insert/delete/format text,
 * add/delete/retag paragraphs), random delays, reordering, duplication and partitions.
 * After the network heals and everyone syncs, all replicas must be identical.
 */
function fuzz(seed: number, clients = 4, steps = 400) {
  const rnd = prng(seed)
  const rs = Array.from({ length: clients }, (_, i) => replica(i + 1))
  // In-flight messages: [target index, update]
  let network: [number, Uint8Array][] = []

  frag(rs[0]).insert(0, [paragraph('seed text')])
  for (const r of rs.slice(1)) deliver(r, rs[0].outbox)
  rs[0].outbox.length = 0

  for (let step = 0; step < steps; step++) {
    const i = rnd.int(clients)
    const r = rs[i]
    const f = frag(r)
    const op = rnd.int(10)
    if (f.length === 0 || op === 0) {
      f.insert(rnd.int(f.length + 1), [paragraph(rnd.pick(['new', 'para', '']), rnd.pick(['paragraph', 'heading']))])
    } else {
      const block = f.get(rnd.int(f.length)) as Y.XmlElement
      const t = block.get(0) as Y.XmlText | undefined
      if (op === 1 && f.length > 1) f.delete(rnd.int(f.length), 1)
      else if (op === 2) block.setAttribute('level', String(1 + rnd.int(3)))
      else if (t && op === 3 && t.length > 1) {
        const at = rnd.int(t.length - 1)
        t.format(at, 1 + rnd.int(t.length - at - 1), { [rnd.pick(['bold', 'italic', 'code'])]: rnd.chance(0.8) ? {} : null })
      } else if (t && op <= 5 && t.length > 0) t.delete(rnd.int(t.length), 1 + rnd.int(Math.min(3, t.length)))
      else if (t) t.insert(rnd.int(t.length + 1), rnd.pick(['x', 'yz', ' ', 'hello', '!']))
    }
    // Broadcast new updates to everyone else (they land in the network, not delivered yet).
    for (const u of r.outbox.splice(0)) {
      for (let j = 0; j < clients; j++) if (j !== i) {
        network.push([j, u])
        if (rnd.chance(0.1)) network.push([j, u]) // duplicate
      }
    }
    // Deliver a random subset of in-flight messages in random order (reordering + delay).
    const keep: [number, Uint8Array][] = []
    for (const m of network.sort(() => rnd.next() - 0.5)) {
      if (rnd.chance(0.4)) Y.applyUpdate(rs[m[0]].doc, m[1], 'remote')
      else keep.push(m)
    }
    network = keep
    // Occasionally a client drops messages entirely (it will catch up via sync on reconnect).
    if (rnd.chance(0.02)) {
      const victim = rnd.int(clients)
      network = network.filter(([to]) => to !== victim)
    }
  }
  // Sanity: were the replicas actually out of sync before healing? (Otherwise the test proves nothing.)
  const diverged = rs.some((r) => JSON.stringify(snapshot(r)) !== JSON.stringify(snapshot(rs[0])))
  // Heal: deliver what is left, then do a full sync round (as reconnecting clients do).
  for (const [to, u] of network) Y.applyUpdate(rs[to].doc, u, 'remote')
  syncAll(rs)
  return { rs, diverged }
}

describe('randomized convergence (fuzz)', () => {
  const seeds = Number(process.env.FUZZ_SEEDS ?? 25)
  let divergedRuns = 0
  for (let seed = 1; seed <= seeds; seed++) {
    test(`seed ${seed}: 4 clients, 400 ops, reordering + duplicates + drops`, () => {
      const { rs, diverged } = fuzz(seed)
      if (diverged) divergedRuns++
      assert.ok(frag(rs[0]).length > 0, 'document should not be empty')
      assertConverged(rs, `(seed ${seed})`)
      // And a fresh replica built only from one replica's full state agrees too.
      const fresh = replica(99)
      deliver(fresh, [Y.encodeStateAsUpdate(rs[2].doc)])
      assert.deepEqual(snapshot(fresh), snapshot(rs[0]))
    })
  }
  test('sanity: the simulated network really did cause divergence before healing', () => {
    assert.ok(divergedRuns >= seeds * 0.8, `only ${divergedRuns}/${seeds} runs diverged`)
  })
})
