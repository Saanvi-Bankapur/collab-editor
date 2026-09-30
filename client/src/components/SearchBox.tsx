import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, ROLE_LABEL, timeAgo, type SearchResult } from '../api'

interface SearchResponse {
  results: SearchResult[]
  tookMs?: number
  markers?: { start: string; end: string }
}

/** Full-text search across all your docs (Postgres tsvector + GIN index, ranked, with highlighted snippets). */
export function SearchBox() {
  const [q, setQ] = useState('')
  const [data, setData] = useState<SearchResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!q.trim()) {
      setData(null)
      return
    }
    const t = setTimeout(() => {
      api<SearchResponse>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setData(r)
          setError('')
        })
        .catch((e) => setError(e.message))
    }, 200) // debounce while typing
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="search">
      <input
        type="search"
        className="search-input"
        placeholder='Search all your documents… (try "exact phrase", OR, -exclude)'
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search documents"
      />
      {error && <div className="error">{error}</div>}
      {data && (
        <div className="search-results">
          <div className="muted tiny">
            {data.results.length} result{data.results.length === 1 ? '' : 's'}
            {data.tookMs !== undefined && ` · ${data.tookMs} ms`}
          </div>
          {data.results.length === 0 && <p className="muted small">No documents match.</p>}
          {data.results.map((r) => (
            <Link key={r.id} to={`/d/${r.id}`} className="search-hit">
              <div className="search-title">{highlight(r.title_hl, data.markers)}</div>
              {r.snippet && <div className="search-snippet small">{highlight(r.snippet, data.markers)}</div>}
              <div className="muted tiny">
                {ROLE_LABEL[r.role]} · edited {timeAgo(r.updated_at)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

/** Turns the server's match markers into <mark> elements (text is never injected as HTML). */
function highlight(text: string, markers?: { start: string; end: string }): ReactNode[] {
  if (!markers) return [text]
  const out: ReactNode[] = []
  let rest = text
  let key = 0
  while (rest) {
    const s = rest.indexOf(markers.start)
    if (s < 0) {
      out.push(rest)
      break
    }
    const e = rest.indexOf(markers.end, s)
    if (e < 0) {
      out.push(rest.replace(markers.start, ''))
      break
    }
    out.push(rest.slice(0, s))
    out.push(<mark key={key++}>{rest.slice(s + markers.start.length, e)}</mark>)
    rest = rest.slice(e + markers.end.length)
  }
  return out
}
