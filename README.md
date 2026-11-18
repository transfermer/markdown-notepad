# 📝 Markdown Notepad

A self-hosted, Cloudflare-deployable **markdown notepad reader & editor**.

- **Frontend:** Cloudflare Pages (static HTML/CSS/JS, `markdown-it` vendored locally)
- **API:** Cloudflare Pages Functions (serverless)
- **Storage:** Cloudflare D1 (SQLite-based, primary store)
- **Cache:** Cloudflare KV (list + note + shared-note reads, session tokens)
- **Auth:** Admin login with a password (HttpOnly session cookie)
- **Editor:** Full-height editor + live preview, markdown toolbar (headings, bold/italic, lists, links, code blocks, tables), category + tags, search, quick filters
- **AI assistant (optional):** OpenAI-compatible provider proxy with encrypted API key; actions: Improve, Rewrite, Summarize, Outline, Expand, Title, Tags, Translate, Custom
- **MCP server (remote):** Streamable HTTP JSON-RPC 2.0 with read/write scoped Bearer tokens
- **Organization:** Categories (`category`) + tags (`tags`) per note; sidebar shows categories/tags as quick tools with counts
- **Share:** Public read-only links (`/s/:token`)
- **Local export:** Every note can be downloaded as a `.md` file
- **XSS protection:** All markdown rendered through DOMPurify (vendored locally); HTML and JS are sanitized, share page escapes unsafe markup
- **WebDAV backup (optional):** Push notes to a WebDAV server via `WEBDAV_URL`

**No secrets or resource IDs are committed to this repo.** All D1/KV bindings,
passwords and WebDAV credentials live in your Cloudflare dashboard (or as
Cloudflare secrets) — see [Security](#5-security--what-goes-where).

---

## Architecture

```
Browser ──▶ Pages static site (public/)
              │
              ├── /api/*  (Pages Functions)
              │     ├── auth/login|logout|check   → session cookie (KV, rate-limited)
              │     ├── notes  (list/create)      → D1 + KV cache
              │     ├── notes/:id (get/put/del)   → D1 + KV cache + WebDAV push
              │     ├── index (categories/tags)   → D1 + KV cache
              │     ├── shared (create token)     → D1
              │     ├── shared/:token (public)    → D1 + KV cache
              │     ├── ai/config (get/put)       → provider config (key encrypted at rest)
              │     ├── ai/complete (post)        → server-side AI proxy (timeout-guarded)
              │     ├── tokens (get/post)         → MCP Bearer tokens (hash-only storage)
              │     ├── tokens/:id (delete)       → revoke token
              │     ├── mcp (post)                → remote MCP (Streamable HTTP, scoped tools)
              │     ├── backup/:id (WebDAV)       → optional
              │     └── health                     → config probe
              └── /s/:token  public share page (XSS-sanitized)
```

### Why KV?
- Note list and note reads are **identical** for every user (read-mostly workload).
- KV gives us a cheap, fast read cache in front of D1 (which bills per read).
- Invalidated (deleted) on every write, TTL `60s` as a safety net.
- Session tokens also live in KV with a 7-day TTL (no table needed).

---

## 1. Deploy with GitHub + Cloudflare Pages (recommended)

### 1.1 Push the repo to GitHub

```bash
git init
git add .
git commit -m "Markdown notepad"
git branch -M main
git remote add origin git@github.com:<you>/markdown-notepad.git
git push -u origin main
```

> `wrangler.toml` is **git-ignored** — the repo only contains
> `wrangler.toml.example` (placeholders). Real IDs stay out of git.

### 1.2 Create the Cloudflare resources (once)

```bash
npx wrangler d1 create markdown-notepad-db
npx wrangler kv namespace create MARKDOWN_NOTEPAD_KV
```

Note the returned `database_id` and KV `id` — you will paste them into the
**dashboard** in the next step (they never go into the repo).

### 1.3 Connect the repo in Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Pick `markdown-notepad` repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty — the repo is already static)*
   - **Build output directory:** `public`
4. Save & deploy — the first build will run.

> Everything under `public/` is served as static files; everything under
> `functions/` becomes serverless Functions automatically. No wrangler deploy
> command or CI secret needed for the Git flow.

### 1.4 Add bindings & secrets in the dashboard

Go to Pages → **your project** → **Settings** → **Bindings** (or **Functions**):

| Type       | Variable name | Value                          | Purpose                  |
|------------|---------------|--------------------------------|--------------------------|
| D1 binding | `DB`          | *select `markdown-notepad-db`*| note storage             |
| KV binding | `CACHE`       | *select your KV namespace*     | cache + sessions         |
| Secret     | `ADMIN_PASSWORD` | your login password         | web admin login          |
| Secret     | `SESSION_SECRET` | random string (optional)    | future signing needs     |
| Secret     | `AI_CONFIG_SECRET` | random string (recommended) | encrypt the stored AI API key |
| Var        | `AI_TIMEOUT_MS`  | e.g. `60000` (optional)     | bound each AI provider call (default 60000) |
| Secret     | `WEBDAV_URL`     | e.g. `https://dav.example.com/backup` | optional backup |
| Secret     | `WEBDAV_USERNAME`| *(if needed)*                | optional backup          |
| Secret     | `WEBDAV_PASSWORD`| *(if needed)*                | optional backup          |

The variable names **must** match what the code reads
(`context.env.DB`, `context.env.CACHE`, `context.env.ADMIN_PASSWORD`, …).
Edit → **Save** → **Redeploy** after adding bindings.

### 1.5 Initialize the remote database (once)

```bash
npx wrangler d1 execute markdown-notepad-db --remote --file=./schema.sql
```

> **Upgrading an existing install** — if your `notes` table was created before
> this version (no `category`/`tags` columns), run these once in the D1 console
> (or via `wrangler d1 execute`) after deploying:
> ```sql
> ALTER TABLE notes ADD COLUMN category TEXT NOT NULL DEFAULT '';
> ALTER TABLE notes ADD COLUMN tags    TEXT NOT NULL DEFAULT '[]';
> ```
> The `settings` and `api_tokens` tables are created automatically by
> `schema.sql` (`CREATE TABLE IF NOT EXISTS`), so no ALTER is needed for them.

### 1.6 Done 🎉

Every `git push` to `main` now redeploys automatically.
App URL: `https://<project>.pages.dev` → sign in with `ADMIN_PASSWORD`.

---

## 2. Local development

```bash
npm install
cp wrangler.toml.example wrangler.toml   # git-ignored, fill in your IDs
npx wrangler d1 execute markdown-notepad-db --local --file=./schema.sql
echo 'ADMIN_PASSWORD=dev-password' > .dev.vars   # git-ignored
npx wrangler pages dev public
```

Visit `http://localhost:8788`, sign in with `dev-password`.

> `wrangler.toml` + `.dev.vars` are git-ignored. They are **local-only** files;
> the dashboard is the source of truth for the deployed app.

---

## 3. WebDAV backup (optional)

Add the `WEBDAV_URL` / `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` secrets in the
dashboard (see 1.4). When configured:

- Every save **pushes** the note to `<WEBDAV_URL>/notes/<title>.md`.
- The UI shows `· backed up` after saving; you can also use the ☁ button.
- If the collection doesn't exist, the function attempts `MKCOL` once.
- Backup is **best-effort** — it never blocks saving; failures are shown in UI.

---

## 4. Sharing

From any note: **🔗 Share** → server creates an unguessable token (`shares` table)
→ public URL `/s/<token>`.

- Read-only, no login required, renders client-side with the same `markdown-it`.
- Shared fetches (`/api/shared/:token`) are KV-cached (60s) too.
- Deleting a note cascades to its share link (D1 FK `ON DELETE CASCADE`)
  and invalidates the share KV cache.

---

## 5. AI writing assistant (optional)

Open **Settings** in the top bar to connect any OpenAI-compatible provider
(base URL, model, API key). The key is sent once to the server, **encrypted at
rest** (PBKDF2 + AES-GCM using `AI_CONFIG_SECRET`), and never returned to the
browser — settings only expose `hasKey` and a masked preview.

Then use the **AI** button in the editor to run actions on the whole note or the
current selection: Improve, Rewrite, Summarize, Outline, Expand, Title, Tags,
Translate, or a custom instruction. Results are shown first and only applied to
the note when you press **Apply**.

- All provider calls go through the server proxy `POST /api/ai/complete`; the
  key never reaches the browser.
- The user-supplied base URL is checked against private/loopback/link-local
  ranges (SSRF guard) before any request is made.
- If `AI_CONFIG_SECRET` is unset the app falls back to `SESSION_SECRET` or
  `ADMIN_PASSWORD` for encryption, but a dedicated secret is recommended.
- Each provider call is bounded by `AI_TIMEOUT_MS` (default 60s). On timeout the
  API returns a clean `504` / `UPSTREAM_TIMEOUT` error instead of hanging until
  the edge proxy times out (`524`) — a shorter note, lower `max tokens` (capped
  at 4096), or a faster model will help. Input is capped at 12000 chars per call.

---

## 6. MCP server (remote)

`POST /api/mcp` is a remote [Model Context Protocol](https://modelcontextprotocol.io)
server over Streamable HTTP (JSON-RPC 2.0), authenticated with a Bearer token.
Each token has a **scope**: `read` (read-only tools) or `write` (read + write
tools). Create/revoke tokens (admin session required):

```bash
# create a read-only token (plaintext is returned once)
curl -X POST https://<project>.pages.dev/api/tokens \
  -H "Cookie: mdnote_session=<session>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","scope":"read"}'

# create a token that may also modify notes

curl -X POST https://<project>.pages.dev/api/tokens \
  -H "Cookie: mdnote_session=<session>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-writer","scope":"write"}'

# list tokens (metadata only)

curl https://<project>.pages.dev/api/tokens -H "Cookie: mdnote_session=<session>"

# revoke a token

curl -X DELETE https://<project>.pages.dev/api/tokens/<id> -H "Cookie: mdnote_session=<session>"
```

Point your MCP client at `https://<project>.pages.dev/api/mcp` with
`Authorization: Bearer mdn_...`. Available tools:

| Tool              | Scope | Arguments                                   | Returns                        |
|-------------------|-------|---------------------------------------------|--------------------------------|
| `list_notes`      | read  | `limit?`                                    | note metadata, newest first    |
| `get_note`        | read  | `id`                                        | full note including markdown   |
| `search_notes`    | read  | `query`, `limit?`                           | matching note metadata         |
| `list_categories` | read  | –                                           | category/tag counts            |
| `create_note`     | write | `title?`, `content?`, `category?`, `tags?`  | the created note               |
| `update_note`     | write | `id`, `title?`, `content?`, `category?`, `tags?` | the updated note          |
| `append_to_note`  | write | `id`, `text`                                | the updated note               |
| `delete_note`     | write | `id`                                        | `{ id, deleted: true }`        |

`tools/list` only advertises the tools the token is allowed to call, and a
read token receives a JSON-RPC error (`-32003`) if it tries a write tool.

Only a SHA-256 **hash** of each token is stored (`api_tokens` table); the
plaintext is shown once at creation. Prefer `read` tokens for agents that only
need to look things up.

---

## 7. Security / what goes where

| Item                          | Location                                      | In git? |
|-------------------------------|-----------------------------------------------|---------|
| D1 database id                | Dashboard → Bindings                          | ❌      |
| KV namespace id               | Dashboard → Bindings                          | ❌      |
| `ADMIN_PASSWORD`              | Dashboard → Secret (or `wrangler pages secret put`) | ❌ |
| `SESSION_SECRET`              | Dashboard → Secret                            | ❌      |
| `AI_CONFIG_SECRET`            | Dashboard → Secret                            | ❌      |
| `WEBDAV_*`                    | Dashboard → Secret                            | ❌      |
| AI provider API key           | D1 `settings` (encrypted AES-GCM)             | ❌      |
| MCP API tokens                | D1 `api_tokens` (SHA-256 hash only)           | ❌      |
| `wrangler.toml`               | local only (`cp wrangler.toml.example wrangler.toml`) | ❌ |
| `wrangler.toml.example`       | repo (placeholders only)                      | ✅      |

Other notes:

- Passwords are **never stored**; login compares against the `ADMIN_PASSWORD`
  secret with a timing-safe comparator.
- Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure`, 7-day TTL in KV.
- Share tokens are 40 hex chars from `crypto.getRandomValues`.
- Login is rate-limited in-app: 5 failed attempts within 15 minutes return `429` (`RATE_LIMITED`) per client IP. For production, also add a WAF/rate-limit rule on `/api/auth/login`.

---

## 8. API summary

| Method | Path                | Auth | Description                          |
|--------|---------------------|------|--------------------------------------|
| POST   | `/api/auth/login`   | –    | `{ password }` → session cookie      |
| POST   | `/api/auth/logout`  | ✓    | destroy session                      |
| GET    | `/api/auth/check`   | –    | `{ authenticated: bool }`            |
| GET    | `/api/notes`        | ✓    | list notes (KV-cached)               |
| POST   | `/api/notes`        | ✓    | create note                          |
| GET    | `/api/notes/:id`    | ✓    | get note (KV-cached)                 |
| PUT    | `/api/notes/:id`    | ✓    | update title/content/category/tags (+ WebDAV push) |
| DELETE | `/api/notes/:id`    | ✓    | delete note                          |
| GET    | `/api/index`        | ✓    | aggregate categories + tags (KV-cached, powers sidebar) |
| POST   | `/api/shared`       | ✓    | `{ noteId }` → `{ token }`           |
| GET    | `/api/shared/:token`| –    | public note payload (KV-cached)      |
| POST   | `/api/backup/:id`   | ✓    | manual WebDAV push                   |
| GET    | `/api/health`       | –    | service + webdav config              |
| GET    | `/api/ai/config`    | ✓    | masked AI config (`hasKey`, preview) |
| PUT    | `/api/ai/config`    | ✓    | save AI config (`clearKey` to reset) |
| POST   | `/api/ai/complete`  | ✓    | run an AI action via the server proxy |
| GET    | `/api/tokens`       | ✓    | list MCP API tokens (metadata only)  |
| POST   | `/api/tokens`       | ✓    | create a token (`scope` read/write, returned once) |
| DELETE | `/api/tokens/:id`   | ✓    | revoke a token                       |
| POST   | `/api/mcp`          | Bearer | remote MCP (JSON-RPC 2.0)          |

Auth = HttpOnly cookie `mdnote_session` verified against KV, or a Bearer API
token for `/api/mcp`.

---

## 9. Project layout

```
├── wrangler.toml.example     # TEMPLATE — placeholders only, safe to commit
├── wrangler.toml             # LOCAL ONLY (git-ignored) — your real IDs
├── .dev.vars                 # LOCAL ONLY (git-ignored) — local secrets
├── schema.sql                # D1 schema (notes, shares, settings, api_tokens)
├── public/                   # static site (Pages build output)
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── vendor/{markdown-it,dompurify}.min.js
└── functions/                # Pages Functions
    ├── api/
    │   ├── _lib.js
    │   ├── health.js
    │   ├── auth/{login,logout,check}.js
    │   ├── notes/index.js, notes/[id].js
    │   ├── index/index.js      # category/tag aggregate
    │   ├── shared/index.js, shared/[token].js
    │   ├── ai/_ai.js, ai/config.js, ai/complete.js
    │   ├── tokens/_tokens.js, tokens/index.js, tokens/[id].js
    │   ├── mcp/index.js        # remote MCP (Streamable HTTP)
    │   └── backup/[id].js
    └── s/[token].js          # public share page
```

## 10. Tests

```bash
node test-api.mjs      # 63 end-to-end API tests (auth, notes, KV cache, shares, index, AI, MCP, login rate limiting)
node test-webdav.mjs   # WebDAV backup against a local mock server
```