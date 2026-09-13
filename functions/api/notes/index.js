// GET  /api/notes          -> list notes (title + updated, cached in KV)
// POST /api/notes          -> create note
import {
  json, ok, fail, unauthorized, getEnv, now, randomId,
  kvGetJSON, kvPutJSON, invalidateNoteCache, validateAdminPassword
} from '../_lib.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
  }

  switch (context.request.method) {
    case 'GET': return handleList(context);
    case 'POST': return handleCreate(context);
    default: return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  }
}

async function handleList(context) {
  if (!(await isAuthed(context))) return unauthorized();
  const cacheKey = 'notes:list';
  const cached = await kvGetJSON(context.env.CACHE, cacheKey);
  if (cached) return ok(cached);

  const { results } = await context.env.DB.prepare(
    'SELECT id, title, created_at, updated_at FROM notes ORDER BY updated_at DESC'
  ).all();

  const data = results.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
  await kvPutJSON(context.env.CACHE, cacheKey, data, 60);
  return ok(data);
}

async function handleCreate(context) {
  if (!(await isAuthed(context))) return unauthorized();
  let body;
  try {
    body = await context.request.json();
  } catch {
    return fail('Invalid JSON body', 400, 'BAD_REQUEST');
  }
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
  const content = typeof body.content === 'string' ? body.content : '';
  const id = randomId();
  const ts = now();

  await context.env.DB.prepare(
    'INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, title || 'Untitled', content, ts, ts).run();

  await invalidateNoteCache(context.env.CACHE, id);
  const note = { id, title: title || 'Untitled', content, createdAt: ts, updatedAt: ts };
  return json({ ok: true, data: note }, 201);
}

async function isAuthed(context) {
  const cookie = context.request.headers.get('Cookie') || '';
  const m = cookie.match(/mdnote_session=([^;]+)/);
  if (!m) return false;
  if (!context.env.CACHE) return false;
  const exists = await context.env.CACHE.get('session:' + m[1]);
  return !!exists;
}