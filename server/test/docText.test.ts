import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { FRAGMENT, stateToLines } from '../src/collab/docText.js'

function el(name: string, children: (Y.XmlElement | Y.XmlText)[], attrs: Record<string, string> = {}) {
  const e = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  e.insert(0, children)
  return e
}
const txt = (s: string) => new Y.XmlText(s)
const p = (s: string) => el('paragraph', [txt(s)])

test('version diffs see the document as readable lines', () => {
  const doc = new Y.Doc()
  const bold = txt('bold words')
  doc.getXmlFragment(FRAGMENT).insert(0, [
    el('heading', [txt('Plan')], { level: '2' }),
    el('paragraph', [bold]),
    el('bulletList', [el('listItem', [p('one')]), el('listItem', [p('two')])]),
    el('orderedList', [el('listItem', [p('first')])]),
    el('codeBlock', [txt('let x = 1\nx++')]),
    el('blockquote', [p('quoted')]),
  ])
  bold.format(0, 4, { bold: {} })
  assert.deepEqual(stateToLines(Y.encodeStateAsUpdate(doc)), [
    '## Plan',
    'bold words', // formatting is ignored in the text diff
    '- one',
    '- two',
    '1. first',
    '```',
    'let x = 1',
    'x++',
    '```',
    '> quoted',
  ])
})

test('empty document has no lines', () => {
  assert.deepEqual(stateToLines(Y.encodeStateAsUpdate(new Y.Doc())), [])
})
