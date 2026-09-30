import { memo, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import Mention from '@tiptap/extension-mention'
import { Placeholder } from '@tiptap/extensions'
import type { EditorView } from '@tiptap/pm/view'
import { createLowlight, common } from 'lowlight'
import type * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { api, escapeHtml, uploadImage, type User } from '../api'
import { mentionSuggestion } from '../lib/mentions'
import { Modal } from './Modal'

/** Name of the shared Y.XmlFragment. The server uses the same name for diffs, search and export. */
export const FRAGMENT = 'content'

const lowlight = createLowlight(common)

export const LANGUAGES: [string, string][] = [
  ['', 'Plain text'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['json', 'JSON'],
  ['bash', 'Bash'],
  ['xml', 'HTML / XML'],
  ['css', 'CSS'],
  ['yaml', 'YAML'],
  ['markdown', 'Markdown'],
]

/** Extensions shared by the live editor and read-only previews (same schema = same rendering). */
export function contentExtensions() {
  return [
    StarterKit.configure({ undoRedo: false, codeBlock: false, link: { openOnClick: false, autolink: true } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ allowBase64: false }),
  ]
}

/** Memoized: the editor must not re-render when unrelated page state (presence, menus…) changes. */
export const CollabEditor = memo(function CollabEditor({ ydoc, provider, user, editable, docId, aiEnabled, onReady }: {
  ydoc: Y.Doc
  provider: WebsocketProvider
  user: User
  editable: boolean
  docId: string
  aiEnabled: boolean
  onReady?: (editor: Editor) => void
}) {
  const [uploadError, setUploadError] = useState('')
  const editor = useEditor(
    {
      extensions: [
        ...contentExtensions(),
        Mention.configure({
          HTMLAttributes: { class: 'mention' },
          renderLabel: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
          suggestion: mentionSuggestion(docId),
        }),
        // Yjs keeps its own undo history (only your own changes are undone), so TipTap's is disabled.
        Collaboration.configure({ document: ydoc, field: FRAGMENT }),
        CollaborationCaret.configure({ provider, user: { id: user.id, name: user.name, color: user.color } }),
        Placeholder.configure({ placeholder: 'Start typing… type @ to mention someone, paste or drop images.' }),
      ],
      editable,
      editorProps: {
        attributes: { class: 'prose', spellcheck: 'true' },
        handlePaste: (view, event) => {
          const files = imageFiles(event.clipboardData?.files)
          if (!files.length || !view.editable) return false
          insertImages(view, files, null, setUploadError)
          return true
        },
        handleDrop: (view, event) => {
          const files = imageFiles((event as DragEvent).dataTransfer?.files)
          if (!files.length || !view.editable) return false
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null
          insertImages(view, files, pos, setUploadError)
          return true
        },
      },
    },
    [ydoc, provider, docId],
  )

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (editor && onReady) onReady(editor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  return (
    <div className="editor-wrap">
      {editable && editor && (
        <Toolbar editor={editor} docId={docId} aiEnabled={aiEnabled} onUploadError={setUploadError} />
      )}
      {uploadError && (
        <div className="error" onClick={() => setUploadError('')}>
          {uploadError} (click to dismiss)
        </div>
      )}
      <div className="paper">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
})

function imageFiles(list: FileList | undefined | null) {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
}

async function insertImages(view: EditorView, files: File[], pos: number | null, onError: (m: string) => void) {
  for (const file of files) {
    try {
      const src = await uploadImage(file)
      const node = view.state.schema.nodes.image.create({ src, alt: file.name })
      const at = pos ?? view.state.selection.to
      view.dispatch(view.state.tr.insert(Math.min(at, view.state.doc.content.size), node))
    } catch (e) {
      onError((e as Error).message)
    }
  }
}

// ------------------------------------------------------------------ toolbar

function Toolbar({ editor, docId, aiEnabled, onUploadError }: {
  editor: Editor
  docId: string
  aiEnabled: boolean
  onUploadError: (m: string) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiJob, setAiJob] = useState<{ mode: string; instruction?: string } | null>(null)
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      codeBlock: e.isActive('codeBlock'),
      language: (e.getAttributes('codeBlock').language as string | null) ?? '',
      quote: e.isActive('blockquote'),
      table: e.isActive('table'),
      hasSelection: !e.state.selection.empty,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const c = () => editor.chain().focus()
  const B = ({ on, label, title, run, disabled }: {
    on?: boolean
    label: string
    title: string
    run: () => void
    disabled?: boolean
  }) => (
    <button
      type="button"
      className={'tb-btn' + (on ? ' on' : '')}
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  )

  return (
    <div className="toolbar-stack">
      <div className="toolbar" role="toolbar">
        <B label="↶" title="Undo (Ctrl+Z)" disabled={!s.canUndo} run={() => c().undo().run()} />
        <B label="↷" title="Redo (Ctrl+Shift+Z)" disabled={!s.canRedo} run={() => c().redo().run()} />
        <span className="tb-sep" />
        <B label="H1" title="Heading 1" on={s.h1} run={() => c().toggleHeading({ level: 1 }).run()} />
        <B label="H2" title="Heading 2" on={s.h2} run={() => c().toggleHeading({ level: 2 }).run()} />
        <B label="H3" title="Heading 3" on={s.h3} run={() => c().toggleHeading({ level: 3 }).run()} />
        <span className="tb-sep" />
        <B label="B" title="Bold (Ctrl+B)" on={s.bold} run={() => c().toggleBold().run()} />
        <B label="I" title="Italic (Ctrl+I)" on={s.italic} run={() => c().toggleItalic().run()} />
        <B label="S" title="Strikethrough" on={s.strike} run={() => c().toggleStrike().run()} />
        <B label="</>" title="Inline code" on={s.code} run={() => c().toggleCode().run()} />
        <span className="tb-sep" />
        <B label="• List" title="Bullet list" on={s.bullet} run={() => c().toggleBulletList().run()} />
        <B label="1. List" title="Numbered list" on={s.ordered} run={() => c().toggleOrderedList().run()} />
        <B label="☑ Tasks" title="Checklist" on={s.task} run={() => c().toggleTaskList().run()} />
        <B label="{ } Code" title="Code block" on={s.codeBlock} run={() => c().toggleCodeBlock().run()} />
        <B label="❝" title="Quote" on={s.quote} run={() => c().toggleBlockquote().run()} />
        <span className="tb-sep" />
        <B
          label="⊞ Table"
          title="Insert table"
          disabled={s.table}
          run={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <B label="🖼 Image" title="Insert image (or paste / drop one)" run={() => fileInput.current?.click()} />
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          hidden
          onChange={(e) => {
            const files = imageFiles(e.target.files)
            e.target.value = ''
            if (files.length) insertImages(editor.view, files, null, onUploadError)
          }}
        />
        {aiEnabled && (
          <>
            <span className="tb-sep" />
            <div className="dropdown">
              <B
                label="✨ AI"
                title={s.hasSelection ? 'Rewrite the selected text with AI' : 'Select some text to rewrite it with AI'}
                disabled={!s.hasSelection}
                on={aiOpen}
                run={() => setAiOpen((v) => !v)}
              />
              {aiOpen && s.hasSelection && (
                <div className="menu" onMouseDown={(e) => e.preventDefault()}>
                  {[
                    ['improve', 'Improve writing'],
                    ['shorten', 'Make shorter'],
                    ['expand', 'Make longer'],
                    ['formal', 'More formal'],
                    ['casual', 'More casual'],
                    ['grammar', 'Fix spelling & grammar'],
                    ['bullets', 'Turn into bullet list'],
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setAiOpen(false)
                        setAiJob({ mode })
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      setAiOpen(false)
                      const instruction = prompt('How should the AI rewrite the selection?')
                      if (instruction) setAiJob({ mode: 'custom', instruction })
                    }}
                  >
                    Custom instruction…
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {(s.codeBlock || s.table) && (
        <div className="toolbar sub-toolbar">
          {s.codeBlock && (
            <label className="small">
              Language{' '}
              <select
                value={s.language}
                onChange={(e) => c().updateAttributes('codeBlock', { language: e.target.value || null }).run()}
              >
                {LANGUAGES.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {s.table && (
            <>
              <span className="small muted">Table:</span>
              <B label="+ Row" title="Add row below" run={() => c().addRowAfter().run()} />
              <B label="+ Column" title="Add column right" run={() => c().addColumnAfter().run()} />
              <B label="− Row" title="Delete row" run={() => c().deleteRow().run()} />
              <B label="− Column" title="Delete column" run={() => c().deleteColumn().run()} />
              <B label="Header row" title="Toggle header row" run={() => c().toggleHeaderRow().run()} />
              <B label="✕ Delete table" title="Delete table" run={() => c().deleteTable().run()} />
            </>
          )}
        </div>
      )}
      {aiJob && <AiRewrite editor={editor} docId={docId} job={aiJob} onClose={() => setAiJob(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------ AI rewrite of a selection

function AiRewrite({ editor, docId, job, onClose }: {
  editor: Editor
  docId: string
  job: { mode: string; instruction?: string }
  onClose: () => void
}) {
  const [range] = useState(() => ({ from: editor.state.selection.from, to: editor.state.selection.to }))
  const [original] = useState(() => editor.state.doc.textBetween(range.from, range.to, '\n\n'))
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api<{ text: string }>(`/docs/${docId}/ai/rewrite`, {
      method: 'POST',
      body: { text: original, mode: job.mode, instruction: job.instruction },
    })
      .then((r) => setResult(r.text))
      .catch((e) => setError(e.message))
  }, [docId, original, job])

  const asHtml = (text: string) => {
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length && lines.every((l) => /^\s*[-*•] /.test(l))) {
      return `<ul>${lines.map((l) => `<li><p>${escapeHtml(l.replace(/^\s*[-*•] /, ''))}</p></li>`).join('')}</ul>`
    }
    // A single paragraph is inserted inline, so the surrounding block (heading, list item…) keeps its type.
    if (!/\n\s*\n/.test(text.trim())) return escapeHtml(text.trim()).replace(/\n/g, '<br>')
    return text
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
      .join('')
  }

  function apply(replace: boolean) {
    if (!result) return
    // Others may have edited meanwhile: only replace if the selected text is still there.
    const stillThere =
      range.to <= editor.state.doc.content.size && editor.state.doc.textBetween(range.from, range.to, '\n\n') === original
    if (replace && stillThere) {
      editor.chain().focus().insertContentAt(range, asHtml(result)).run()
    } else {
      const at = stillThere ? range.to : editor.state.selection.to
      editor.chain().focus().insertContentAt(at, asHtml(result)).run()
    }
    onClose()
  }

  return (
    <Modal title="✨ AI suggestion" onClose={onClose} wide>
      <div className="ai-compare">
        <div>
          <h4>Selected text</h4>
          <div className="ai-box muted">{original}</div>
        </div>
        <div>
          <h4>Suggestion</h4>
          <div className="ai-box">{error ? <span className="error-text">{error}</span> : result ?? <span className="muted">Thinking…</span>}</div>
        </div>
      </div>
      <div className="modal-foot gap">
        <button className="btn" onClick={onClose}>
          Discard
        </button>
        <button className="btn" disabled={!result} onClick={() => apply(false)}>
          Insert below
        </button>
        <button className="btn primary" disabled={!result} onClick={() => apply(true)}>
          Replace selection
        </button>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ read-only rendering (version preview)

/** Renders a Y.Doc read-only with the same schema as the editor. */
export function ReadOnlyDoc({ ydoc }: { ydoc: Y.Doc }) {
  const editor = useEditor(
    {
      extensions: [
        ...contentExtensions(),
        Mention.configure({ HTMLAttributes: { class: 'mention' }, renderLabel: ({ node }) => `@${node.attrs.label ?? node.attrs.id}` }),
        Collaboration.configure({ document: ydoc, field: FRAGMENT }),
      ],
      editable: false,
      editorProps: { attributes: { class: 'prose' } },
    },
    [ydoc],
  )
  return <EditorContent editor={editor} />
}
