// Shared utilities for Pages Functions: auth, crypto, envelope, KV cache helpers.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Envelope + CORS
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

export function json(data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders,
      ...extraHeaders
    }
  });
}

export function ok(data, extraHeaders = {}) {
  return json({ ok: true, data }, 200, extraHeaders);
}

export function fail(message, status = 400, code = 'BAD_REQUEST') {
  return json({ ok: false, error: { code, message } }, status);
}

export function notFound(message = 'Not found') {
  return fail(message, 404, 'NOT_FOUND');
}

export function unauthorized(message = 'Unauthorized') {
  return fail(message, 401, 'UNAUTHORIZED');
}

export function forbidden(message = 'Forbidden') {
  return fail(message, 403, 'FORBIDDEN');
}

export function methodNotAllowed() {
  return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED');
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// ---------------------------------------------------------------------------
// Secrets / configuration
// ---------------------------------------------------------------------------

export function getEnv(env) {
  return {
    ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
    SESSION_SECRET: env.SESSION_SECRET || '',
    WEBDAV_URL: env.WEBDAV_URL || '',
    WEBDAV_USERNAME: env.WEBDAV_USERNAME || '',
    WEBDAV_PASSWORD: env.WEBDAV_PASSWORD || ''
  };
}

// ---------------------------------------------------------------------------
// Password constants (the login secret)
// ---------------------------------------------------------------------------

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;

export function validateAdminPassword(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export function randomToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomId() {
  return randomToken(9); // 18 hex chars
}

/**
 * Password hash for the admin password stored in the DB.
 * Never the plaintext — and in practice the plaintext only ever lives
 * in the ADMIN_PASSWORD secret.
 */
export async function hashPassword(password, salt) {
  const s = salt || randomToken(16);
  const data = encoder.encode(`${s}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return { salt: s, hash: hexDigest(digest) };
}

export async function verifyPassword(password, salt, expectedHash) {
  const data = encoder.encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hexDigest(digest) === expectedHash;
}

export function hexDigest(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  const A = encoder.encode(a);
  const B = encoder.encode(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Date helpers (Unix ms)
// ---------------------------------------------------------------------------

export function now() {
  return Date.now();
}

export function fmtTime(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Note metadata helpers (category + tags)
// ---------------------------------------------------------------------------

const CATEGORY_MAX = 100;
const TAG_MAX = 50;
const TAG_COUNT_MAX = 20;

export function normalizeCategory(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, CATEGORY_MAX);
}

/**
 * Accepts an array of tags or a comma/space separated string.
 * Returns a clean, deduped array of tag strings.
 */
export function normalizeTags(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(',');
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, TAG_MAX);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= TAG_COUNT_MAX) break;
  }
  return out;
}

/** Parse the text (JSON array) form used in D1 into an array. */
export function parseTagsJson(str) {
  if (Array.isArray(str)) return str;
  try {
    const a = JSON.parse(str || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// KV cache helpers
// ---------------------------------------------------------------------------

export const KV_TTL_DEFAULT = 60; // seconds

export async function kvGetJSON(kv, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(key, 'text');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function kvPutJSON(kv, key, value, ttl = KV_TTL_DEFAULT) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // cache is best-effort
  }
}

export async function kvDelete(kv, keys) {
  if (!kv) return;
  const list = Array.isArray(keys) ? keys : [keys];
  await Promise.all(
    list.map((k) => kv.delete(k).catch(() => {}))
  );
}

// Cache invalidation helpers ------------------------------------------------

export function noteCacheKeys(noteId, note = null) {
  const keys = [];
  if (noteId) {
    keys.push(`note:${noteId}`);
    if (note && note.slug) keys.push(`api:note:${note.slug}`);
    if (note && note.share_token) keys.push(`share:${note.share_token}`);
  }
  keys.push('notes:list');
  keys.push('notes:list:1');
  keys.push('notes:index');
  return [...new Set(keys)];
}

export async function invalidateNoteCache(kv, noteId, note = null) {
  await kvDelete(kv, noteCacheKeys(noteId, note));
}

// ---------------------------------------------------------------------------
// WebDAV backup (optional — enabled only when WEBDAV_URL is set)
// ---------------------------------------------------------------------------

export async function webdavBackup(env, note, fs = null) {
  if (!env.WEBDAV_URL) return { ok: false, skipped: true, reason: 'WEBDAV_URL not configured' };
  const url = env.WEBDAV_URL.replace(/\/+$/, '') + `/notes/${encodeURIComponent(note.title)}.md`;
  const auth = 'Basic ' + btoa(`${env.WEBDAV_USERNAME || ''}:${env.WEBDAV_PASSWORD || ''}`);
  const body = note.content || '';
  try {
    if (fs) {
      // Test/offline path
      await fs.writeFile(url, body, 'utf-8', auth);
    } else {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: auth,
          'Content-Type': 'text/markdown; charset=utf-8',
          Overwrite: 'T'
        },
        body
      });
      if (res.status === 404 || res.status === 409) {
        // Parent collection may not exist — try MKCOL once
        const mkcol = await fetch(url.replace(/\/[^/]+$/, ''), {
          method: 'MKCOL',
          headers: { Authorization: auth }
        });
        if (mkcol.status === 201 || mkcol.status === 405) {
          const retry = await fetch(url, {
            method: 'PUT',
            headers: {
              Authorization: auth,
              'Content-Type': 'text/markdown; charset=utf-8',
              Overwrite: 'T'
            },
            body
          });
          return { ok: retry.ok, status: retry.status };
        }
        return { ok: false, status: res.status };
      }
      return { ok: res.ok, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}