import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Avatar } from './Avatar'

interface Person {
  id: string
  name: string
  email: string
  color: string
  collaborator: boolean
}

/**
 * "Add people by email" with type-ahead: as you type, CoEdit accounts whose name or email match
 * appear in a dropdown (people you already work with first). Arrow keys + Enter, or click, to pick.
 */
export function PeoplePicker({ docId, value, onChange, onPick }: {
  docId: string
  value: string
  onChange: (v: string) => void
  onPick: (email: string) => void
}) {
  const [people, setPeople] = useState<Person[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      api<{ users: Person[] }>(`/users/search?q=${encodeURIComponent(value)}&docId=${docId}`)
        .then((r) => {
          setPeople(r.users)
          setActive(0)
        })
        .catch(() => setPeople([]))
    }, 120)
    return () => clearTimeout(t)
  }, [value, open, docId])

  useEffect(() => {
    const close = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const choose = (p: Person) => {
    onPick(p.email)
    setOpen(false)
  }

  return (
    <div className="people-picker" ref={boxRef}>
      <input
        type="text"
        placeholder="Add people by name or email"
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-label="Add people by name or email"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (!open || people.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (a + 1) % people.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a - 1 + people.length) % people.length)
          } else if (e.key === 'Enter' && !value.includes('@')) {
            e.preventDefault()
            choose(people[active])
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {open && (
        <div className="people-list" role="listbox">
          {people.length === 0 ? (
            <div className="muted small pad">{value ? 'No CoEdit accounts match.' : 'No other accounts yet.'}</div>
          ) : (
            people.map((p, i) => (
              <button
                type="button"
                key={p.id}
                role="option"
                aria-selected={i === active}
                className={'people-item' + (i === active ? ' active' : '')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
              >
                <Avatar name={p.name} color={p.color} size={28} />
                <span className="people-text">
                  <b>{p.name}</b>
                  <span className="muted small">{p.email}</span>
                </span>
                {p.collaborator && <span className="tiny muted">worked together</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
