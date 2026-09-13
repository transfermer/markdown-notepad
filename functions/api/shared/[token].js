// GET /api/shared/:token  ->  public read-only info for a shared note (KV-cached).
// Returns RAW markdown (not HTML) so the client can render it with markdown-it.
import { ok, fail, notFound, kvGetJSON, kvPutJSON } from '../_lib.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
  }
  if (context.request.method !== 'GET') {
    return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  }
  const token = (context.params.token || '').trim();
  if (!token) return fail('Missing token', 400, 'BAD_REQUEST');

  const cacheKey = `share:${token}`;
  const cached = await kvGetJSON(context.env.CACHE, cacheKey);
  if (cached) return ok(cached);

  const row = await context.env.DB.prepare(
    `SELECT n.id AS note_id, n.title, n.content, n.updated_at, s.created_at AS shared_at
     FROM shares s JOIN notes n ON n.id = s.note_id
     WHERE s.token = ?`
  ).bind(token).first();

  if (!row) return notFound('Shared note not found');

  const data = {
    token,
    noteId: row.note_id,
    title: row.title,
    content: row.content, // raw markdown
    updatedAt: row.updated_at,
    sharedAt: row.shared_at
  };
  await kvPutJSON(context.env.CACHE, cacheKey, data, 60);
  return ok(data);
}