// API token helpers for programmatic clients (MCP over HTTP).
// Only a SHA-256 hash of each token is stored; the plaintext is shown once.

import { now, randomToken, hexDigest } from '../_lib.js';

const encoder = new TextEncoder();
const NAME_MAX = 100;
const SCOPES = new Set(['read', 'write']);

export function normalizeScope(value) {
  return SCOPES.has(value) ? value : 'read';
}

export async function hashApiToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return hexDigest(digest);
}

function makeToken() {
  // mdn_ + 48 hex chars of randomness
  return 'mdn_' + randomToken(24);
}

function tokenPrefix(token) {
  return token.slice(0, 11);
}

export async function createApiToken(db, name, scope) {
  const token = makeToken();
  const id = 'tok_' + randomToken(8);
  const ts = now();
  const label = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
  const normalizedScope = normalizeScope(scope);
  await db.prepare(
    'INSERT INTO api_tokens (id, name, token_hash, prefix, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, label, await hashApiToken(token), tokenPrefix(token), normalizedScope, ts).run();
  return { id, name: label, prefix: tokenPrefix(token), scope: normalizedScope, createdAt: ts, token };
}

export async function listApiTokens(db) {
  const { results } = await db.prepare(
    'SELECT id, name, prefix, scope, created_at, last_used FROM api_tokens ORDER BY created_at DESC'
  ).all();
  return results.map((r) => ({
    id: r.id,
    name: r.name || '',
    prefix: r.prefix || '',
    scope: normalizeScope(r.scope),
    createdAt: r.created_at,
    lastUsed: r.last_used == null ? null : r.last_used
  }));
}

export async function revokeApiToken(db, id) {
  await db.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
}

/**
 * Validates an `Authorization: Bearer <token>` header against the api_tokens
 * table. Returns the matching row, or null. Updates last_used on success.
 */
export async function authenticateBearer(db, request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  const row = await db.prepare(
    'SELECT id, name, scope FROM api_tokens WHERE token_hash = ?'
  ).bind(await hashApiToken(token)).first();
  if (!row) return null;

  try {
    await db.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ?').bind(now(), row.id).run();
  } catch {
    // last_used is best-effort
  }
  return { id: row.id, name: row.name, scope: normalizeScope(row.scope) };
}