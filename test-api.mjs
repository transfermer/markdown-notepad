// Test harness: simulates D1 + KV + env, imports the real Pages Functions onRequest handlers,
// and exercises the full API surface with fetch().
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Minimal D1 stub (in-memory)
// ---------------------------------------------------------------------------
class D1 {
  constructor() {
    this.tables = { notes: [], shares: [] };
    this.seq = 1;
  }

  async run(sql) {
    sql = sql.replace(/\s+/g, ' ').trim();
    const m = /^INSERT INTO (\w+)/.exec(sql);
    if (m) {
      const table = m[1];
      const cols = [...sql.matchAll(/\((id|title|content|created_at|updated_at|token|note_id)\)/g)].map((x) => x[1]);
      const vals = (sql.match(/VALUES \(([^)]*)\)/) || [])[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1').replace(/^'(.*)'$/, '$1').replace(/''/g, "'"));
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i] === undefined ? null : vals[i]; });
      this.tables[table].push(row);
      return { success: true };
    }
    if (/^CREATE TABLE/.test(sql)) return { success: true };
    if (/^CREATE INDEX/.test(sql)) return { success: true };
    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// Minimal KV stub
// ---------------------------------------------------------------------------
class KV {
  constructor() { this.store = new Map(); }
  async put(key, value, opts = {}) {
    this.store.set(key, { value, ts: Date.now(), ttl: opts.expirationTtl || 0 });
  }
  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.ttl && Date.now() - entry.ts > entry.ttl * 1000) { this.store.delete(key); return null; }
    return entry.value;
  }
  async delete(key) { this.store.delete(key); }
}

// ---------------------------------------------------------------------------
// Env builder
// ---------------------------------------------------------------------------
function makeEnv(overrides = {}) {
  return {
    DB: new D1Stub(),
    CACHE: new KV(),
    ADMIN_PASSWORD: 'test-admin-password',
    SESSION_SECRET: 'test-secret',
    WEBDAV_URL: '',
    WEBDAV_USERNAME: '',
    WEBDAV_PASSWORD: '',
    ...overrides
  };
}

class D1Stub {
  constructor() {
    this.notes = [];
    this.shares = [];
    this.nextId = 1;
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.bindArgs = [];
  }
  bind(...args) { this.bindArgs = args; return this; }
  async all() {
    const rows = this.db.notes.concat(this.db.shares);
    // naive filtering by WHERE clause for our queries
    if (this.sql.includes('FROM notes')) {
      let rows = [...this.db.notes];
      if (this.sql.includes('WHERE id = ?')) rows = rows.filter((r) => r.id === this.bindArgs[0]);
      if (this.sql.includes('ORDER BY updated_at DESC')) rows.sort((a, b) => b.updated_at - a.updated_at);
      return { results: rows };
    }
    if (this.sql.includes('JOIN notes')) {
      const rows = this.db.shares.map((s) => {
        const n = this.db.notes.find((x) => x.id === s.note_id);
        return { ...s, note_id: s.note_id, title: n ? n.title : null, content: n ? n.content : null, updated_at: n ? n.updated_at : s.created_at, shared_at: s.created_at };
      }).filter((r) => !this.sql.includes('WHERE s.token = ?') || r.token === this.bindArgs[0]);
      return { results: rows };
    }
    if (this.sql.includes('FROM shares') && !this.sql.includes('JOIN')) {
      let rows = [...this.db.shares];
      if (this.sql.includes('WHERE note_id = ?')) rows = rows.filter((r) => r.note_id === this.bindArgs[0]);
      return { results: rows };
    }
    return { results: [] };
  }
  async first() {
    const { results } = await this.all();
    return results.length ? results[0] : null;
  }
  async run() {
    const sql = this.sql;
    const a = this.bindArgs;
    if (sql.includes('INSERT INTO notes')) {
      this.db.notes.push({ id: a[0], title: a[1], content: a[2], created_at: a[3], updated_at: a[4] });
      return { success: true };
    }
    if (sql.includes('INSERT INTO shares')) {
      this.db.shares.push({ token: a[0], note_id: a[1], created_at: a[2] });
      return { success: true };
    }
    if (sql.includes('UPDATE notes')) {
      const n = this.db.notes.find((x) => x.id === a[3]);
      if (n) { n.title = a[0]; n.content = a[1]; n.updated_at = a[2]; }
      return { success: true };
    }
    if (sql.includes('DELETE FROM notes')) {
      const id = a[0];
      this.db.notes = this.db.notes.filter((x) => x.id !== id);
      this.db.shares = this.db.shares.filter((x) => x.note_id !== id);
      return { success: true };
    }
    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// Context builder (matches Pages Functions signature)
// ---------------------------------------------------------------------------
async function callFunction(fnPath, { method = 'GET', body, params = {}, env = env(), headers = {} } = {}) {
  const mod = await import('./functions/' + fnPath);
  const request = new Request('https://test.local' + (params && params.token ? '/s/' + params.token : ''), {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: headers.cookie || '', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return mod.onRequest({ request, env: env(), params });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function env() { return makeEnv(); }

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function main() {
  const e = env();

  // ---------- auth ----------
  const badLogin = await callFunction('api/auth/login.js', { method: 'POST', body: { password: 'wrong' }, env: () => e });
  check('login rejects wrong password', badLogin.status === 401);

  const login = await callFunction('api/auth/login.js', { method: 'POST', body: { password: 'test-admin-password' }, env: () => e });
  const setCookie = login.headers.get('set-cookie') || '';
  const token = (setCookie.match(/mdnote_session=([^;]+)/) || [])[1];
  check('login accepts correct password', login.status === 200 && !!token);

  const authedHeaders = { cookie: `mdnote_session=${token}` };

  const checkAuthed = await callFunction('api/auth/check.js', { env: () => e, headers: authedHeaders });
  const checkData = await checkAuthed.json();
  check('auth/check returns authenticated', checkData.data.authenticated === true);

  const unauthed = await callFunction('api/notes/index.js', { env: () => e });
  check('notes list requires auth', unauthed.status === 401);

  // ---------- notes ----------
  const create = await callFunction('api/notes/index.js', { method: 'POST', body: { title: 'Hello', content: '# Hi\n\n**bold**' }, env: () => e, headers: authedHeaders });
  const created = (await create.json()).data;
  check('create note', create.status === 201 && !!created.id);

  const list = await callFunction('api/notes/index.js', { env: () => e, headers: authedHeaders });
  const listData = (await list.json()).data;
  check('list notes', listData.length === 1 && listData[0].title === 'Hello');

  const get = await callFunction('api/notes/[id].js', { params: { id: created.id }, env: () => e, headers: authedHeaders });
  const got = (await get.json()).data;
  check('get note', got.content === '# Hi\n\n**bold**');

  // KV cache: subsequent GET served from KV
  await e.CACHE.put('note:' + created.id, JSON.stringify({ id: created.id, title: 'CACHED', content: 'cache-hit', createdAt: 1, updatedAt: 1 }), { expirationTtl: 60 });
  const cachedGet = await callFunction('api/notes/[id].js', { params: { id: created.id }, env: () => e, headers: authedHeaders });
  const cachedData = (await cachedGet.json()).data;
  check('KV cache serves note', cachedData.title === 'CACHED');

  // invalidate on update
  const upd = await callFunction('api/notes/[id].js', { method: 'PUT', body: { title: 'Updated', content: '# Updated content' }, params: { id: created.id }, env: () => e, headers: authedHeaders });
  check('update note', upd.status === 200);
  const afterUpd = await callFunction('api/notes/[id].js', { params: { id: created.id }, env: () => e, headers: authedHeaders });
  const afterUpdData = (await afterUpd.json()).data;
  check('cache invalidated after update', afterUpdData.title === 'Updated' && afterUpdData.content === '# Updated content');

  // ---------- share ----------
  const shareCreate = await callFunction('api/shared/index.js', { method: 'POST', body: { noteId: created.id }, env: () => e, headers: authedHeaders });
  const shareData = (await shareCreate.json()).data;
  check('create share token', shareCreate.status === 201 && !!shareData.token);

  // duplicate share returns same token
  const shareDup = await callFunction('api/shared/index.js', { method: 'POST', body: { noteId: created.id }, env: () => e, headers: authedHeaders });
  const shareDupData = (await shareDup.json()).data;
  check('share token is idempotent', shareDupData.token === shareData.token);

  const shared = await callFunction('api/shared/[token].js', { params: { token: shareData.token }, env: () => e });
  const sharedData = (await shared.json()).data;
  check('public shared note returns content', shared.status === 200 && sharedData.content === '# Updated content' && sharedData.title === 'Updated');

  // unauthenticated share read works
  const noAuthShared = await callFunction('api/shared/[token].js', { params: { token: shareData.token }, env: () => e });
  check('shared note public (no auth)', noAuthShared.status === 200);

  const badToken = await callFunction('api/shared/[token].js', { params: { token: 'nope' }, env: () => e });
  check('bad token 404', badToken.status === 404);

  // ---------- delete ----------
  const del = await callFunction('api/notes/[id].js', { method: 'DELETE', params: { id: created.id }, env: () => e, headers: authedHeaders });
  check('delete note', del.status === 200);

  const gone = await callFunction('api/notes/[id].js', { params: { id: created.id }, env: () => e, headers: authedHeaders });
  check('deleted note 404', gone.status === 404);

  const sharedGone = await callFunction('api/shared/[token].js', { params: { token: shareData.token }, env: () => e });
  check('deleted note share 404 (cascade)', sharedGone.status === 404);

  // ---------- health / webdav flag ----------
  const health = await callFunction('api/health.js', { env: () => ({ DB: e.DB, CACHE: e.CACHE, ADMIN_PASSWORD: 'x', SESSION_SECRET: '', WEBDAV_URL: 'https://dav.example.com', WEBDAV_USERNAME: 'u', WEBDAV_PASSWORD: 'p' }) });
  const healthData = (await health.json()).data;
  check('health reports webdav enabled', healthData.webdav.enabled === true);

  // logout
  const logout = await callFunction('api/auth/logout.js', { method: 'POST', env: () => e, headers: authedHeaders });
  check('logout clears session', logout.status === 200);
  const checkAfterLogout = await callFunction('api/auth/check.js', { env: () => e, headers: authedHeaders });
  const checkAfterData = (await checkAfterLogout.json()).data;
  check('auth/check false after logout', checkAfterData.authenticated === false);

  console.log('\n--- Summary ---');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    failed.forEach((f) => console.log('  FAIL:', f.name));
    process.exit(1);
  }
}

main().catch((err) => { console.error('TEST HARNESS ERROR:', err); process.exit(1); });