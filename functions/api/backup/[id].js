// POST /api/backup/:id  ->  push a note to WebDAV (optional feature)
import { ok, fail, unauthorized, notFound, getEnv, webdavBackup } from '../_lib.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
  }
  if (context.request.method !== 'POST') {
    return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  }
  if (!(await isAuthed(context))) return unauthorized();

  const id = context.params.id || '';
  const env = getEnv(context.env);
  if (!env.WEBDAV_URL) {
    return fail('WebDAV is not configured (WEBDAV_URL unset)', 400, 'WEBDAV_NOT_CONFIGURED');
  }

  const row = await context.env.DB.prepare(
    'SELECT id, title, content FROM notes WHERE id = ?'
  ).bind(id).first();
  if (!row) return notFound('Note not found');

  const result = await webdavBackup(env, row);
  return ok({ backedUp: result.ok, detail: result });
}