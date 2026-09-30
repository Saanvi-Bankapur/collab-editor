# CoEdit: a real-time collaborative editor

[![CI](https://github.com/YOUR_GITHUB_USERNAME/collab-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_GITHUB_USERNAME/collab-editor/actions/workflows/ci.yml)
**Live demo:** https://YOUR-APP.onrender.com  <!-- replace both after you push & deploy (section 7) -->

A small Google Docs: several people edit one document at once, with live cursors, presence, sharing and permissions, version history, offline editing, and horizontal scaling across several WebSocket servers. Extras: full-text search, AI assist, import/export (Markdown, Word, PDF), tables, checklists, syntax-highlighted code, images, @mentions, notifications and templates.

**Stack:** React + TypeScript (Vite), TipTap (ProseMirror) editor, **Yjs CRDT**, Node.js + TypeScript backend (Express + `ws`), PostgreSQL, Redis pub/sub.

---

## 1. What you need to do by hand (one-time setup on Windows)

| # | Step | How |
|---|------|-----|
| 1 | **Install Node.js 22 or newer** (LTS) | Download from https://nodejs.org, run the installer, then check with `node -v` in a new terminal. |
| 2 | **Install Docker Desktop** (runs Postgres + Redis for you) | https://www.docker.com/products/docker-desktop/. It will ask to enable **WSL 2**, so say yes and restart if prompted. Open Docker Desktop once so the engine is running (whale icon in the tray). |
| 3 | **Install dependencies** | Open PowerShell in this folder (`C:\Users\User\React\collab-editor`) and run `npm install` |
| 4 | **Start the databases** | `docker compose up -d` (first run downloads the images; later runs are instant) |
| 5 | **Run the app** | `npm run dev`, then open http://localhost:5173 |

That's it. The database tables are created automatically when the server starts.

**Environment file (optional):** the server's built-in defaults already match `docker-compose.yml`, so it runs without one. To change a setting, copy it first: `copy server\.env.example server\.env` in PowerShell, then edit `server/.env`. For anything public, set `JWT_SECRET` to a long random string.

<details>
<summary>No Docker? Alternatives</summary>

- **Postgres:** install it natively from https://www.postgresql.org/download/windows/, then in `psql` or pgAdmin run:
  `CREATE USER collab WITH PASSWORD 'collab'; CREATE DATABASE collab OWNER collab;`
- **Redis:** Redis has no official Windows build. Set `REDIS_URL=disabled` in `server/.env` (create it from `.env.example`) to run a **single** server without Redis. Everything works except the multi-server demo. For the cluster demo you need Redis, either through Docker or WSL (`sudo apt install redis-server`).
- **Port 5432 already in use** (a local Postgres is running): change `"5432:5432"` to `"5433:5432"` in `docker-compose.yml` and set `DATABASE_URL=postgres://collab:collab@localhost:5433/collab`.
</details>

### Optional manual steps

- **Push to GitHub and deploy:** see [section 7](#7-ci-and-live-demo-manual-steps).
- **Try it with a friend on your Wi-Fi:** run `npm run dev -w client -- --host` and share `http://<your-LAN-IP>:5173`. Windows Firewall will ask for permission, so allow it.

### Testing with two accounts on one computer

Say `sanvi@gmail.com` owns a doc and wants `adya@gmail.com` to edit it with her, both open at the same time:
1. **Tab 1:** log in as Sanvi and create a document.
2. Click your **avatar** (top right) → **Use another account**. A new tab opens signed out. Log in or sign up as Adya there. Tab 1 stays signed in as Sanvi; nobody logs out. Each tab keeps its own account.
3. **Tab 1 (Sanvi):** **Share** → start typing Adya's name or email → pick her from the dropdown → *Editor* → **Invite**.
4. **Tab 2 (Adya):** refresh the dashboard. The doc is under **Shared with me** (and in her 🔔). Open it.
5. Both type in different places. Each person's text appears instantly in the other tab, with a colored cursor labelled with their name. Click someone's avatar at the top to jump to their cursor. The **Activity** tab shows who edited and what they added or removed.

**Share links:** in **Share → Create link**, choose *view* or *edit*. Whoever opens the link sees only that document. Without an account they join as a guest (e.g. "Guest Panda") and can't reach anyone's dashboard. Signed-in people also get it in their *Shared with me*. **Turn off** disconnects guests immediately.

Tip: drag the second tab out into its own window and put them side by side. Use Chrome or Edge rather than VS Code's built-in browser.

**Server status page** (avatar → *Server status*, or `/status`): a monitoring dashboard for the backend, showing how many people are connected, edits per second and database write speed for each server instance. It's there to demonstrate the distributed-systems side (for example during `npm run cluster`); normal users don't need it.

**AI not working?** Click your avatar → **Test AI**. It shows whether a key is loaded and the exact error. The server log also prints `[ai] enabled: …` or `[ai] disabled: …` when it starts.

### Using CoEdit from different laptops (the real way)

CoEdit is a normal client-server web app. The **server** (Node + Postgres + Redis) runs on one machine, and **everyone else just opens it in a browser** on their own laptop or phone. There's nothing to install on their side. Any number of people can be connected at once, each editing their own documents or the same shared document, and every document is synced independently.

The only question is how the other laptops reach your server:

| Situation | What to do | Others open |
|---|---|---|
| **Same Wi-Fi** (e.g. both in the library) | Run `npm run dev` as usual. Vite prints a `Network:` address such as `http://192.168.1.23:5173`. Allow Node through Windows Firewall when asked. | `http://192.168.1.23:5173` |
| **Different places / networks** | Deploy it (section 7: Render). Everyone uses the public link. | `https://your-app.onrender.com` |
| **Quick internet demo without deploying** | `npx cloudflared tunnel --url http://localhost:5173` (or ngrok) gives a temporary public https link | the printed `https://….trycloudflare.com` link |

Each person signs up with their own email on their own device. Sharing, live cursors, presence and notifications then work across devices exactly as they do between two tabs.

### Where is the data stored?

Nothing extra to install: Docker Desktop runs everything.

| Where | What | Survives restarts? |
|---|---|---|
| **PostgreSQL** (Docker container `postgres`, data in the Docker volume `pgdata`) | Everything permanent: users, documents, sharing, the CRDT op log + snapshots, versions, uploaded images, activity, notifications, the search index | Yes. `docker compose down` keeps it; only `docker compose down -v` deletes it |
| **Redis** (Docker container `redis`) | Nothing permanent: live messages between server instances and the monitoring snapshot | Doesn't need to |
| **Your browser** (IndexedDB) | An offline copy of each doc you open, so you can edit without internet | Yes, per browser |

To look inside the database: `docker compose exec postgres psql -U collab collab`, then `\dt` lists the tables and `SELECT title FROM documents;` shows your docs (`\q` quits). On Render, the same data lives in Render's managed Postgres.

---

## 2. Running it

| Command | What it does |
|---|---|
| `npm run dev` | One backend on :4000 plus the React dev server on :5173 |
| `npm run cluster` | **3 backend instances** (:4001–4003) behind a round-robin **load balancer** on :4000, plus React on :5173 |
| `npm test` | Merge-correctness + storage tests (unit, fuzz, Postgres) |
| `npm run test:e2e` | End-to-end test (run it while `npm run cluster` is running in another terminal) |
| `docker compose --profile full up --build` | **Everything in containers**: Postgres, Redis, 3 app instances, nginx load balancer on http://localhost:8080 |
| `npm run build` then `npm start` | Production build: a single server on :4000 that also serves the React app |
| `npm run db:up` / `npm run db:down` | Start or stop Postgres + Redis |

Monitoring is always on: open **http://localhost:5173/status** (or click *Status* in the header) for live connections and ops/sec per instance, or read raw Prometheus metrics at http://localhost:4000/metrics.

---

## 3. Demo script (great for interviews)

1. **Two users:** open http://localhost:5173 in two tabs (or a normal and an incognito window) and sign up as two different people, e.g. `a@gmail.com` in tab 1 and `b@gmail.com` in tab 2. Each tab keeps its own login, so both can be signed in at once. A new tab starts as whoever logged in last, so in tab 2 click **Log out** first, then sign up or log in as B. Click your avatar (top right) to see which account a tab is using.
2. **Create & share:** user A clicks **+ New document**, types some text, clicks **Share**, then invites user B's email as *Editor* (or creates a link and pastes it in the other window).
3. **Real-time sync + cursors + presence:** both type in the document. Each person's colored, name-labelled cursor appears in the other window, and the avatars show who's here. Switch tabs for a minute and your avatar fades (*idle*).
4. **Horizontal scaling:** stop `npm run dev` and run `npm run cluster`. The badge next to the title (`⛁ server-2`) shows which backend each tab is connected to. Open a few tabs until two of them sit on **different** servers: edits still appear instantly because Redis pub/sub relays them. The terminal logs `[lb] websocket … -> server-N` for every connection.
5. **Offline editing:** in one window open DevTools → Network → set **Offline** (or turn Wi-Fi off). The pill says *Offline · changes saved locally*. Keep typing in both windows, then go back online and both sets of edits merge with no conflicts. Your offline edits even survive a page reload (IndexedDB).
6. **Version history:** click **History** → *Save* a named version → change the doc → **Compare** (line diff against current or any other version) → **View** (read-only preview) → **Restore** (everyone connected sees it instantly; a "Before restoring…" checkpoint is saved first, so a restore can itself be undone).
7. **Monitoring:** open **/status** in a third tab while two people type. Ops/sec, connections and DB-write latency update live for each instance.
8. **Permissions:** change B to *Viewer* in the Share dialog. B's editor becomes read-only immediately. Remove B and they are disconnected with "access removed".
9. **Templates + blocks:** **+ New document** → *Meeting notes*. Add a table (⊞), a checklist (☑), a code block (then choose a language), and paste or drop an image.
10. **@mentions + notifications:** type `@` and pick B. B's 🔔 shows "A mentioned you in …" and the doc's **Activity** tab logs it. With SMTP configured, B also gets an email.
11. **Search:** on the dashboard, type part of a word from any doc (e.g. `quant`). Results are ranked, with highlighted snippets. Also try `"exact phrase"` and `-exclude`.
12. **AI** (needs a free Groq key, see section 8): select text → **✨ AI** → *Make shorter*; **✨ Summarize** the doc; in **History → Compare**, click **✨ Explain this change**.
13. **Export / import:** **Export ▾** → Markdown / Word / PDF. The PDF is generated in the browser and downloads directly, so it also works inside VS Code's built-in browser; **Print…** is also there. On the dashboard, **⇪ Import** a `.md` or `.docx` file.

---

## 4. Features and where they live

**Tier 1: core**
- Rich text: headings, bold, italic, strike, inline code, bullet and numbered lists, code blocks, quotes, and collaborative undo/redo (you undo only *your own* edits). See `client/src/components/CollabEditor.tsx`.
- Real-time sync over WebSockets using the y-websocket protocol. The server is custom: `server/src/collab/collabServer.ts`.
- Conflict resolution with a **Yjs CRDT**: concurrent edits merge deterministically on every replica.
- Auth (bcrypt + JWT) and documents (create, rename, delete, a "My documents" dashboard with filters). See `server/src/routes/auth.ts`, `server/src/routes/docs.ts` and `client/src/pages/Dashboard.tsx`.
- Autosave: every edit is written to Postgres within about 150 ms. There's no save button.

**Tier 2: collaboration layer**
- Live cursors and selections in each user's color with their name (Yjs *awareness*).
- Presence avatars, deduplicated per user across tabs, with an idle state after 60 s of inactivity or when the tab is hidden.
- Sharing and permissions: owner, editor, commenter and viewer roles, invites by email, shareable links ("anyone with the link can view/comment/edit") that can be turned off, and live kick or re-connect when a role changes. The server enforces read-only access by dropping edits from viewers and commenters. See `server/src/routes/sharing.ts`.
- Version history: named versions, automatic snapshots every 10 minutes of editing, a timeline, a line diff between any two versions, read-only preview, and restore. See `server/src/routes/versions.ts` and `client/src/components/VersionPanel.tsx`.

**Tier 3: distributed systems**
- **Offline editing:** `y-indexeddb` keeps a local replica. Edits made offline are ordinary CRDT updates, so reconnecting just exchanges state vectors and merges.
- **Horizontal scaling:** N stateless-ish WebSocket servers. Each document has a Redis channel `doc:<id>`, and an instance subscribes only while it has that doc open. When an instance opens a doc it loads it from Postgres, then sends a `SyncRequest` with its state vector so peers can return anything not yet persisted. See `server/src/collab/pubsub.ts` and `server/src/cluster.ts`.
- **Snapshots and compaction:** the storage model is event-sourced. `doc_updates` is an append-only op log and `doc_snapshots` holds the compacted state. Once a doc has more than `COMPACT_THRESHOLD` log rows, the log is folded into the snapshot inside a transaction guarded by a per-doc advisory lock. Only the rows actually read are deleted, so concurrent writes are never lost. See `server/src/collab/persistence.ts`.
- **Reconnection and ordering:** clients reconnect with exponential backoff. Yjs identifies every operation by `(clientID, clock)`, so duplicate messages are ignored (idempotent) and out-of-order ones wait until their dependencies arrive (causal ordering). The sync handshake exchanges **state vectors** (a vector-clock summary) to send exactly the missing operations.

**Tier 4: standout extras**
- **Full-text search** (`server/src/routes/search.ts`, CS 411 material): `documents.search_tsv` is a **generated `tsvector` column** (title weighted A, body B) with a **GIN index**. The collab server keeps `content_text` up to date about 1.5 s after edits. Queries use prefix matching while you type (`coll:* & edit:*`) or `websearch_to_tsquery` for `"phrases"`, `OR` and `-exclusions`. Results are ranked with `ts_rank_cd`, snippets come from `ts_headline`, and access is enforced by joining `document_members`. Try `EXPLAIN ANALYZE` on the query to show the index scan.
- **AI assist** (`server/src/ai.ts`, `routes/aiRoutes.ts`): works with **Groq's free tier** (default) or any OpenAI-compatible API (Gemini, OpenRouter, Cerebras), and also with Claude. It's called with plain `fetch`, no SDK. You can **summarize** a doc, **rewrite a selection** (improve, shorten, formal, fix grammar, bullets, or a custom instruction, previewed before replacing), and **explain the change** between two versions from their diff. Document text is treated as untrusted data in the prompts, and there's a per-user rate limit (20 requests per 10 min). Without `AI_API_KEY` the buttons are hidden.
- **Export / import**: Markdown and Word (.docx) are generated server-side from the CRDT (`server/src/collab/docModel.ts` → `docx.ts`), including tables, checklists, code, mentions, links and embedded images. PDF is generated in the browser with pdfmake (`client/src/lib/pdfExport.ts`) and downloads as a real .pdf, including tables, checklists, code and images. There's also a Print… option. Import converts `.md` (GFM, including task lists and tables) or `.docx` (mammoth) to HTML in the browser, and the editor parses it into the shared document.
- **Embedded blocks**: code blocks with **syntax highlighting** (lowlight, 16 languages), **tables** (add/remove rows and columns, header row), **checklists** (nested), **images** (toolbar, paste or drag-and-drop), **@mentions** and links. Images are uploaded **straight to S3 with a presigned URL** when `S3_BUCKET` is set. Otherwise they're stored in Postgres, so every server instance can serve every image.
- **Activity feed & notifications** (`server/src/activity.ts`): an `activities` table records created, renamed, edited, shared, role changed, link created/joined, version saved/restored and mentioned. `notifications` powers the 🔔 menu. Edits are throttled in SQL: one "edited" entry per user per 10 min, and the owner is notified at most every 30 min, which stays correct across instances. **@mentions** are detected server-side by the CRDT item id of each mention node, and exactly one instance (the one whose client typed it) sends the notification. Emails go out through SMTP when `SMTP_URL` is set. Otherwise they're printed in the server log.
- **Templates** (`client/src/lib/templates.ts`): Meeting notes, Project spec, Weekly status, Retrospective and Lecture notes. The content is inserted once the new doc has synced.

---

## 5. Architecture

```mermaid
flowchart TB
    subgraph Clients["Browsers"]
        direction LR
        C1["React + TipTap<br/>Y.Doc CRDT replica<br/>+ IndexedDB offline copy"]
        C2["React + TipTap<br/>Y.Doc"]
        C3["React + TipTap<br/>Y.Doc"]
    end

    LB{{"Load balancer: nginx (Docker) / Node LB (npm run cluster)<br/>round robin, no sticky sessions"}}

    subgraph WS["WebSocket servers (Node + TypeScript), each holds docId → Y.Doc + awareness"]
        direction LR
        S1["server-1"]
        S2["server-2"]
        S3["server-3"]
    end

    subgraph Data["Shared state"]
        direction LR
        R[("Redis pub/sub<br/>channel doc:&lt;id&gt;: updates, cursors,<br/>sync req/resp, kicks · metrics hash")]
        P[("PostgreSQL<br/>users · documents (+ tsvector GIN index) · members · share_links<br/>doc_updates (op log) · doc_snapshots · doc_versions<br/>activities · notifications · uploads")]
    end

    M["Monitoring: /metrics (Prometheus) · /api/metrics · /status page"]

    C1 & C2 & C3 <-->|"WebSocket (y-websocket binary protocol)"| LB
    LB <--> S1 & S2 & S3
    WS <-->|"publish / subscribe"| R
    WS -->|"op log in ~150 ms batches, compaction → snapshots"| P
    WS -.-> M
    X["Optional services: AI API (Groq / any OpenAI-compatible, or Claude) · S3 (images) · SMTP (emails)"]
    WS -.->|"if configured"| X
    C1 -.->|"presigned PUT"| X
```

### One keystroke, end to end

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice (browser)
    participant S1 as server-1
    participant R as Redis
    participant S2 as server-2
    participant B as Bob (browser)
    participant DB as Postgres
    A->>A: TipTap edit → Y.Doc update (applied locally at once)
    A->>S1: sync update (binary, ~20-50 bytes)
    S1->>S1: apply to in-memory Y.Doc
    par fan-out
        S1-->>A: echo to local clients
        S1->>R: PUBLISH doc:<id> Update
        R->>S2: message
        S2->>S2: apply (origin = redis, not re-published)
        S2-->>B: sync update → Bob's editor + cursor
    and persist
        S1->>DB: buffered 150 ms, merged, INSERT doc_updates
    end
    Note over S1,DB: every COMPACT_THRESHOLD rows: fold log into doc_snapshots (advisory lock)
```

**Load path:** snapshot + all remaining log rows → Y.Doc → the instance sends a `SyncRequest` (its state vector) to peers over Redis → clients sync with a state-vector handshake.

**Offline path:** edits go to the local Y.Doc and IndexedDB. On reconnect, client and server swap state vectors and each sends exactly the operations the other is missing.

---

## 6. Tests, monitoring and CI

### Merge-correctness tests (`npm test`)

| File | What it proves |
|---|---|
| `server/test/merge.test.ts` | **Convergence.** Two users type at the same spot, delete vs insert inside the deleted range, overlapping deletes, bold vs italic on overlapping text, conflicting heading levels, deleting a paragraph someone is editing, and inserts at the top. The result must not depend on delivery order. **Network faults:** duplicate delivery is idempotent, out-of-order updates are buffered until their dependencies arrive, 300-op offline divergence merges, and server-side batching equals individual updates. **Fuzz:** 4 simulated editors × 400 random ops (text, formatting, paragraphs, attributes) over a network that delays, reorders, duplicates and drops messages, run over 25 seeds locally and 100 in CI. After healing, every replica must be identical (same content, same state vector, nothing pending). A sanity test checks that the replicas really had diverged. |
| `server/test/persistence.test.ts` | Against real Postgres: the op log replays to the same doc, compaction never changes the document, and **writes racing with two parallel compactions are never lost.** |
| `server/test/docText.test.ts`, `docModel.test.ts` | The document model: text for diffs and search, **Markdown export of every block type**, a valid .docx, @mention identity across replicas, the search-query builder (injection-safe), and image header parsing. |
| `server/test/e2e.ts` | 25 checks through real WebSockets on **3 instances**: image upload, **full-text search** (prefix, phrase, access control), **mention/share/edit notifications**, the activity feed, **Markdown + .docx export**, **AI endpoints against a mock AI API**, auth, permissions, cross-server latency, presence, offline merge, a **300-edit concurrent storm from clients on two different servers converging on all three**, versions, diff and restore, compaction, metrics, reload from Postgres, live kicks, and deletion. |

### Monitoring

- `GET /metrics` returns Prometheus text format: active connections, open docs, pending writes, ops/sec, and counters for ops received and relayed, messages sent, Redis publish/receive, persisted rows and bytes, compactions and rejected connections, plus a DB-write latency summary (p50/p95/p99). With `npm run cluster`, the load balancer's `/metrics` merges all instances.
- `GET /api/metrics` returns JSON for **every instance in the cluster**. Each instance writes a snapshot to a Redis hash every 2 s, so this works behind any load balancer. The **/status** page in the app displays it.
- These endpoints are unauthenticated for the demo. Put them behind auth or a private network in real production.

### CI (GitHub Actions, `.github/workflows/ci.yml`)

1. **test:** typecheck (including tests), `npm test` with Postgres as a service container and 100 fuzz seeds, and a production build.
2. **e2e:** Postgres + Redis services, 3 instances plus a load balancer, and the full end-to-end suite.
3. **docker:** builds the image, starts the **whole stack with `docker compose --profile full`** (3 app containers + nginx), and runs the end-to-end suite through nginx.

---

## 7. CI and live demo: manual steps

**A. Push to GitHub (turns on CI)**
0. **Move the CI workflow into place** (the tool I used can't write inside `.github`, so it's in `deploy/`). In PowerShell, from this folder:
   ```
   mkdir .github\workflows -Force
   move deploy\ci.yml .github\workflows\ci.yml
   ```
1. Create an empty repository named `collab-editor` on https://github.com/new (don't add a README).
2. In PowerShell, from this folder:
   ```
   git init
   git add .
   git commit -m "CoEdit: real-time collaborative editor"
   git branch -M main
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/collab-editor.git
   git push -u origin main
   ```
3. Open the **Actions** tab. The CI workflow runs automatically, taking about 3-5 minutes.
4. In this README, replace `YOUR_GITHUB_USERNAME` in the badge URL, then commit and push again.

**B. Deploy the live demo on Render (free)**
1. Sign up at https://render.com with your GitHub account.
2. **New → Blueprint** → select the `collab-editor` repo. Render reads `render.yaml` and creates the web service (Docker), Postgres and Key Value (Redis). Click **Apply**.
3. When the deploy turns green (the first build takes a few minutes), open the `https://….onrender.com` URL and put it in the "Live demo" line at the top of this README.
4. Free-tier caveats: the service sleeps after about 15 minutes idle (the first visit takes ~30-60 s to wake it), and the free Postgres expires after 30 days. Upgrade or recreate it before interviews. The free plan runs **one** instance. To show scaling live, raise the instance count on a paid plan: the code needs no changes, since Redis already connects the instances.

*Other hosts work too (Railway, Fly.io): provide `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` and `NODE_ENV=production`, and run the Dockerfile.*

---

## 8. Optional services: manual setup

Everything works without these. Each one switches on a feature. Put the values in `server/.env` (copy `.env.example`), and for the live demo in the Render dashboard (Environment tab).

**AI assist (free with Groq)**
1. Sign up at https://console.groq.com (free, no card), open **API Keys**, then **Create API Key**, and copy the key (it starts with `gsk_`).
2. Open `server\.env` (copied from `.env.example`) and paste it after `AI_API_KEY=`. The other AI lines are already set for Groq (`openai/gpt-oss-120b`). Restart the server and the ✨ buttons appear.
3. The free tier allows about 30 requests/min and 1,000/day. The app adds its own limit of 20 requests per user per 10 minutes.
4. Never commit or share the key: `.env` is git-ignored. On Render, paste it into the `AI_API_KEY` field.
5. To switch providers later, change `AI_BASE_URL` and `AI_MODEL` (e.g. Gemini's OpenAI-compatible endpoint), or set `AI_PROVIDER=anthropic` for Claude.

**Notification emails (SMTP)**
- Any SMTP provider works (for example Resend, Brevo or Mailtrap for testing). Set `SMTP_URL=smtp://USER:PASS@HOST:587` and `MAIL_FROM=CoEdit <you@yourdomain>`. Without it, emails are printed in the server log as `[email] …`. That's fine for demos.

**Images on S3** (otherwise they're stored in Postgres)
1. In AWS: create an S3 bucket (e.g. `coedit-uploads-yourname`) in a region such as `us-east-2`.
2. Allow public reads of the `uploads/` prefix: under *Permissions*, turn off "Block all public access" for this bucket, then add this bucket policy:
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::coedit-uploads-yourname/uploads/*" }] }
   ```
3. Add this CORS configuration so browsers can upload with the presigned URL (add your deployed URL too):
   ```json
   [{ "AllowedMethods": ["PUT"], "AllowedOrigins": ["http://localhost:5173", "https://YOUR-APP.onrender.com"], "AllowedHeaders": ["*"] }]
   ```
4. Create an IAM user with `s3:PutObject` on `arn:aws:s3:::coedit-uploads-yourname/uploads/*`, then create an access key for it.
5. Set `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Optionally set `S3_PUBLIC_URL` to a CloudFront domain.

---

## 9. Known limitations and next steps

- **Comments** aren't built yet (it was out of scope). The *commenter* role exists but currently behaves like a viewer (read-only).
- The PDF export uses the Roboto font for everything (code blocks aren't monospaced), and images from other sites can only be included if those sites allow cross-origin requests.
- Uploaded images are public to anyone who has their unguessable URL (an `<img>` tag can't send the auth header). The `/metrics` endpoints are unauthenticated.
- **Load testing** (k6 or Artillery with 200 editors) is the natural next step for resume numbers. The e2e test already prints p50 and max cross-server latency.
- JWTs are kept in `localStorage` for simplicity. A production app would use httpOnly cookies.
- `npm run cluster` uses a small Node load balancer for convenience. The Docker stack uses **nginx** (`deploy/nginx.conf`), which is what you'd run in production (WebSocket upgrade support required; sticky sessions *not* required).
