import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx'
import { pool } from '../db.js'
import { UUID_RE } from '../access.js'
import type { Block, Inline } from './docModel.js'

/** Builds a Word document from the document model (headings, lists, checklists, code, tables, images). */

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
]
const MONO = 'Consolas'

function runs(content: Inline[], extra: { font?: string; italics?: boolean } = {}): ParagraphChild[] {
  return content.map((i) => {
    if (i.type === 'hardBreak') return new TextRun({ text: '', break: 1 })
    if (i.type === 'mention') return new TextRun({ text: `@${i.label}`, bold: true, color: '4F46E5' })
    const run = new TextRun({
      text: i.text,
      bold: i.marks.bold,
      italics: i.marks.italic || extra.italics,
      strike: i.marks.strike,
      underline: i.marks.underline || i.marks.link ? {} : undefined,
      font: i.marks.code ? MONO : extra.font,
      color: i.marks.link ? '2563EB' : undefined,
      shading: i.marks.code ? { type: ShadingType.CLEAR, fill: 'F1F3F8', color: 'auto' } : undefined,
    })
    return i.marks.link && /^https?:\/\//.test(i.marks.link)
      ? new ExternalHyperlink({ link: i.marks.link, children: [run] })
      : run
  })
}

interface Ctx {
  orderedInstance: number
  images: Map<string, { data: Buffer; type: 'png' | 'jpg' | 'gif'; w: number; h: number } | null>
}

function toParagraphs(
  blocks: Block[],
  ctx: Ctx,
  list?: { kind: 'bullet' | 'ordered' | 'task'; level: number; instance: number; prefix?: string },
  quote = false,
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  const listProps = (first: boolean) => {
    if (!list) return quote ? { indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'C7CAFF', space: 12 } } } : {}
    if (!first || list.kind === 'task') return { indent: { left: 720 * (list.level + 1) - (list.kind === 'task' && first ? 360 : 0) } }
    return list.kind === 'bullet'
      ? { bullet: { level: list.level } }
      : { numbering: { reference: 'ordered', level: list.level, instance: list.instance } }
  }
  let firstInItem = true
  for (const b of blocks) {
    const lp = listProps(firstInItem)
    const prefix = firstInItem && list?.prefix ? [new TextRun({ text: list.prefix })] : []
    switch (b.type) {
      case 'paragraph':
        out.push(new Paragraph({ ...lp, children: [...prefix, ...runs(b.content, { italics: quote })] }))
        break
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[Math.min(5, b.level - 1)], children: runs(b.content) }))
        break
      case 'codeBlock':
        for (const line of b.text.split('\n')) {
          out.push(
            new Paragraph({
              spacing: { before: 0, after: 0 },
              shading: { type: ShadingType.CLEAR, fill: 'F1F3F8', color: 'auto' },
              children: [new TextRun({ text: line || ' ', font: MONO, size: 19 })],
            }),
          )
        }
        break
      case 'bulletList':
        for (const item of b.items) {
          out.push(...toParagraphs(item, ctx, { kind: 'bullet', level: (list?.level ?? -1) + 1, instance: 0 }))
        }
        break
      case 'orderedList': {
        const instance = ++ctx.orderedInstance // restart numbering for every list
        for (const item of b.items) {
          out.push(...toParagraphs(item, ctx, { kind: 'ordered', level: (list?.level ?? -1) + 1, instance }))
        }
        break
      }
      case 'taskList':
        for (const item of b.items) {
          out.push(
            ...toParagraphs(item.blocks, ctx, {
              kind: 'task',
              level: (list?.level ?? -1) + 1,
              instance: 0,
              prefix: item.checked ? '☑  ' : '☐  ',
            }),
          )
        }
        break
      case 'blockquote':
        out.push(...toParagraphs(b.blocks, ctx, undefined, true))
        break
      case 'horizontalRule':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D4DE', space: 4 } }, children: [] }))
        break
      case 'image': {
        const img = ctx.images.get(b.src)
        if (img) {
          const w = Math.min(560, img.w)
          const h = Math.round((img.h / img.w) * w)
          out.push(new Paragraph({ children: [new ImageRun({ type: img.type, data: img.data, transformation: { width: w, height: h } })] }))
        } else {
          out.push(new Paragraph({ children: [new TextRun({ text: `[image: ${b.alt ?? b.src}]`, italics: true, color: '6B7280' })] }))
        }
        break
      }
      case 'table': {
        const cols = Math.max(1, ...b.rows.map((r) => r.cells.length))
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: b.rows.map(
              (r) =>
                new TableRow({
                  children: r.cells.map(
                    (c) =>
                      new TableCell({
                        width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE },
                        shading: c.header ? { type: ShadingType.CLEAR, fill: 'EEF0F5', color: 'auto' } : undefined,
                        children: (() => {
                          const ps = toParagraphs(c.blocks, ctx).filter((p): p is Paragraph => p instanceof Paragraph)
                          return ps.length ? ps : [new Paragraph('')]
                        })(),
                      }),
                  ),
                }),
            ),
          }),
        )
        out.push(new Paragraph(''))
        break
      }
    }
    firstInItem = false
  }
  return out
}

function collectImages(blocks: Block[], into: Set<string>) {
  for (const b of blocks) {
    if (b.type === 'image') into.add(b.src)
    else if (b.type === 'bulletList' || b.type === 'orderedList') b.items.forEach((i) => collectImages(i, into))
    else if (b.type === 'taskList') b.items.forEach((i) => collectImages(i.blocks, into))
    else if (b.type === 'blockquote') collectImages(b.blocks, into)
    else if (b.type === 'table') b.rows.forEach((r) => r.cells.forEach((c) => collectImages(c.blocks, into)))
  }
}

async function loadImage(src: string) {
  let data: Buffer | null = null
  const local = src.match(/\/api\/uploads\/([0-9a-f-]{36})$/i)
  if (local && UUID_RE.test(local[1])) {
    const r = await pool.query<{ data: Buffer }>('SELECT data FROM uploads WHERE id = $1', [local[1]])
    data = r.rows[0]?.data ?? null
  } else if (/^https:\/\//.test(src)) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(5000) })
      if (res.ok && Number(res.headers.get('content-length') ?? 0) < 10_000_000) data = Buffer.from(await res.arrayBuffer())
    } catch {
      /* leave a placeholder */
    }
  }
  return data ? imageInfo(data) : null
}

/** Reads the pixel size from PNG / JPEG / GIF headers (Word needs explicit dimensions). */
export function imageInfo(data: Buffer): { data: Buffer; type: 'png' | 'jpg' | 'gif'; w: number; h: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { data, type: 'png', w: data.readUInt32BE(16), h: data.readUInt32BE(20) }
  }
  if (data.length > 10 && data.toString('ascii', 0, 3) === 'GIF') {
    return { data, type: 'gif', w: data.readUInt16LE(6), h: data.readUInt16LE(8) }
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null
      const marker = data[i + 1]
      const len = data.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { data, type: 'jpg', h: data.readUInt16BE(i + 5), w: data.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
  }
  return null
}

export async function buildDocx(title: string, blocks: Block[]): Promise<Buffer> {
  const srcs = new Set<string>()
  collectImages(blocks, srcs)
  const images = new Map<string, Awaited<ReturnType<typeof loadImage>>>()
  await Promise.all([...srcs].map(async (s) => images.set(s, await loadImage(s))))
  const ctx: Ctx = { orderedInstance: 0, images }

  const doc = new Document({
    creator: 'CoEdit',
    title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [0, 1, 2, 3, 4, 5].map((level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        children: [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }), ...toParagraphs(blocks, ctx)],
      },
    ],
  })
  return Packer.toBuffer(doc)
}
