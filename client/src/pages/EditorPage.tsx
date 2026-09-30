import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Editor } from '@tiptap/react'
import { api, ApiError, session, downloadFile, getAiStatus, pendingContent, ROLE_LABEL, type Activity, type GuestSession, type Role } from '../api'
import { useAuth } from '../auth'
import { Header } from '../components/Header'
import { Avatar } from '../components/Avatar'
import { CollabEditor, FRAGMENT } from '../components/CollabEditor'
import { ShareDialog } from '../components/ShareDialog'
import { VersionPanel } from '../components/VersionPanel'
import { ActivityList } from '../components/ActivityList'
import { Modal } from '../components/Modal'
import { Markdownish } from '../components/Markdownish'
import { useCollab, usePresence, type CollabStatus } from '../collab/useCollab'

interface DocMeta {
  id: string
  title: string
  role: Role
  owner_name: string
}

const metaKey = (id: string) => `coedit.doc.${session.user?.id ?? 'anon'}.${id}`

/**
 * The document editor. With `guest` set (someone who opened a share link without an account) it shows
 * only this document: no dashboard, sharing, history, activity or AI, and nothing about anyone's account.
 */
export function EditorPage({ guest, onGuestExpired, signInState }: {
  guest?: GuestSession
  onGuestExpired?: () => void
  signInState?: { from: string }
} = {}) {
  const params = useParams()
  const docId = guest?.docId ?? params.docId ?? ''
  const { user: signedInUser } = useAuth()
  const user = guest?.user ?? signedInUser
  const navigate = useNavigate()
  const [meta, setMeta] = useState<DocMeta | null>(() => {
    if (guest) return { id: guest.docId, title: guest.title, role: guest.role, owner_name: guest.ownerName }
    try {
      return JSON.parse(localStorage.getItem(metaKey(docId)) ?? 'null')
    } catch {
      return null
    }
  })
  const [loadError, setLoadError] = useState('')
  const [title, setTitle] = useState(meta?.title ?? '')
  const [showShare, setShowShare] = useState(false)
  const [panel, setPanel] = useState<'history' | 'activity' | null>(null)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [summary, setSummary] = useState<{ text: string | null; error: string } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const editorRef = useRef<Editor | null>(null)

  const collab = useCollab(docId, user!, guest?.token)
  const presence = usePresence(collab.session?.provider, user!)

  useEffect(() => {
    if (!guest) getAiStatus().then((s) => setAiEnabled(s.enabled))
  }, [guest])

  // Document metadata (cached so the editor still opens offline).
  useEffect(() => {
    if (guest) return
    api<{ document: DocMeta }>(`/docs/${docId}`)
      .then((r) => {
        setMeta(r.document)
        setTitle(r.document.title)
        localStorage.setItem(metaKey(docId), JSON.stringify(r.document))
      })
      .catch((e: ApiError) => {
        if (e.status === 404 || e.status === 403) setLoadError(e.message)
      })
  }, [docId, guest])

  // The title also lives in the shared Y.Doc so renames show up live for everyone.
  useEffect(() => {
    const ymeta = collab.session?.ydoc.getMap<string>('meta')
    if (!ymeta) return
    const sync = () => {
      const t = ymeta.get('title')
      if (t) setTitle(t)
    }
    sync()
    ymeta.observe(sync)
    return () => ymeta.unobserve(sync)
  }, [collab.session])

  // Template / import content: insert it once the doc has synced and is still empty.
  const tryInsertPending = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !collab.synced || !collab.session) return
    const html = pendingContent.take(docId)
    if (html === null) return
    if (collab.session.ydoc.getXmlFragment(FRAGMENT).length > 1 || editor.getText().trim()) return
    if (html.trim()) editor.commands.setContent(html)
  }, [collab.synced, collab.session, docId])
  useEffect(tryInsertPending, [tryInsertPending])
  const insertRef = useRef(tryInsertPending)
  insertRef.current = tryInsertPending
  const onEditorReady = useCallback((e: Editor) => {
    editorRef.current = e
    insertRef.current()
  }, [])

  const role: Role | null = collab.serverRole ?? meta?.role ?? null
  const canEdit = role === 'owner' || role === 'editor'

  async function commitTitle() {
    if (guest) return
    const t = title.trim()
    if (!t || !meta || t === meta.title) return setTitle(meta?.title ?? t)
    collab.session?.ydoc.getMap<string>('meta').set('title', t)
    setMeta({ ...meta, title: t })
    api(`/docs/${docId}`, { method: 'PATCH', body: { title: t } }).catch(() => {})
  }

  async function doExport(kind: 'md' | 'docx' | 'pdf' | 'print') {
    setExportOpen(false)
    if (kind === 'pdf') {
      if (!editorRef.current) return
      setNotice('Creating PDF…')
      try {
        const { exportPdf } = await import('../lib/pdfExport')
        await exportPdf(title || 'Untitled document', editorRef.current.getJSON())
        setNotice('')
      } catch (e) {
        setNotice(`PDF export failed: ${(e as Error).message}`)
      }
      return
    }
    if (kind === 'print') {
      // Alternative: the browser's print dialog (print CSS hides the app chrome).
      const old = document.title
      document.title = title || 'document'
      window.print()
      document.title = old
      return
    }
    try {
      await downloadFile(`/docs/${docId}/export.${kind}`, `${title || 'document'}.${kind}`)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function summarize() {
    setSummary({ text: null, error: '' })
    try {
      const r = await api<{ summary: string }>(`/docs/${docId}/ai/summarize`, { method: 'POST' })
      setSummary({ text: r.summary, error: '' })
    } catch (e) {
      setSummary({ text: null, error: (e as Error).message })
    }
  }

  /** Click someone's avatar to jump to where their cursor is. */
  function jumpTo(name: string) {
    const carets = Array.from(document.querySelectorAll<HTMLElement>('.collaboration-carets__caret'))
    const caret = carets.find((c) => c.querySelector('.collaboration-carets__label')?.textContent === name)
    if (!caret) {
      setNotice(`${name} hasn't placed their cursor in the document yet.`)
      setTimeout(() => setNotice(''), 3000)
      return
    }
    caret.scrollIntoView({ behavior: 'smooth', block: 'center' })
    caret.classList.remove('caret-flash')
    void caret.offsetWidth
    caret.classList.add('caret-flash')
  }

  if (loadError || collab.closedReason) {
    const reason = guest && collab.closedReason?.includes('access') ? 'The owner turned this link off.' : (collab.closedReason ?? loadError)
    return (
      <>
        <Header guest={Boolean(guest)} />
        <main className="center-card">
          <h2>Can't open this document</h2>
          <p>{reason}</p>
          {guest ? (
            collab.closedReason?.includes('expired') && (
              <button className="btn primary" onClick={onGuestExpired}>
                Open it again
              </button>
            )
          ) : (
            <Link to="/">Go to your documents</Link>
          )}
        </main>
      </>
    )
  }

  return (
    <>
      <Header guest={Boolean(guest)}>
        <div className="doc-bar">
          <input
            className="title-input"
            value={title}
            disabled={!canEdit || Boolean(guest)}
            placeholder="Untitled document"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <StatusPill c={collab} />
          {collab.instance && (
            <span className="instance-badge" title="The backend instance this tab's WebSocket is connected to">
              ⛁ {collab.instance}
            </span>
          )}
        </div>
        <div className="doc-actions">
          <div className="presence">
            {presence.map((p) => (
              <button
                key={p.id}
                className="avatar-jump"
                disabled={p.isMe}
                onClick={() => jumpTo(p.name)}
                aria-label={p.isMe ? `${p.name} (you)` : `Jump to ${p.name}'s cursor`}
              >
                <Avatar
                  name={p.name}
                  color={p.color}
                  idle={p.idle}
                  title={`${p.name}${p.isMe ? ' (you)' : ' · click to jump to their cursor'}${p.idle ? ' · idle' : ' · active'}${p.tabs > 1 ? ` · ${p.tabs} tabs` : ''}`}
                />
              </button>
            ))}
          </div>
          {aiEnabled && (
            <button className="btn" onClick={summarize} title="Summarize this document with AI">
              ✨ Summarize
            </button>
          )}
          <div className="dropdown">
            <button className={'btn' + (exportOpen ? ' active' : '')} onClick={() => setExportOpen((v) => !v)}>
              Export ▾
            </button>
            {exportOpen && (
              <div className="menu right">
                {!guest && <button onClick={() => doExport('md')}>Markdown (.md)</button>}
                {!guest && <button onClick={() => doExport('docx')}>Word (.docx)</button>}
                <button onClick={() => doExport('pdf')}>PDF (.pdf)</button>
                <button onClick={() => doExport('print')}>Print…</button>
              </div>
            )}
          </div>
          {!guest && (
            <>
              <button className={'btn' + (panel === 'history' ? ' active' : '')} onClick={() => setPanel((p) => (p === 'history' ? null : 'history'))}>
                History
              </button>
              <button className={'btn' + (panel === 'activity' ? ' active' : '')} onClick={() => setPanel((p) => (p === 'activity' ? null : 'activity'))}>
                Activity
              </button>
              <button className="btn primary" onClick={() => setShowShare(true)} disabled={!meta}>
                Share
              </button>
            </>
          )}
        </div>
      </Header>
      {guest && (
        <div className="guest-banner">
          <span>
            You're a guest (<b>{guest.user.name}</b>) on <b>{guest.ownerName}</b>'s document. The link lets you{' '}
            {guest.role === 'editor' ? 'edit' : 'view'} this document only.
          </span>
          <button className="btn small" onClick={() => navigate('/login', { state: signInState })}>
            Sign in to keep it in your documents
          </button>
        </div>
      )}
      {role && !canEdit && !guest && (
        <div className="banner">
          You have <b>{ROLE_LABEL[role].toLowerCase()}</b> access, so this document is read-only.
        </div>
      )}
      {notice && (
        <div className="banner" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}
      <div className="editor-layout">
        <main className="editor-main">
          <h1 className="print-title">{title}</h1>
          {collab.session ? (
            <CollabEditor
              ydoc={collab.session.ydoc}
              provider={collab.session.provider}
              user={user!}
              editable={canEdit}
              docId={docId}
              aiEnabled={aiEnabled}
              onReady={onEditorReady}
            />
          ) : (
            <p className="muted">Loading…</p>
          )}
        </main>
        {panel === 'history' && (
          <VersionPanel docId={docId} canEdit={canEdit} aiEnabled={aiEnabled} onClose={() => setPanel(null)} />
        )}
        {panel === 'activity' && <ActivityPanel docId={docId} onClose={() => setPanel(null)} />}
      </div>
      {showShare && meta && (
        <ShareDialog
          docId={docId}
          title={title}
          isOwner={role === 'owner'}
          meId={user!.id}
          onClose={() => setShowShare(false)}
        />
      )}
      {summary && (
        <Modal title="✨ Summary" onClose={() => setSummary(null)}>
          {summary.error ? (
            <div className="error">{summary.error}</div>
          ) : summary.text === null ? (
            <p className="muted">Reading the document…</p>
          ) : (
            <Markdownish text={summary.text} />
          )}
          <p className="muted tiny">Generated by AI. Check important details.</p>
        </Modal>
      )}
    </>
  )
}

function ActivityPanel({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [items, setItems] = useState<Activity[] | null>(null)
  useEffect(() => {
    const load = () =>
      api<{ activities: Activity[] }>(`/docs/${docId}/activity`)
        .then((r) => setItems(r.activities))
        .catch(() => setItems((i) => i ?? []))
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [docId])
  return (
    <aside className="side-panel">
      <div className="side-head">
        <h3>Activity</h3>
        <button className="btn ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {items === null ? <p className="muted">Loading…</p> : <ActivityList items={items} />}
    </aside>
  )
}

function StatusPill({ c }: { c: CollabStatus }) {
  if (c.status === 'connected' && c.synced) return <span className="pill ok">● Saved</span>
  if (c.status === 'offline')
    return (
      <span className="pill warn" title="Keep editing: changes are stored in this browser and merge automatically when you reconnect.">
        ● Offline{c.pendingOffline ? ' · changes saved locally' : ''}
      </span>
    )
  return <span className="pill">● {c.pendingOffline ? 'Reconnecting · changes saved locally' : 'Connecting…'}</span>
}
