import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { FRAGMENT, blocksToMarkdown, blocksToPlainText, docToBlocks, findMentions } from '../src/collab/docModel.js'
import { buildTsQuery } from '../src/searchQuery.js'
import { buildDocx, imageInfo } from '../src/collab/docx.js'

function el(name: string, children: (Y.XmlElement | Y.XmlText)[] = [], attrs: Record<string, unknown> = {}) {
  const e = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string)
  if (children.length) e.insert(0, children)
  return e
}
const p = (...c: (Y.XmlElement | Y.XmlText)[]) => el('paragraph', c)
const t = (s: string) => new Y.XmlText(s)

export function sampleDoc() {
  const doc = new Y.Doc()
  const rich = t('Bold and italic and code and link')
  doc.getXmlFragment(FRAGMENT).insert(0, [
    el('heading', [t('Plan')], { level: 1 }),
    p(rich),
    p(t('Hi '), el('mention', [], { id: 'u1', label: 'Priya' }), t('!')),
    el('bulletList', [el('listItem', [p(t('one')), el('bulletList', [el('listItem', [p(t('nested'))])])]), el('listItem', [p(t('two'))])]),
    el('orderedList', [el('listItem', [p(t('first'))]), el('listItem', [p(t('second'))])], { start: 3 }),
    el('taskList', [el('taskItem', [p(t('done'))], { checked: true }), el('taskItem', [p(t('todo'))], { checked: false })]),
    el('codeBlock', [t('print("hi")\nx = 1')], { language: 'python' }),
    el('blockquote', [p(t('quoted'))]),
    el('table', [
      el('tableRow', [el('tableHeader', [p(t('A'))]), el('tableHeader', [p(t('B|C'))])]),
      el('tableRow', [el('tableCell', [p(t('1'))]), el('tableCell', [p(t('2'))])]),
    ]),
    el('image', [], { src: 'https://example.com/x.png', alt: 'diagram' }),
    el('horizontalRule'),
  ])
  rich.format(0, 4, { bold: {} })
  rich.format(9, 6, { italic: {} })
  rich.format(20, 4, { code: {} })
  rich.format(29, 4, { link: { href: 'https://example.com' } })
  return doc
}

test('markdown export covers every block type and inline mark', () => {
  const md = blocksToMarkdown(docToBlocks(sampleDoc()), 'My doc')
  assert.equal(
    md,
    [
      '# My doc',
      '',
      '# Plan',
      '',
      '**Bold** and *italic* and `code` and [link](https://example.com)',
      '',
      'Hi @Priya!',
      '',
      '- one',
      '  - nested',
      '- two',
      '',
      '3. first',
      '4. second',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '```python',
      'print("hi")',
      'x = 1',
      '```',
      '',
      '> quoted',
      '',
      '| A | B\\|C |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '![diagram](https://example.com/x.png)',
      '',
      '---',
      '',
    ].join('\n'),
  )
})

test('plain text for the search index drops list/heading markers', () => {
  const text = blocksToPlainText(docToBlocks(sampleDoc()))
  assert.ok(text.includes('Plan\n'))
  assert.ok(text.includes('nested'))
  assert.ok(text.includes('done'))
  assert.ok(!text.includes('- [x]'))
})

test('mentions are found with a stable CRDT identity', () => {
  const doc = sampleDoc()
  const m = findMentions(doc)
  assert.equal(m.length, 1)
  assert.equal(m[0].userId, 'u1')
  assert.equal(m[0].client, doc.clientID)
  // The same mention seen by another replica has the same key.
  const other = new Y.Doc()
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
  assert.equal(findMentions(other)[0].key, m[0].key)
})

test('search query builder: prefix search while typing, web syntax for power users', () => {
  assert.deepEqual(buildTsQuery('coll edit'), { sql: "to_tsquery('english', $2)", param: 'coll:* & edit:*' })
  assert.equal(buildTsQuery('"exact phrase" -draft')?.sql, "websearch_to_tsquery('english', $2)")
  assert.equal(buildTsQuery('   '), null)
  // Hostile input is only ever passed as a bound parameter, never spliced into SQL.
  assert.equal(buildTsQuery("'; DROP TABLE users; --")?.sql.includes('DROP'), false)
  assert.equal(buildTsQuery("'; DROP TABLE users")?.param, 'DROP:* & TABLE:* & users:*') // only words survive
})

test('.docx export produces a valid Word file', async () => {
  const buf = await buildDocx('My doc', docToBlocks(sampleDoc()))
  assert.equal(buf.subarray(0, 2).toString(), 'PK')
  assert.ok(buf.includes('word/document.xml'))
})

test('image header parsing (Word needs pixel sizes)', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  assert.deepEqual({ ...imageInfo(png), data: undefined }, { data: undefined, type: 'png', w: 1, h: 1 })
  assert.equal(imageInfo(Buffer.from('not an image')), null)
})
