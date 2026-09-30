import type { JSONContent } from '@tiptap/react'

/**
 * Real PDF export (a downloaded .pdf file, no print dialog), generated in the browser with pdfmake
 * from the editor's document tree. Loaded lazily so it doesn't slow down the editor.
 */

type Pdf = Record<string, unknown> | string
const PAGE_WIDTH = 515 // A4 width minus default margins, in points

export async function exportPdf(title: string, doc: JSONContent) {
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ])
  pdfMake.addVirtualFileSystem(vfs)
  const images = await loadImages(doc)
  const definition = {
    info: { title, creator: 'CoEdit' },
    pageSize: 'A4',
    pageMargins: [40, 50, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25, color: '#1f2330' },
    footer: (page: number, pages: number) => ({
      text: `${title} · ${page} / ${pages}`,
      alignment: 'center',
      fontSize: 8,
      color: '#9ca3af',
      margin: [0, 20, 0, 0],
    }),
    content: [{ text: title, fontSize: 22, bold: true, margin: [0, 0, 0, 14] }, ...blocks(doc.content ?? [], images)],
  }
  const safeName = (title || 'document').replace(/[\\/:*?"<>|]+/g, '').trim() || 'document'
  await pdfMake.createPdf(definition).download(`${safeName}.pdf`)
}

// ------------------------------------------------------------------ blocks

function blocks(nodes: JSONContent[], images: Map<string, string | null>): Pdf[] {
  return nodes.flatMap((n) => block(n, images))
}

function block(n: JSONContent, images: Map<string, string | null>): Pdf[] {
  const children = n.content ?? []
  switch (n.type) {
    case 'paragraph':
      return [{ text: inline(children).length ? inline(children) : ' ', margin: [0, 0, 0, 6] }]
    case 'heading': {
      const level = Number(n.attrs?.level ?? 1)
      const size = [18, 15, 13, 12, 11, 10.5][level - 1] ?? 12
      return [{ text: inline(children), fontSize: size, bold: true, margin: [0, level === 1 ? 12 : 8, 0, 6] }]
    }
    case 'bulletList':
      return [{ ul: children.map((li) => listItem(li, images)), margin: [0, 0, 0, 6] }]
    case 'orderedList':
      return [{ ol: children.map((li) => listItem(li, images)), start: Number(n.attrs?.start ?? 1), margin: [0, 0, 0, 6] }]
    case 'taskList':
      return [
        {
          stack: children.map((li) => {
            const checked = Boolean(li.attrs?.checked)
            return {
              columns: [
                { width: 18, text: checked ? '[x]' : '[ ]', color: checked ? '#16a34a' : '#6b7280', bold: true },
                { width: '*', stack: blocks(li.content ?? [], images), color: checked ? '#6b7280' : undefined },
              ],
              margin: [0, 0, 0, 2],
            }
          }),
          margin: [0, 0, 0, 6],
        },
      ]
    case 'codeBlock': {
      const code = children.map((c) => c.text ?? '').join('')
      return [
        {
          table: {
            widths: ['*'],
            body: [[{ text: code || ' ', fontSize: 9, preserveLeadingSpaces: true, color: '#e5e7eb', fillColor: '#1e2230' }]],
          },
          layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 8, paddingBottom: () => 8 },
          margin: [0, 2, 0, 8],
        },
      ]
    }
    case 'blockquote':
      return [
        {
          table: { widths: ['*'], body: [[{ stack: blocks(children, images), italics: true, color: '#4b5563' }]] },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
            vLineColor: () => '#c7caff',
            paddingLeft: () => 10,
          },
          margin: [0, 0, 0, 8],
        },
      ]
    case 'horizontalRule':
      return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: PAGE_WIDTH, y2: 0, lineWidth: 0.7, lineColor: '#d0d4de' }], margin: [0, 6, 0, 10] }]
    case 'image': {
      const data = images.get(String(n.attrs?.src ?? ''))
      return data
        ? [{ image: data, fit: [PAGE_WIDTH, 600], margin: [0, 4, 0, 8] }]
        : [{ text: `[image: ${n.attrs?.alt ?? n.attrs?.src}]`, italics: true, color: '#6b7280', margin: [0, 0, 0, 6] }]
    }
    case 'table':
      return [table(n, images)]
    default:
      return children.length ? blocks(children, images) : []
  }
}

function listItem(li: JSONContent, images: Map<string, string | null>): Pdf {
  const inner = blocks(li.content ?? [], images).map((b) =>
    typeof b === 'object' && 'margin' in b ? { ...b, margin: [0, 0, 0, 2] } : b,
  )
  return inner.length === 1 ? inner[0] : { stack: inner }
}

function table(n: JSONContent, images: Map<string, string | null>): Pdf {
  const rows = n.content ?? []
  const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + Number(c.attrs?.colspan ?? 1), 0)))
  const body = rows.map((r) => {
    const cells: Pdf[] = []
    for (const c of r.content ?? []) {
      const span = Number(c.attrs?.colspan ?? 1)
      const header = c.type === 'tableHeader'
      cells.push({
        stack: blocks(c.content ?? [], images),
        colSpan: span > 1 ? span : undefined,
        fillColor: header ? '#eef0f5' : undefined,
        bold: header || undefined,
      })
      for (let i = 1; i < span; i++) cells.push({})
    }
    while (cells.length < cols) cells.push({ text: '' })
    return cells
  })
  const headerRows = rows.length && (rows[0].content ?? []).every((c) => c.type === 'tableHeader') ? 1 : 0
  return {
    table: { headerRows, widths: Array(cols).fill('*'), body },
    layout: {
      hLineWidth: () => 0.6,
      vLineWidth: () => 0.6,
      hLineColor: () => '#d6d9e3',
      vLineColor: () => '#d6d9e3',
      paddingTop: () => 4,
      paddingBottom: () => 2,
    },
    margin: [0, 2, 0, 10],
  }
}

// ------------------------------------------------------------------ inline text

function inline(nodes: JSONContent[]): Pdf[] {
  return nodes.map((n) => {
    if (n.type === 'hardBreak') return '\n'
    if (n.type === 'mention') return { text: `@${n.attrs?.label ?? n.attrs?.id}`, color: '#4f46e5', bold: true }
    const marks = new Set((n.marks ?? []).map((m) => m.type))
    const link = n.marks?.find((m) => m.type === 'link')?.attrs?.href as string | undefined
    const decoration = marks.has('strike') ? 'lineThrough' : marks.has('underline') || link ? 'underline' : undefined
    return {
      text: n.text ?? '',
      bold: marks.has('bold') || undefined,
      italics: marks.has('italic') || undefined,
      decoration,
      background: marks.has('code') ? '#f1f3f8' : undefined,
      color: link ? '#2563eb' : marks.has('code') ? '#b91c1c' : undefined,
      link,
    }
  })
}

// ------------------------------------------------------------------ images

function collectSrcs(n: JSONContent, out: Set<string>) {
  if (n.type === 'image' && n.attrs?.src) out.add(String(n.attrs.src))
  n.content?.forEach((c) => collectSrcs(c, out))
}

/** Converts every image to a PNG data URL (pdfmake needs embedded data; the canvas also handles GIF/WebP/SVG). */
async function loadImages(doc: JSONContent) {
  const srcs = new Set<string>()
  collectSrcs(doc, srcs)
  const out = new Map<string, string | null>()
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.src = src
        await img.decode()
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 1600 / Math.max(img.naturalWidth || 1, 1))
        canvas.width = Math.max(1, Math.round((img.naturalWidth || 300) * scale))
        canvas.height = Math.max(1, Math.round((img.naturalHeight || 150) * scale))
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
        out.set(src, canvas.toDataURL('image/png'))
      } catch {
        out.set(src, null) // blocked by CORS or failed to load: a text placeholder is used
      }
    }),
  )
  return out
}
