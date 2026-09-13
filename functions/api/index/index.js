// GET /api/index  ->  aggregate categories + tags for the sidebar (KV-cached 60s)
import {
  ok, fail, unauthorized, kvGetJSON, kvPutJSON, parseTagsJson, normalizeCategory
} from '../_lib.js';

const CACHE_KEY = 'notes:index';

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
  }
  if (!(await isAuthed(context))) return unauthorized();

  const cached = await kvGetJSON(context.env.CACHE, CACHE_KEY);
  if (cached) return ok(cached);

  const { results } = await context.env.DB.prepare(
    'SELECT category, tags FROM notes'
  ).all();

  const catCount = new Map();
  const tagCount = new Map();
  for (const r of results || []) {
    const c = normalizeCategory(r.category);
    if (c) catCount.set(c, (catCount.get(c) || 0) + 1);
    for (const t of parseTagsJson(r.tags)) {
      if (t) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
  }

  const data = {
    categories: [...catCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    tags: [...tagCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    updatedAt: Date.now()
  };

  await kvPutJSON(context.env.CACHE, CACHE_KEY, data, 60);
  return ok(data);
}

async function isAuthed(context) {
  const cookie = context.request.headers.get('Cookie') || '';
  const m = cookie.match(/mdnote_session=([^;]+)/);
  if (!m || !context.env.CACHE) return false;
  const exists = await context.env.CACHE.get('session:' + m[1]);
  return !!exists;
}