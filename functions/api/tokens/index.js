// GET  /api/tokens -> list API tokens (metadata only, no secrets)
// POST /api/tokens -> create a token (plaintext returned once)
import { ok, json, unauthorized, methodNotAllowed, handleOptions, isAuthed } from '../_lib.js';
import { createApiToken, listApiTokens } from './_tokens.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return handleOptions();
  if (!(await isAuthed(context))) return unauthorized();

  switch (context.request.method) {
    case 'GET':
      return ok(await listApiTokens(context.env.DB));
    case 'POST': {
      let body = {};
      try {
        body = await context.request.json();
      } catch {
        body = {};
      }
      const created = await createApiToken(context.env.DB, body.name, body.scope);
      return json({ ok: true, data: created }, 201);
    }
    default:
      return methodNotAllowed();
  }
}