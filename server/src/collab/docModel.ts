import * as Y from 'yjs'

/**
 * A plain, typed view of the collaborative document.
 * The editor stores content as a Y.XmlFragment that mirrors ProseMirror's node tree
 * (paragraph, heading, bulletList > listItem > paragraph, table > tableRow > tableCell ...).
 * Everything server-side that needs to *read* a document (version diffs, search indexing,
 * AI prompts, Markdown / .docx export, @mention detection) goes through this module.
 */

/** Name of the Y.XmlFragment the editor (TipTap Collaboration extension) binds to. */
export const FRAGMENT = 'content'

export interface Marks {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  code?: boolean
  link?: string
}

export type Inline =
  | { type: 'text'; text: string; marks: Marks }
  | { type: 'mention'; id: string; label: string }
  | { type: 'hardBreak' }

export type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'heading'; level: number; content: Inline[] }
  | { type: 'codeBlock'; language: string | null; text: string }
  | { type: 'bulletList'; items: Block[][] }
  | { type: 'orderedList'; start: number; items: Block[][] }
  | { type: 'taskList'; items: { checked: boolean; blocks: Block[] }[] }
  | { type: 'blockquote'; blocks: Block[] }
  | { type: 'horizontalRule' }
  | { type: 'image'; src: string; alt: string | null }
  | { type: 'table'; rows: { cells: { header: boolean; blocks: Block[] }[] }[] }

type YNode = Y.XmlElement | Y.XmlText | Y.XmlHook

const children = (el: Y.XmlElement | Y.XmlFragment) => el.toArray() as YNode[]
const attr = (el: Y.XmlElement, name: string) => el.getAttribute(name) as unknown

function marksOf(attrs: Record<string, unknown> | undefined): Marks {
  if (!attrs) return {}
  const m: Marks = {}
  if (attrs.bold) m.bold = true
  if (attrs.italic) m.italic = true
  if (attrs.strike) m.strike = true
  if (attrs.underline) m.underline = true
  if (attrs.code) m.code = true
  const link = attrs.link as { href?: string } | undefined
  if (link?.href) m.link = link.href
  return m
}

function readInline(el: Y.XmlElement): Inline[] {
  const out: Inline[] = []
  for (const c of children(el)) {
    if (c instanceof Y.XmlText) {
      for (const d of c.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof d.insert === 'string') out.push({ type: 'text', text: d.insert, marks: marksOf(d.attributes) })
      }
    } else if (c instanceof Y.XmlElement) {
      if (c.nodeName === 'hardBreak') out.push({ type: 'hardBreak' })
      else if (c.nodeName === 'mention') {
        out.push({ type: 'mention', id: String(attr(c, 'id') ?? ''), label: String(attr(c, 'label') ?? attr(c, 'id') ?? '') })
      } else out.push(...readInline(c))
    }
  }
  return out
}

function textContent(el: Y.XmlElement): string {
  return readInline(el)
    .map((i) => (i.type === 'text' ? i.text : i.type === 'hardBreak' ? '\n' : `@${i.label}`))
    .join('')
}

function readBlock(node: YNode): Block[] {
  if (node instanceof Y.XmlText) {
    const text = node.toString()
    return text ? [{ type: 'paragraph', content: [{ type: 'text', text, marks: {} }] }] : []
  }
  if (!(node instanceof Y.XmlElement)) return []
  switch (node.nodeName) {
    case 'paragraph':
      return [{ type: 'paragraph', content: readInline(node) }]
    case 'heading':
      return [{ type: 'heading', level: Number(attr(node, 'level') ?? 1), content: readInline(node) }]
    case 'codeBlock':
      return [{ type: 'codeBlock', language: (attr(node, 'language') as string) || null, text: textContent(node) }]
    case 'bulletList':
      return [{ type: 'bulletList', items: children(node).map((li) => readBlocks(li as Y.XmlElement)) }]
    case 'orderedList':
      return [
        {
          type: 'orderedList',
          start: Number(attr(node, 'start') ?? 1),
          items: children(node).map((li) => readBlocks(li as Y.XmlElement)),
        },
      ]
    case 'taskList':
      return [
        {
          type: 'taskList',
          items: children(node).map((li) => ({
            checked: [true, 'true'].includes(attr(li as Y.XmlElement, 'checked') as string | boolean),
            blocks: readBlocks(li as Y.XmlElement),
          })),
        },
      ]
    case 'blockquote':
      return [{ type: 'blockquote', blocks: readBlocks(node) }]
    case 'horizontalRule':
      return [{ type: 'horizontalRule' }]
    case 'image':
      return [{ type: 'image', src: String(attr(node, 'src') ?? ''), alt: (attr(node, 'alt') as string) ?? null }]
    case 'table':
      return [
        {
          type: 'table',
          rows: children(node).map((row) => ({
            cells: children(row as Y.XmlElement).map((cell) => ({
              header: (cell as Y.XmlElement).nodeName === 'tableHeader',
              blocks: readBlocks(cell as Y.XmlElement),
            })),
          })),
        },
      ]
    default:
      return readBlocks(node)
  }
}

function readBlocks(el: Y.XmlElement | Y.XmlFragment): Block[] {
  return children(el).flatMap(readBlock)
}

export function docToBlocks(doc: Y.Doc): Block[] {
  return readBlocks(doc.getXmlFragment(FRAGMENT))
}

export function stateToBlocks(state: Uint8Array): Block[] {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const blocks = docToBlocks(doc)
  doc.destroy()
  return blocks
}

// ------------------------------------------------------------------ plain text lines (diffs, search, AI)

export function inlineText(content: Inline[]) {
  return content.map((i) => (i.type === 'text' ? i.text : i.type === 'hardBreak' ? ' ' : `@${i.label}`)).join('')
}

export function blocksToLines(blocks: Block[], indent = ''): string[] {
  const out: string[] = []
  const nested = (bs: Block[], first: string, rest: string) =>
    blocksToLines(bs).forEach((l, j) => out.push(indent + (j === 0 ? first : rest) + l))
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        out.push(indent + inlineText(b.content))
        break
      case 'heading':
        out.push(`${indent}${'#'.repeat(b.level)} ${inlineText(b.content)}`)
        break
      case 'codeBlock':
        out.push(indent + '```' + (b.language ?? ''))
        for (const line of b.text.split('\n')) out.push(indent + line)
        out.push(indent + '```')
        break
      case 'bulletList':
        b.items.forEach((item) => nested(item, '- ', '   '))
        break
      case 'orderedList':
        b.items.forEach((item, i) => nested(item, `${b.start + i}. `, '   '))
        break
      case 'taskList':
        b.items.forEach((item) => nested(item.blocks, item.checked ? '[x] ' : '[ ] ', '    '))
        break
      case 'blockquote':
        out.push(...blocksToLines(b.blocks, indent + '> '))
        break
      case 'horizontalRule':
        out.push(indent + '---')
        break
      case 'image':
        out.push(`${indent}[image${b.alt ? `: ${b.alt}` : ''}]`)
        break
      case 'table':
        for (const row of b.rows) {
          out.push(indent + '| ' + row.cells.map((c) => blocksToLines(c.blocks).join(' ')).join(' | ') + ' |')
        }
        break
    }
  }
  return out
}

/** Converts a Yjs document state into plain text lines (used for version diffs). */
export function stateToLines(state: Uint8Array): string[] {
  return blocksToLines(stateToBlocks(state))
}

/** Text used for the full-text search index and AI prompts. */
export function blocksToPlainText(blocks: Block[]): string {
  return blocksToLines(blocks)
    .filter((l) => !/^\s*(>\s*)*```/.test(l)) // code fences
    .map((l) =>
      /^\s*\|.*\|\s*$/.test(l)
        ? l.split('|').map((c) => c.trim()).filter(Boolean).join('  ') // table row -> cell texts
        : l.replace(/^(\s*)(#+ |- |\d+\. |\[[ x]\] |> )+/, '$1'),
    )
    .filter((l) => l.trim())
    .join('\n')
}

// ------------------------------------------------------------------ Markdown

function escapeMd(text: string) {
  return text.replace(/([\\`*_[\]])/g, '\\$1')
}

function inlineToMd(content: Inline[]): string {
  return content
    .map((i) => {
      if (i.type === 'hardBreak') return '  \n'
      if (i.type === 'mention') return `@${i.label}`
      if (!i.text) return ''
      if (i.marks.code) return '`' + i.text + '`'
      // Keep surrounding whitespace outside the markers (`** bold**` is not valid Markdown).
      const [, lead, core, trail] = i.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!
      if (!core) return i.text
      let s = escapeMd(core)
      if (i.marks.bold) s = `**${s}**`
      if (i.marks.italic) s = `*${s}*`
      if (i.marks.strike) s = `~~${s}~~`
      if (i.marks.link) s = `[${s}](${i.marks.link})`
      return lead + s + trail
    })
    .join('')
}

function blocksToMdLines(blocks: Block[]): string[] {
  const out: string[] = []
  const push = (...lines: string[]) => {
    if (out.length && out[out.length - 1] !== '') out.push('')
    out.push(...lines)
  }
  const indentItem = (lines: string[], marker: string) =>
    lines.map((l, j) => (j === 0 ? marker + l : l === '' ? '' : ' '.repeat(marker.length) + l))

  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        push(inlineToMd(b.content))
        break
      case 'heading':
        push(`${'#'.repeat(Math.min(6, b.level))} ${inlineToMd(b.content)}`)
        break
      case 'codeBlock':
        push('```' + (b.language ?? ''), ...b.text.split('\n'), '```')
        break
      case 'bulletList':
        push(...b.items.flatMap((item) => indentItem(tight(blocksToMdLines(item)), '- ')))
        break
      case 'orderedList':
        push(...b.items.flatMap((item, i) => indentItem(tight(blocksToMdLines(item)), `${b.start + i}. `)))
        break
      case 'taskList':
        push(...b.items.flatMap((item) => indentItem(tight(blocksToMdLines(item.blocks)), item.checked ? '- [x] ' : '- [ ] ')))
        break
      case 'blockquote':
        push(...blocksToMdLines(b.blocks).map((l) => (l ? '> ' + l : '>')))
        break
      case 'horizontalRule':
        push('---')
        break
      case 'image':
        push(`![${escapeMd(b.alt ?? '')}](${b.src})`)
        break
      case 'table': {
        if (b.rows.length === 0) break
        const cell = (bs: Block[]) => tight(blocksToMdLines(bs)).join(' ').replace(/\|/g, '\\|')
        const rows = b.rows.map((r) => '| ' + r.cells.map((c) => cell(c.blocks)).join(' | ') + ' |')
        const cols = b.rows[0].cells.length
        push(rows[0], '|' + ' --- |'.repeat(cols), ...rows.slice(1))
        break
      }
    }
  }
  return out
}

/** Drops blank lines between a list item's own paragraphs so lists stay "tight". */
function tight(lines: string[]) {
  return lines.filter((l) => l !== '')
}

export function blocksToMarkdown(blocks: Block[], title?: string): string {
  const lines = blocksToMdLines(blocks)
  return (title ? `# ${title}\n\n` : '') + lines.join('\n') + '\n'
}

// ------------------------------------------------------------------ @mentions

export interface MentionRef {
  /** Stable identity of the mention node in the CRDT (client:clock of its Yjs item). */
  key: string
  /** Yjs client id that created it (maps to the user who typed it). */
  client: number
  userId: string
}

/** Every @mention node in the document, with the Yjs id of the item that created it. */
export function findMentions(doc: Y.Doc): MentionRef[] {
  const out: MentionRef[] = []
  const walk = (el: Y.XmlElement | Y.XmlFragment) => {
    for (const c of el.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue
      if (c.nodeName === 'mention' && c._item) {
        const userId = String(c.getAttribute('id') ?? '')
        if (userId) out.push({ key: `${c._item.id.client}:${c._item.id.clock}`, client: c._item.id.client, userId })
      } else walk(c)
    }
  }
  walk(doc.getXmlFragment(FRAGMENT))
  return out
}
