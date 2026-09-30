import { marked } from 'marked'

/**
 * Import converts a file to HTML in the browser; the editor then parses that HTML into the
 * collaborative document (unknown tags/scripts are dropped by the editor's schema).
 */

export const IMPORT_ACCEPT = '.md,.markdown,.txt,.docx,.html,.htm'

export async function fileToHtml(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.docx')) {
    const mammoth = (await import('mammoth/mammoth.browser')) as unknown as {
      convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>
    }
    const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })
    return value
  }
  const text = await file.text()
  if (name.endsWith('.html') || name.endsWith('.htm')) return text
  return markdownToHtml(text)
}

export function markdownToHtml(md: string): string {
  const html = marked.parse(md, { gfm: true, async: false }) as string
  return convertTaskLists(html)
}

/** GFM "- [ ] item" lists become the editor's checklist nodes. */
function convertTaskLists(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('li').forEach((li) => {
    const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]')
    if (!box) return
    const checked = (box as HTMLInputElement).checked
    box.remove()
    li.setAttribute('data-type', 'taskItem')
    li.setAttribute('data-checked', String(checked))
    if (!li.querySelector(':scope > p')) {
      const p = doc.createElement('p')
      while (li.firstChild && !(li.firstChild as Element).matches?.('ul,ol')) p.appendChild(li.firstChild)
      li.prepend(p)
    }
    li.parentElement?.setAttribute('data-type', 'taskList')
  })
  return doc.body.innerHTML
}

export function titleFromFile(file: File) {
  return file.name.replace(/\.(md|markdown|txt|docx|html?)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported document'
}
