import { CollabServer } from './collabServer.js'

/** The single collaboration server for this process (shared by the WebSocket and REST layers). */
export const collab = new CollabServer()
