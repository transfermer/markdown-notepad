// DELETE /api/tokens/:id -> revoke an API token
import { ok, fail, unauthorized, methodNotAllowed, handleOptions, isAuthed } from '../_lib.js';
import { revokeApiToken } from './_tokens.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return handleOptions();
  if (!(await isAuthed(context))) return unauthorized();
  if (context.request.method !== 'DELETE') return methodNotAllowed();

  const id = context.params && context.params.id;
  if (!id) return fail('Missing token id', 400, 'BAD_REQUEST');

  await revokeApiToken(context.env.DB, id);
  return ok({ id, revoked: true });
}