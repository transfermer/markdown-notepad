# 📝 Markdown Notepad

A self-hosted, Cloudflare-deployable **markdown notepad reader & editor**.

- **Frontend:** Cloudflare Pages (static HTML/CSS/JS, `markdown-it` vendored locally)
- **API:** Cloudflare Pages Functions (serverless)
- **Storage:** Cloudflare D1 (SQLite-based, primary store)
- **Cache:** Cloudflare KV (list + note + shared-note reads, session tokens)
- **Auth:** Admin login with a password (HttpOnly session cookie)
- **Share:** Public read-only links (`/s/:token`)
- **Local export:** Every note can be downloaded as a `.md` file
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
              │     ├── auth/login|logout|check  → session cookie (KV)
              │     ├── notes  (list/create)     → D1 + KV cache
              │     ├── notes/:id (get/put/del)  → D1 + KV cache + WebDAV push
              │     ├── shared (create token)    → D1
              │     ├── shared/:token (public)   → D1 + KV cache
              │     ├── backup/:id (WebDAV)      → optional
              │     └── health                    → config probe
              └── /s/:token  public share page
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

## 5. Security / what goes where

| Item                          | Location                                      | In git? |
|-------------------------------|-----------------------------------------------|---------|
| D1 database id                | Dashboard → Bindings                          | ❌      |
| KV namespace id               | Dashboard → Bindings                          | ❌      |
| `ADMIN_PASSWORD`              | Dashboard → Secret (or `wrangler pages secret put`) | ❌ |
| `SESSION_SECRET`              | Dashboard → Secret                            | ❌      |
| `WEBDAV_*`                    | Dashboard → Secret                            | ❌      |
| `wrangler.toml`               | local only (`cp wrangler.toml.example wrangler.toml`) | ❌ |
| `wrangler.toml.example`       | repo (placeholders only)                      | ✅      |

Other notes:

- Passwords are **never stored**; login compares against the `ADMIN_PASSWORD`
  secret with a timing-safe comparator.
- Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure`, 7-day TTL in KV.
- Share tokens are 40 hex chars from `crypto.getRandomValues`.
- For a production personal notepad, add a WAF/rate-limit rule on
  `/api/auth/login`.

---

## 6. API summary

| Method | Path                | Auth | Description                          |
|--------|---------------------|------|--------------------------------------|
| POST   | `/api/auth/login`   | –    | `{ password }` → session cookie      |
| POST   | `/api/auth/logout`  | ✓    | destroy session                      |
| GET    | `/api/auth/check`   | –    | `{ authenticated: bool }`            |
| GET    | `/api/notes`        | ✓    | list notes (KV-cached)               |
| POST   | `/api/notes`        | ✓    | create note                          |
| GET    | `/api/notes/:id`    | ✓    | get note (KV-cached)                 |
| PUT    | `/api/notes/:id`    | ✓    | update title/content (+ WebDAV push) |
| DELETE | `/api/notes/:id`    | ✓    | delete note                          |
| POST   | `/api/shared`       | ✓    | `{ noteId }` → `{ token }`           |
| GET    | `/api/shared/:token`| –    | public note payload (KV-cached)      |
| POST   | `/api/backup/:id`   | ✓    | manual WebDAV push                   |
| GET    | `/api/health`       | –    | service + webdav config              |

Auth = HttpOnly cookie `mdnote_session` verified against KV.

---

## 7. Project layout

```
├── wrangler.toml.example     # TEMPLATE — placeholders only, safe to commit
├── wrangler.toml             # LOCAL ONLY (git-ignored) — your real IDs
├── .dev.vars                 # LOCAL ONLY (git-ignored) — local secrets
├── schema.sql                # D1 schema (notes, shares)
├── public/                   # static site (Pages build output)
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── vendor/markdown-it.min.js
└── functions/                # Pages Functions
    ├── api/
    │   ├── _lib.js
    │   ├── health.js
    │   ├── auth/{login,logout,check}.js
    │   ├── notes/index.js, notes/[id].js
    │   ├── shared/index.js, shared/[token].js
    │   └── backup/[id].js
    └── s/[token].js          # public share page
```

## 8. Tests

```bash
node test-api.mjs      # 21 end-to-end API tests (auth, notes, KV cache, shares)
node test-webdav.mjs   # WebDAV backup against a local mock server
```