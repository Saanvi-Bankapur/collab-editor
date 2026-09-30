import { useEffect, useMemo, useState, type FormEvent } from 'react'
import * as Y from 'yjs'
import { api, timeAgo, type DiffLine, type Version } from '../api'
import { Modal } from './Modal'
import { ReadOnlyDoc } from './CollabEditor'
import { Markdownish } from './Markdownish'

const KIND_LABEL: Record<Version['kind'], string> = {
  named: 'Named version',
  auto: 'Auto-save',
  restore: 'Checkpoint',
}

function versionLabel(v: Version) {
  return v.name ?? `Auto-save · ${new Date(v.created_at).toLocaleString()}`
}

export function VersionPanel({ docId, canEdit, aiEnabled, onClose }: {
  docId: string
  canEdit: boolean
  aiEnabled: boolean
  onClose: () => void
}) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [showAuto, setShowAuto] = useState(true)
  const [preview, setPreview] = useState<Version | null>(null)
  const [diff, setDiff] = useState<Version | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setVersions((await api<{ versions: Version[] }>(`/docs/${docId}/versions`)).versions)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  async function save(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      await api(`/docs/${docId}/versions`, { method: 'POST', body: { name } })
      setName('')
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function restore(v: Version) {
    if (!confirm(`Restore "${versionLabel(v)}"? Everyone editing will see the document change. A checkpoint of the current state is saved first, so you can undo this.`)) return
    setBusy(true)
    try {
      await api(`/docs/${docId}/versions/${v.id}/restore`, { method: 'POST' })
      setPreview(null)
      setDiff(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const shown = (versions ?? []).filter((v) => showAuto || v.kind !== 'auto')

  return (
    <aside className="side-panel">
      <div className="side-head">
        <h3>Version history</h3>
        <button className="btn ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {canEdit && (
        <form className="save-version" onSubmit={save}>
          <input placeholder="Name this version, e.g. First draft" value={name} onChange={(e) => setName(e.target.value)} required />
          <button className="btn primary small">Save</button>
        </form>
      )}
      <label className="checkbox small">
        <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} /> Show auto-saves
      </label>
      {error && <div className="error">{error}</div>}
      {versions === null ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="muted small">No versions yet. Versions are auto-saved while you edit, or save a named one above.</p>
      ) : (
        <ol className="timeline">
          {shown.map((v) => (
            <li key={v.id} className={`tl-item tl-${v.kind}`}>
              <span className="tl-dot" />
              <div className="tl-body">
                <div className="tl-title">{v.name ?? 'Auto-save'}</div>
                <div className="muted small">
                  {KIND_LABEL[v.kind]} · {timeAgo(v.created_at)}
                  {v.created_by_name && ` · ${v.created_by_name}`}
                </div>
                <div className="tl-actions">
                  <button className="btn small" onClick={() => setPreview(v)}>
                    View
                  </button>
                  <button className="btn small" onClick={() => setDiff(v)}>
                    Compare
                  </button>
                  {canEdit && (
                    <button className="btn small" disabled={busy} onClick={() => restore(v)}>
                      Restore
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {preview && (
        <VersionPreview
          docId={docId}
          version={preview}
          canEdit={canEdit}
          onRestore={() => restore(preview)}
          onClose={() => setPreview(null)}
        />
      )}
      {diff && (
        <DiffView docId={docId} version={diff} versions={versions ?? []} aiEnabled={aiEnabled} onClose={() => setDiff(null)} />
      )}
    </aside>
  )
}

function VersionPreview({ docId, version, canEdit, onRestore, onClose }: {
  docId: string
  version: Version
  canEdit: boolean
  onRestore: () => void
  onClose: () => void
}) {
  const [state, setState] = useState<Uint8Array | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<{ version: { state: string } }>(`/docs/${docId}/versions/${version.id}`)
      .then((r) => setState(Uint8Array.from(atob(r.version.state), (c) => c.charCodeAt(0))))
      .catch((e) => setError(e.message))
  }, [docId, version.id])
  const ydoc = useMemo(() => {
    if (!state) return null
    const d = new Y.Doc()
    Y.applyUpdate(d, state)
    return d
  }, [state])
  useEffect(() => () => ydoc?.destroy(), [ydoc])

  return (
    <Modal title={versionLabel(version)} onClose={onClose} wide>
      {error && <div className="error">{error}</div>}
      <div className="paper preview">{ydoc ? <ReadOnlyDoc ydoc={ydoc} /> : <p className="muted">Loading…</p>}</div>
      {canEdit && (
        <div className="modal-foot">
          <button className="btn primary" onClick={onRestore}>
            Restore this version
          </button>
        </div>
      )}
    </Modal>
  )
}

function DiffView({ docId, version, versions, aiEnabled, onClose }: {
  docId: string
  version: Version
  versions: Version[]
  aiEnabled: boolean
  onClose: () => void
}) {
  const [against, setAgainst] = useState('current')
  const [data, setData] = useState<{ lines: DiffLine[]; added: number; removed: number } | null>(null)
  const [error, setError] = useState('')
  const [explanation, setExplanation] = useState<{ text: string | null; error: string } | null>(null)

  async function explain() {
    setExplanation({ text: null, error: '' })
    try {
      const r = await api<{ explanation: string }>(`/docs/${docId}/versions/${version.id}/explain`, {
        method: 'POST',
        body: { against },
      })
      setExplanation({ text: r.explanation, error: '' })
    } catch (e) {
      setExplanation({ text: null, error: (e as Error).message })
    }
  }

  useEffect(() => {
    setExplanation(null)
    setData(null)
    api<{ lines: DiffLine[]; added: number; removed: number }>(
      `/docs/${docId}/versions/${version.id}/diff?against=${encodeURIComponent(against)}`,
    )
      .then(setData)
      .catch((e) => setError(e.message))
  }, [docId, version.id, against])

  return (
    <Modal title="Compare versions" onClose={onClose} wide>
      <div className="diff-controls">
        <span>
          From <b>{versionLabel(version)}</b> to
        </span>
        <select value={against} onChange={(e) => setAgainst(e.target.value)}>
          <option value="current">Current document</option>
          {versions
            .filter((v) => v.id !== version.id)
            .map((v) => (
              <option key={v.id} value={v.id}>
                {versionLabel(v)}
              </option>
            ))}
        </select>
        {data && (
          <span className="diff-stats">
            <span className="add">+{data.added}</span> <span className="del">−{data.removed}</span>
          </span>
        )}
        {aiEnabled && data && data.added + data.removed > 0 && (
          <button className="btn small" onClick={explain} disabled={explanation?.text === null && !explanation?.error}>
            ✨ Explain this change
          </button>
        )}
      </div>
      {explanation && (
        <div className="ai-explain">
          {explanation.error ? (
            <span className="error-text">{explanation.error}</span>
          ) : explanation.text === null ? (
            <span className="muted">Reading the diff…</span>
          ) : (
            <Markdownish text={explanation.text} />
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {!data ? (
        <p className="muted">Computing diff…</p>
      ) : data.added + data.removed === 0 ? (
        <p className="muted">No differences.</p>
      ) : (
        <pre className="diff">
          {data.lines.map((l, i) => (
            <div key={i} className={`diff-line ${l.type}`}>
              <span className="diff-sign">{l.type === 'added' ? '+' : l.type === 'removed' ? '−' : ' '}</span>
              {l.text || ' '}
            </div>
          ))}
        </pre>
      )}
    </Modal>
  )
}
