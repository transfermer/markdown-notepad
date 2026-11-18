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
    AI_CONFIG_SECRET: 'test-ai-secret',
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
    this.settings = [];
    this.apiTokens = [];
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
    if (this.sql.includes('FROM settings')) {
      let rows = [...this.db.settings];
      if (this.sql.includes('WHERE key = ?')) rows = rows.filter((r) => r.key === this.bindArgs[0]);
      return { results: rows };
    }
    if (this.sql.includes('FROM api_tokens')) {
      let rows = [...this.db.apiTokens];
      if (this.sql.includes('WHERE token_hash = ?')) rows = rows.filter((r) => r.token_hash === this.bindArgs[0]);
      if (this.sql.includes('WHERE id = ?')) rows = rows.filter((r) => r.id === this.bindArgs[0]);
      if (this.sql.includes('ORDER BY created_at')) rows.sort((a, b) => b.created_at - a.created_at);
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
      // (id, title, category, tags, content, created_at, updated_at)
      this.db.notes.push({ id: a[0], title: a[1], category: a[2], tags: a[3], content: a[4], created_at: a[5], updated_at: a[6] });
      return { success: true };
    }
    if (sql.includes('INSERT INTO shares')) {
      this.db.shares.push({ token: a[0], note_id: a[1], created_at: a[2] });
      return { success: true };
    }
    if (sql.includes('INSERT INTO settings')) {
      const existing = this.db.settings.find((r) => r.key === a[0]);
      if (existing) { existing.value = a[1]; existing.updated_at = a[2]; }
      else this.db.settings.push({ key: a[0], value: a[1], updated_at: a[2] });
      return { success: true };
    }
    if (sql.includes('INSERT INTO api_tokens')) {
      this.db.apiTokens.push({ id: a[0], name: a[1], token_hash: a[2], prefix: a[3], scope: a[4], created_at: a[5], last_used: null });
      return { success: true };
    }
    if (sql.includes('DELETE FROM api_tokens')) {
      const id = a[0];
      this.db.apiTokens = this.db.apiTokens.filter((x) => x.id !== id);
      return { success: true };
    }
    if (sql.includes('UPDATE api_tokens')) {
      const t = this.db.apiTokens.find((x) => x.id === a[a.length - 1]);
      if (t) t.last_used = a[0];
      return { success: true };
    }
    if (sql.includes('UPDATE notes')) {
      // (title, content, category, tags, updated_at, id)
      const n = this.db.notes.find((x) => x.id === a[5]);
      if (n) { n.title = a[0]; n.content = a[1]; n.category = a[2]; n.tags = a[3]; n.updated_at = a[4]; }
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

  // login rate limiting: MAX failures (401), then lock (429)
  let last;
  for (let i = 0; i < 5; i++) {
    last = await callFunction('api/auth/login.js', { method: 'POST', body: { password: 'wrong' }, env: () => e });
    check('login failure #' + (i + 1) + ' rejected', last.status === 401);
  }
  const locked = await callFunction('api/auth/login.js', { method: 'POST', body: { password: 'wrong' }, env: () => e });
  const lockedData = await locked.json();
  check('login locked after repeated failures', locked.status === 429 && lockedData.error.code === 'RATE_LIMITED');

  const authedHeaders = { cookie: `mdnote_session=${token}` };

  const checkAuthed = await callFunction('api/auth/check.js', { env: () => e, headers: authedHeaders });
  const checkData = await checkAuthed.json();
  check('auth/check returns authenticated', checkData.data.authenticated === true);

  const unauthed = await callFunction('api/notes/index.js', { env: () => e });
  check('notes list requires auth', unauthed.status === 401);

  // ---------- notes ----------
  const create = await callFunction('api/notes/index.js', { method: 'POST', body: { title: 'Hello', content: '# Hi\n\n**bold**', category: 'Work', tags: ['todo', 'ideas'] }, env: () => e, headers: authedHeaders });
  const created = (await create.json()).data;
  check('create note', create.status === 201 && !!created.id && created.category === 'Work' && created.tags.length === 2);

  const list = await callFunction('api/notes/index.js', { env: () => e, headers: authedHeaders });
  const listData = (await list.json()).data;
  check('list notes', listData.length === 1 && listData[0].title === 'Hello' && listData[0].category === 'Work' && listData[0].tags.join() === 'todo,ideas');

  const get = await callFunction('api/notes/[id].js', { params: { id: created.id }, env: () => e, headers: authedHeaders });
  const got = (await get.json()).data;
  check('get note', got.content === '# Hi\n\n**bold**' && got.category === 'Work' && got.tags.join() === 'todo,ideas');

  // ---------- category/tag index ----------
  const idx = await callFunction('api/index/index.js', { env: () => e, headers: authedHeaders });
  const idxData = (await idx.json()).data;
  check('index returns categories + tags', idx.status === 200 && idxData.categories.length === 1 && idxData.categories[0].name === 'Work' && idxData.tags.length === 2);

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

  // ---------- AI config ----------
  const aiUnauth = await callFunction('api/ai/config.js', { env: () => e });
  check('ai config requires auth', aiUnauth.status === 401);

  const aiDefault = await callFunction('api/ai/config.js', { env: () => e, headers: authedHeaders });
  const aiDefaultData = (await aiDefault.json()).data;
  check('ai config defaults empty', aiDefaultData.hasKey === false && aiDefaultData.baseUrl === '');

  const aiBadUrl = await callFunction('api/ai/config.js', { method: 'PUT', body: { baseUrl: 'http://127.0.0.1:8080/v1' }, env: () => e, headers: authedHeaders });
  const aiBadUrlData = await aiBadUrl.json();
  check('ai config rejects private base url', aiBadUrl.status === 400 && aiBadUrlData.error.code === 'BAD_BASE_URL');

  const aiSave = await callFunction('api/ai/config.js', { method: 'PUT', body: { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test-1234', temperature: 0.4, maxTokens: 800 }, env: () => e, headers: authedHeaders });
  const aiSaveData = (await aiSave.json()).data;
  check('ai config saves and masks key', aiSave.status === 200 && aiSaveData.hasKey === true && aiSaveData.keyPreview === '••••1234' && !('apiKey' in aiSaveData));

  const encRow = e.DB.settings.find((r) => r.key === 'ai.api_key_enc');
  check('ai key encrypted at rest', !!encRow && !encRow.value.includes('sk-test-1234'));

  // ---------- AI complete ----------
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'Improved text' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  let aiComplete;
  try {
    aiComplete = await callFunction('api/ai/complete.js', { method: 'POST', body: { action: 'improve', input: '# Hi' }, env: () => e, headers: authedHeaders });
  } finally {
    globalThis.fetch = realFetch;
  }
  const aiCompleteData = (await aiComplete.json()).data;
  check('ai complete proxies provider', aiComplete.status === 200 && aiCompleteData.text === 'Improved text' && aiCompleteData.action === 'improve');

  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'bad key' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  );
  let aiErr;
  try {
    aiErr = await callFunction('api/ai/complete.js', { method: 'POST', body: { action: 'improve', input: 'x' }, env: () => e, headers: authedHeaders });
  } finally {
    globalThis.fetch = realFetch;
  }
  const aiErrData = await aiErr.json();
  check('ai complete surfaces provider error', aiErr.status === 502 && aiErrData.error.code === 'UPSTREAM_ERROR');

  const aiBadMax = await callFunction('api/ai/config.js', { method: 'PUT', body: { maxTokens: 5000 }, env: () => e, headers: authedHeaders });
  const aiBadMaxData = await aiBadMax.json();
  check('ai config rejects maxTokens > 4096', aiBadMax.status === 400 && aiBadMaxData.error.code === 'BAD_MAX_TOKENS');

  const aiLongInput = await callFunction('api/ai/complete.js', { method: 'POST', body: { action: 'improve', input: 'x'.repeat(13000) }, env: () => e, headers: authedHeaders });
  const aiLongInputData = await aiLongInput.json();
  check('ai complete rejects overlong input', aiLongInput.status === 400 && aiLongInputData.error.code === 'INPUT_TOO_LONG');

  globalThis.fetch = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  let aiTimeout;
  try {
    aiTimeout = await callFunction('api/ai/complete.js', { method: 'POST', body: { action: 'improve', input: 'x' }, env: () => ({ ...e, AI_TIMEOUT_MS: '30' }), headers: authedHeaders });
  } finally {
    globalThis.fetch = realFetch;
  }
  const aiTimeoutData = await aiTimeout.json();
  check('ai complete times out cleanly', aiTimeout.status === 504 && aiTimeoutData.error.code === 'UPSTREAM_TIMEOUT');

  const aiClear = await callFunction('api/ai/config.js', { method: 'PUT', body: { clearKey: true }, env: () => e, headers: authedHeaders });
  check('ai config clears key', (await aiClear.json()).data.hasKey === false);

  const aiNoKey = await callFunction('api/ai/complete.js', { method: 'POST', body: { action: 'improve', input: 'x' }, env: () => e, headers: authedHeaders });
  check('ai complete requires configuration', aiNoKey.status === 400 && (await aiNoKey.json()).error.code === 'AI_NOT_CONFIGURED');

  // ---------- API tokens ----------
  const tokensUnauth = await callFunction('api/tokens/index.js', { env: () => e });
  check('tokens require auth', tokensUnauth.status === 401);

  const tokenCreate = await callFunction('api/tokens/index.js', { method: 'POST', body: { name: 'cli' }, env: () => e, headers: authedHeaders });
  const tokenData = (await tokenCreate.json()).data;
  check('create api token', tokenCreate.status === 201 && /^mdn_[0-9a-f]{48}$/.test(tokenData.token) && tokenData.prefix === tokenData.token.slice(0, 11) && tokenData.scope === 'read');
  check('token hash stored, plaintext not stored', !JSON.stringify(e.DB.apiTokens).includes(tokenData.token));

  const tokenList = await callFunction('api/tokens/index.js', { env: () => e, headers: authedHeaders });
  const tokenListData = (await tokenList.json()).data;
  check('list api tokens hides secrets', tokenListData.length === 1 && !('token' in tokenListData[0]) && !('token_hash' in tokenListData[0]));

  // ---------- MCP ----------
  const note2 = (await (await callFunction('api/notes/index.js', { method: 'POST', body: { title: 'MCP Note', content: '# MCP\n\nbody text' }, env: () => e, headers: authedHeaders })).json()).data;
  const bearer = { authorization: 'Bearer ' + tokenData.token };

  const mcpNoAuth = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'ping' }, env: () => e });
  check('mcp requires bearer token', mcpNoAuth.status === 401);

  const mcpInit = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, env: () => e, headers: bearer });
  const mcpInitData = await mcpInit.json();
  check('mcp initialize', mcpInit.status === 200 && !!mcpInitData.result.protocolVersion && mcpInitData.result.serverInfo.name === 'markdown-notepad' && !!mcpInitData.result.capabilities.tools);

  const mcpPing = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'ping' }, env: () => e, headers: bearer });
  const mcpPingData = await mcpPing.json();
  check('mcp ping', mcpPing.status === 200 && mcpPingData.result && mcpPingData.id === 2);

  const mcpTools = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 3, method: 'tools/list' }, env: () => e, headers: bearer });
  const mcpToolsData = await mcpTools.json();
  const toolNames = (mcpToolsData.result.tools || []).map((t) => t.name);
  check('mcp tools/list', mcpTools.status === 200 && toolNames.includes('list_notes') && toolNames.includes('get_note') && toolNames.includes('search_notes'));
  check('read token hides write tools', !toolNames.includes('create_note') && !toolNames.includes('delete_note'));

  const mcpWriteDenied = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'create_note', arguments: { title: 'x' } } }, env: () => e, headers: bearer });
  const mcpWriteDeniedData = await mcpWriteDenied.json();
  check('read token denied write tool', mcpWriteDeniedData.error && mcpWriteDeniedData.error.code === -32003);

  const mcpGet = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_note', arguments: { id: note2.id } } }, env: () => e, headers: bearer });
  const mcpGetData = await mcpGet.json();
  check('mcp tools/call get_note', mcpGet.status === 200 && mcpGetData.result.isError === false && mcpGetData.result.content[0].text.includes('MCP Note') && mcpGetData.result.content[0].text.includes('body text'));

  const mcpMissing = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_note', arguments: { id: 'nope' } } }, env: () => e, headers: bearer });
  const mcpMissingData = await mcpMissing.json();
  check('mcp tool error is flagged', mcpMissing.status === 200 && mcpMissingData.result.isError === true);

  const mcpNote = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', method: 'notifications/initialized' }, env: () => e, headers: bearer });
  check('mcp notification returns 202', mcpNote.status === 202);

  const mcpUnknown = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 6, method: 'nope' }, env: () => e, headers: bearer });
  const mcpUnknownData = await mcpUnknown.json();
  check('mcp unknown method', mcpUnknownData.error && mcpUnknownData.error.code === -32601);

  // ---------- MCP write tools (write-scoped token) ----------
  const writeTokenCreate = await callFunction('api/tokens/index.js', { method: 'POST', body: { name: 'writer', scope: 'write' }, env: () => e, headers: authedHeaders });
  const writeTokenData = (await writeTokenCreate.json()).data;
  check('create write token', writeTokenCreate.status === 201 && writeTokenData.scope === 'write');
  const writeBearer = { authorization: 'Bearer ' + writeTokenData.token };

  const writeTools = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 10, method: 'tools/list' }, env: () => e, headers: writeBearer });
  const writeToolNames = ((await writeTools.json()).result.tools || []).map((t) => t.name);
  check('write token sees write tools', writeToolNames.includes('create_note') && writeToolNames.includes('update_note') && writeToolNames.includes('append_to_note') && writeToolNames.includes('delete_note'));

  const mcpCreate = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'create_note', arguments: { title: 'From MCP', content: 'hello', tags: ['a', 'b'] } } }, env: () => e, headers: writeBearer });
  const mcpCreateData = await mcpCreate.json();
  const newId = JSON.parse(mcpCreateData.result.content[0].text).id;
  check('mcp create_note', mcpCreateData.result.isError === false && !!newId);

  const mcpUpdate = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'update_note', arguments: { id: newId, content: 'updated body' } } }, env: () => e, headers: writeBearer });
  const mcpUpdateData = await mcpUpdate.json();
  const updatedNote = JSON.parse(mcpUpdateData.result.content[0].text).note;
  check('mcp update_note', mcpUpdateData.result.isError === false && updatedNote.content === 'updated body' && updatedNote.title === 'From MCP');

  const mcpAppend = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'append_to_note', arguments: { id: newId, text: 'appended' } } }, env: () => e, headers: writeBearer });
  const mcpAppendData = await mcpAppend.json();
  const appendedNote = JSON.parse(mcpAppendData.result.content[0].text).note;
  check('mcp append_to_note', mcpAppendData.result.isError === false && appendedNote.content === 'updated body\n\nappended');

  const mcpDelete = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'delete_note', arguments: { id: newId } } }, env: () => e, headers: writeBearer });
  const mcpDeleteData = await mcpDelete.json();
  check('mcp delete_note', mcpDeleteData.result.isError === false && JSON.parse(mcpDeleteData.result.content[0].text).deleted === true);

  const tokenRevoke = await callFunction('api/tokens/[id].js', { method: 'DELETE', params: { id: tokenData.id }, env: () => e, headers: authedHeaders });
  check('revoke api token', tokenRevoke.status === 200);
  const writeRevoke = await callFunction('api/tokens/[id].js', { method: 'DELETE', params: { id: writeTokenData.id }, env: () => e, headers: authedHeaders });
  check('revoke write token', writeRevoke.status === 200);
  const mcpAfterRevoke = await callFunction('api/mcp/index.js', { method: 'POST', body: { jsonrpc: '2.0', id: 7, method: 'ping' }, env: () => e, headers: bearer });
  check('revoked token rejected', mcpAfterRevoke.status === 401);

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