export type Role = 'owner' | 'editor' | 'commenter' | 'viewer'

export interface User {
  id: string
  email: string
  name: string
  color: string
}

export interface DocSummary {
  id: string
  title: string
  role: Role
  owner_name: string
  owner_id: string
  created_at: string
  updated_at: string
}

export interface Member {
  id: string
  name: string
  email: string
  color: string
  role: Role
}

export interface ShareLink {
  token: string
  role: Role
  created_at: string
}

export interface Version {
  id: string
  name: string | null
  kind: 'named' | 'auto' | 'restore'
  created_at: string
  created_by_name: string | null
  created_by_color: string | null
  size: number
}

export interface DiffLine {
  type: 'same' | 'added' | 'removed'
  text: string
}

const TOKEN_KEY = 'coedit.token'
const USER_KEY = 'coedit.user'

/**
 * Login sessions are pinned PER TAB (sessionStorage), so you can be signed in as user A in one
 * tab and user B in another tab of the same browser — handy for testing collaboration.
 * localStorage only remembers the most recent login, so a brand-new tab starts signed in as that user.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
// When a tab opens, adopt the most recent login (if this tab doesn't have its own yet).
// "?fresh=1" (the "Use another account" button) opens a tab that starts signed out instead.
safe(() => {
  const fresh = new URLSearchParams(location.search).has('fresh')
  if (fresh) {
    // Browsers copy sessionStorage into tabs opened by window.open: start this tab signed out.
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
    history.replaceState(null, '', location.pathname)
  }
  if (!fresh && sessionStorage.getItem(TOKEN_KEY) === null && localStorage.getItem(TOKEN_KEY) !== null) {
    sessionStorage.setItem(TOKEN_KEY, localStorage.getItem(TOKEN_KEY)!)
    sessionStorage.setItem(USER_KEY, localStorage.getItem(USER_KEY) ?? 'null')
  }
}, undefined)

export const session = {
  get token() {
    return safe(() => sessionStorage.getItem(TOKEN_KEY), null)
  },
  get user(): User | null {
    return safe(() => JSON.parse(sessionStorage.getItem(USER_KEY) ?? 'null'), null)
  },
  save(token: string, user: User) {
    safe(() => {
      sessionStorage.setItem(TOKEN_KEY, token)
      sessionStorage.setItem(USER_KEY, JSON.stringify(user))
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    }, undefined)
  },
  /** Logs out this tab. Other tabs signed in as someone else are not affected. */
  clear() {
    safe(() => {
      const mine = sessionStorage.getItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(USER_KEY)
      if (localStorage.getItem(TOKEN_KEY) === mine) {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
      }
    }, undefined)
  },
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'You appear to be offline')
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && session.token && !path.startsWith('/auth/')) {
      session.clear()
      window.location.href = '/login'
    }
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`)
  }
  return data as T
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} d ago`
  return new Date(iso).toLocaleDateString()
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

// ------------------------------------------------------------------ Tier 4 additions

export interface Activity {
  id: number
  doc_id: string
  doc_title: string
  type: string
  data: Record<string, string>
  created_at: string
  actor_id: string | null
  actor_name: string | null
  actor_color: string | null
}

export interface Notification {
  id: number
  doc_id: string | null
  type: string
  message: string
  read_at: string | null
  created_at: string
  actor_name: string | null
  actor_color: string | null
}

export interface SearchResult {
  id: string
  title: string
  role: Role
  updated_at: string
  rank: number
  title_hl: string
  snippet: string
}

/** Downloads an authenticated file (export) by fetching it and saving the blob. */
export async function downloadFile(path: string, fallbackName: string) {
  const res = await fetch('/api' + path, { headers: { authorization: `Bearer ${session.token}` } })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(res.status, data.error ?? `Download failed (${res.status})`)
  }
  const cd = res.headers.get('content-disposition') ?? ''
  const name = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? '') || fallbackName
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Uploads an image (straight to S3 when the server is configured for it, else to our API). Returns its URL. */
export async function uploadImage(file: File): Promise<string> {
  const init = await api<{ mode: 's3' | 'direct'; uploadUrl: string; method: string; url?: string }>('/uploads/init', {
    method: 'POST',
    body: { contentType: file.type, size: file.size },
  })
  if (init.mode === 's3') {
    const res = await fetch(init.uploadUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file })
    if (!res.ok) throw new ApiError(res.status, 'Upload to storage failed')
    return init.url!
  }
  const res = await fetch(init.uploadUrl, {
    method: 'POST',
    headers: { 'content-type': file.type, authorization: `Bearer ${session.token}` },
    body: file,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Upload failed')
  return data.url
}

let aiStatus: Promise<{ enabled: boolean; model: string | null }> | null = null
export function getAiStatus() {
  aiStatus ??= api<{ enabled: boolean; model: string | null }>('/ai/status').catch(() => ({ enabled: false, model: null }))
  return aiStatus
}

/** Content waiting to be inserted into a freshly created doc (from a template or an import). */
export const pendingContent = {
  set(docId: string, html: string) {
    sessionStorage.setItem(`coedit.pending.${docId}`, html)
  },
  take(docId: string): string | null {
    const html = sessionStorage.getItem(`coedit.pending.${docId}`)
    if (html !== null) sessionStorage.removeItem(`coedit.pending.${docId}`)
    return html
  },
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** A share-link visitor without an account: access to one document only. */
export interface GuestSession {
  token: string
  user: User
  docId: string
  title: string
  ownerName: string
  role: Role
}
