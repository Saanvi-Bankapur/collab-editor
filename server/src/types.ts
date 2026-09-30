export type Role = 'owner' | 'editor' | 'commenter' | 'viewer'

export interface AuthUser {
  id: string
  email: string
  name: string
  color: string
  /** Set for people who opened a share link without an account: access to that one document only. */
  guest?: { docId: string; link: string }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}
