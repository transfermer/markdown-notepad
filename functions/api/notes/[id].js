// GET /api/notes/:id  -> fetch one note (KV-cached)
// PUT /api/notes/:id  -> update note content/title
// DELETE /api/notes/:id -> delete note (no share cascade needed, D1 FK handles it)
import {
  ok, fail, unauthorized, notFound, kvGetJSON, kvPutJSON,
  invalidateNoteCache, now, getEnv, webdavBackup
} from '../_lib.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
  }
  const id = context.params.id || '';

  switch (context.request.method) {
    case 'GET': return handleGet(context, id);
    case 'PUT': return handlePut(context, id);
    case 'DELETE': return handleDelete(context, id);
    default: return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  }
}

async function handleGet(context, id) {
  if (!(await isAuthed(context))) return unauthorized();
  const cacheKey = `note:${id}`;
  const cached = await kvGetJSON(context.env.CACHE, cacheKey);
  if (cached) return ok(cached);

  const { results } = await context.env.DB.prepare(
    'SELECT id, title, content, created_at, updated_at FROM notes WHERE id = ?'
  ).bind(id).all();

  if (!results || results.length === 0) return notFound('Note not found');

  const row = results[0];
  const note = {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  await kvPutJSON(context.env.CACHE, cacheKey, note, 60);
  return ok(note);
}

async function handlePut(context, id) {
  if (!(await isAuthed(context))) return unauthorized();
  let body;
  try {
    body = await context.request.json();
  } catch {
    return fail('Invalid JSON body', 400, 'BAD_REQUEST');
  }
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : undefined;
  const content = typeof body.content === 'string' ? body.content : undefined;
  if (title === undefined && content === undefined) {
    return fail('Nothing to update', 400, 'BAD_REQUEST');
  }
  const ts = now();

  const existing = await context.env.DB.prepare(
    'SELECT id, title, content, created_at FROM notes WHERE id = ?'
  ).bind(id).first();
  if (!existing) return notFound('Note not found');

  const newTitle = title === undefined ? existing.title : title;
  const newContent = content === undefined ? existing.content : content;

  await context.env.DB.prepare(
    'UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?'
  ).bind(newTitle, newContent, ts, id).run();

  // Capture share token so the public share cache is invalidated too.
  const shareRow = await context.env.DB.prepare('SELECT token FROM shares WHERE note_id = ?').bind(id).first();

  const note = {
    id,
    title: newTitle,
    content: newContent,
    createdAt: existing.created_at,
    updatedAt: ts
  };

  await invalidateNoteCache(context.env.CACHE, id, { slug: undefined, share_token: shareRow ? shareRow.token : null });
  await kvPutJSON(context.env.CACHE, `note:${id}`, note, 60);

  // Optional WebDAV backup (enabled only if WEBDAV_URL is set)
  const env = getEnv(context.env);
  let backup = null;
  try {
    backup = await webdavBackup(env, note);
  } catch {
    backup = { ok: false, error: 'backup_failed' };
  }

  return ok({ note, backup });
}

async function handleDelete(context, id) {
  if (!(await isAuthed(context))) return unauthorized();
  const row = await context.env.DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first();
  if (!row) return notFound('Note not found');

  // Capture the share token before deleting so we can invalidate its KV cache too.
  const shareRow = await context.env.DB.prepare('SELECT token FROM shares WHERE note_id = ?').bind(id).first();

  await context.env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  await invalidateNoteCache(context.env.CACHE, id, { share_token: shareRow ? shareRow.token : null });
  return ok({ id, deleted: true });
}

async function isAuthed(context) {
  const cookie = context.request.headers.get('Cookie') || '';
  const m = cookie.match(/mdnote_session=([^;]+)/);
  if (!m || !context.env.CACHE) return false;
  const exists = await context.env.CACHE.get('session:' + m[1]);
  return !!exists;
}