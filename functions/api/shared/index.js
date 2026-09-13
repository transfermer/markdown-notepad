// POST /api/shared  { noteId }  ->  create a share token (or return existing)
import { ok, fail, unauthorized, json, randomToken, now, getEnv } from '../_lib.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
  }
  if (context.request.method !== 'POST') {
    return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  }
  if (!(await isAuthed(context))) return unauthorized();

  let body;
  try {
    body = await context.request.json();
  } catch {
    return fail('Invalid JSON body', 400, 'BAD_REQUEST');
  }
  const noteId = typeof body.noteId === 'string' ? body.noteId : '';
  if (!noteId) return fail('noteId is required', 400, 'BAD_REQUEST');

  // Existing token?
  const existing = await context.env.DB.prepare('SELECT token, note_id, created_at FROM shares WHERE note_id = ?').bind(noteId).first();
  if (existing) {
    return ok({ token: existing.token, createdAt: existing.created_at });
  }

  const note = await context.env.DB.prepare('SELECT id, title FROM notes WHERE id = ?').bind(noteId).first();
  if (!note) return notFound('Note not found');

  const token = randomToken(20); // 40 hex chars — unguessable
  const ts = now();
  await context.env.DB.prepare('INSERT INTO shares (token, note_id, created_at) VALUES (?, ?, ?)').bind(token, noteId, ts).run();
  return json({ ok: true, data: { token, createdAt: ts } }, 201);
}

async function notFound(msg) {
  return fail(msg, 404, 'NOT_FOUND');
}

async function isAuthed(context) {
  const cookie = context.request.headers.get('Cookie') || '';
  const m = cookie.match(/mdnote_session=([^;]+)/);
  if (!m || !context.env.CACHE) return false;
  const exists = await context.env.CACHE.get('session:' + m[1]);
  return !!exists;
}