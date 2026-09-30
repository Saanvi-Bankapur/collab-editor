import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import { api, initials, type Member } from '../api'

/**
 * @mention suggestions: typing "@" lists the document's members.
 * The popup is plain DOM (no extra UI library); the server notifies whoever is mentioned.
 */

const memberCache = new Map<string, { at: number; members: Promise<Member[]> }>()

function members(docId: string) {
  const hit = memberCache.get(docId)
  if (hit && Date.now() - hit.at < 30_000) return hit.members
  const p = api<{ members: Member[] }>(`/docs/${docId}/members`)
    .then((r) => r.members)
    .catch(() => [] as Member[])
  memberCache.set(docId, { at: Date.now(), members: p })
  return p
}

interface Item {
  id: string
  label: string
  email: string
  color: string
}

export function mentionSuggestion(docId: string): Omit<SuggestionOptions<Item>, 'editor'> {
  return {
    char: '@',
    items: async ({ query }) => {
      const q = query.toLowerCase()
      return (await members(docId))
        .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().startsWith(q))
        .slice(0, 6)
        .map((m) => ({ id: m.id, label: m.name, email: m.email, color: m.color }))
    },
    render: () => {
      let el: HTMLDivElement | null = null
      let props: SuggestionProps<Item> | null = null
      let selected = 0

      const draw = () => {
        if (!el || !props) return
        el.innerHTML = ''
        if (props.items.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'mention-empty'
          empty.textContent = 'No matching members'
          el.appendChild(empty)
        }
        props.items.forEach((item, i) => {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'mention-item' + (i === selected ? ' selected' : '')
          const av = document.createElement('span')
          av.className = 'avatar'
          av.style.cssText = `background:${item.color};width:22px;height:22px;font-size:9px`
          av.textContent = initials(item.label)
          const name = document.createElement('span')
          name.textContent = item.label
          const email = document.createElement('span')
          email.className = 'muted small'
          email.textContent = item.email
          btn.append(av, name, email)
          btn.onmousedown = (e) => e.preventDefault()
          btn.onclick = () => props!.command(item)
          el!.appendChild(btn)
        })
        const rect = props.clientRect?.()
        if (rect) {
          el.style.left = `${rect.left + window.scrollX}px`
          el.style.top = `${rect.bottom + window.scrollY + 4}px`
        }
      }

      return {
        onStart: (p) => {
          props = p
          selected = 0
          el = document.createElement('div')
          el.className = 'mention-popup'
          document.body.appendChild(el)
          draw()
        },
        onUpdate: (p) => {
          props = p
          selected = Math.min(selected, Math.max(0, p.items.length - 1))
          draw()
        },
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          if (!props) return false
          if (event.key === 'ArrowDown') {
            selected = (selected + 1) % Math.max(1, props.items.length)
            draw()
            return true
          }
          if (event.key === 'ArrowUp') {
            selected = (selected - 1 + props.items.length) % Math.max(1, props.items.length)
            draw()
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = props.items[selected]
            if (item) props.command(item)
            return true
          }
          if (event.key === 'Escape') {
            el?.remove()
            el = null
            return true
          }
          return false
        },
        onExit: () => {
          el?.remove()
          el = null
          props = null
        },
      }
    },
  }
}
