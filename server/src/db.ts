import pg from 'pg'
import { config } from './config.js'

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  color         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL DEFAULT 'Untitled document',
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_members (
  doc_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     text NOT NULL CHECK (role IN ('owner','editor','commenter','viewer')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX IF NOT EXISTS document_members_user_idx ON document_members(user_id);

CREATE TABLE IF NOT EXISTS share_links (
  token      text PRIMARY KEY,
  doc_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('editor','commenter','viewer')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked    boolean NOT NULL DEFAULT false
);

-- Compacted CRDT state: one row per document.
CREATE TABLE IF NOT EXISTS doc_snapshots (
  doc_id       uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state        bytea NOT NULL,
  compacted_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only operation log (Yjs updates) written since the last compaction.
CREATE TABLE IF NOT EXISTS doc_updates (
  id          bigserial PRIMARY KEY,
  doc_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  data        bytea NOT NULL,
  instance_id text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_updates_doc_idx ON doc_updates(doc_id, id);

CREATE TABLE IF NOT EXISTS doc_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name       text,
  kind       text NOT NULL CHECK (kind IN ('named','auto','restore')),
  state      bytea NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_versions_doc_idx ON doc_versions(doc_id, created_at DESC);

-- Full-text search: plain text of the document is kept up to date by the collab server,
-- and Postgres maintains a weighted tsvector (title = A, body = B) in a generated column.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_text text NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS documents_search_idx ON documents USING GIN (search_tsv);

-- Image uploads (used when S3 is not configured, so every instance can serve every image).
CREATE TABLE IF NOT EXISTS uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  content_type text NOT NULL,
  size         integer NOT NULL,
  data         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Activity feed: everything that happens to a document.
CREATE TABLE IF NOT EXISTS activities (
  id         bigserial PRIMARY KEY,
  doc_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_doc_idx ON activities(doc_id, created_at DESC);

-- Per-user notifications ("Priya edited your doc", "You were mentioned").
CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id     uuid REFERENCES documents(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  type       text NOT NULL,
  message    text NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
`

/** Runs the schema. An advisory lock stops several server instances from racing on startup. */
export async function migrate() {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(727274)')
    await client.query(SCHEMA)
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {})
    client.release()
  }
}
