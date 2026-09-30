import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, pendingContent, ROLE_LABEL, timeAgo, type Activity, type DocSummary } from '../api'
import { useAuth } from '../auth'
import { Header } from '../components/Header'
import { ActivityList } from '../components/ActivityList'
import { Modal } from '../components/Modal'
import { SearchBox } from '../components/SearchBox'
import { TEMPLATES, type Template } from '../lib/templates'
import { IMPORT_ACCEPT, fileToHtml, titleFromFile } from '../lib/importers'

export function Dashboard() {
  const { user } = useAuth()
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'all' | 'mine' | 'shared'>('all')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [activity, setActivity] = useState<Activity[] | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)
  const [busy, setBusy] = useState('')
  const importInput = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  async function load() {
    try {
      const r = await api<{ documents: DocSummary[] }>('/docs')
      setDocs(r.documents)
      setError('')
    } catch (e) {
      setError((e as Error).message)
      setDocs((d) => d ?? [])
    }
  }

  useEffect(() => {
    load()
    api<{ activities: Activity[] }>('/activity')
      .then((r) => setActivity(r.activities))
      .catch(() => setActivity([]))
  }, [])

  /** Creates a doc; template/import content is handed to the editor, which inserts it after syncing. */
  async function createDoc(title: string, html: string, source?: string) {
    try {
      const r = await api<{ document: DocSummary }>('/docs', { method: 'POST', body: { title, source } })
      if (html.trim()) pendingContent.set(r.document.id, html)
      navigate(`/d/${r.document.id}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const create = () => setShowTemplates(true)

  function pickTemplate(t: Template) {
    setShowTemplates(false)
    createDoc(t.title(), t.html(), t.id === 'blank' ? undefined : `template:${t.name}`)
  }

  async function importFile(file: File) {
    setBusy(`Importing ${file.name}…`)
    try {
      const html = await fileToHtml(file)
      await createDoc(titleFromFile(file), html, `import:${file.name}`)
    } catch (e) {
      setError(`Could not import ${file.name}: ${(e as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  async function rename(id: string) {
    const title = draft.trim()
    setRenaming(null)
    if (!title) return
    try {
      await api(`/docs/${id}`, { method: 'PATCH', body: { title } })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(d: DocSummary) {
    if (!confirm(`Delete "${d.title}" for everyone? This can't be undone.`)) return
    try {
      await api(`/docs/${d.id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const shown = (docs ?? []).filter((d) =>
    filter === 'all' ? true : filter === 'mine' ? d.role === 'owner' : d.role !== 'owner',
  )

  return (
    <>
      <Header />
      <main className="dashboard wide">
        <div className="dash-grid">
        <div className="dash-main">
        <div className="dash-top">
          <div>
            <h1>My documents</h1>
            <p className="muted">Hi {user?.name}. Everything you own or that's been shared with you.</p>
          </div>
          <div className="dash-actions">
            <button className="btn" onClick={() => importInput.current?.click()} title="Markdown, Word (.docx), HTML or text">
              ⇪ Import
            </button>
            <input
              ref={importInput}
              type="file"
              accept={IMPORT_ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) importFile(f)
              }}
            />
            <button className="btn primary" onClick={create}>
              + New document
            </button>
          </div>
        </div>
        <SearchBox />
        {busy && <p className="muted">{busy}</p>}
        <div className="tabs inline">
          {(['all', 'mine', 'shared'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'mine' ? 'Owned by me' : 'Shared with me'}
            </button>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        {docs === null ? (
          <p className="muted">Loading…</p>
        ) : shown.length === 0 ? (
          <div className="empty">
            <p>No documents here yet.</p>
            {filter !== 'shared' && (
              <button className="btn primary" onClick={create}>
                Create your first document
              </button>
            )}
          </div>
        ) : (
          <table className="doc-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Owner</th>
                <th>Your access</th>
                <th>Last edited</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id}>
                  <td>
                    {renaming === d.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => rename(d.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') rename(d.id)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                      />
                    ) : (
                      <Link to={`/d/${d.id}`} className="doc-link">
                        <span className="doc-icon">▤</span> {d.title}
                      </Link>
                    )}
                  </td>
                  <td>{d.owner_id === user?.id ? 'me' : d.owner_name}</td>
                  <td>
                    <span className={`role-badge role-${d.role}`}>{ROLE_LABEL[d.role]}</span>
                  </td>
                  <td className="muted">{timeAgo(d.updated_at)}</td>
                  <td className="row-actions">
                    {(d.role === 'owner' || d.role === 'editor') && (
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          setDraft(d.title)
                          setRenaming(d.id)
                        }}
                      >
                        Rename
                      </button>
                    )}
                    {d.role === 'owner' && (
                      <button className="btn ghost small danger" onClick={() => remove(d)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </div>
        <aside className="dash-side">
          <h3>Recent activity</h3>
          {activity === null ? <p className="muted small">Loading…</p> : <ActivityList items={activity} showDoc />}
        </aside>
        </div>
        {showTemplates && (
          <Modal title="New document" onClose={() => setShowTemplates(false)} wide>
            <div className="template-grid">
              {TEMPLATES.map((t) => (
                <button key={t.id} className="template-card" onClick={() => pickTemplate(t)}>
                  <span className="template-icon">{t.icon}</span>
                  <b>{t.name}</b>
                  <span className="muted small">{t.description}</span>
                </button>
              ))}
            </div>
          </Modal>
        )}
      </main>
    </>
  )
}
