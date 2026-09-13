// POST /api/auth/logout  ->  clears session
import { json } from '../_lib.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  }
  const cookie = context.request.headers.get('Cookie') || '';
  const m = cookie.match(/mdnote_session=([^;]+)/);
  if (m && context.env.CACHE) {
    await context.env.CACHE.delete('session:' + m[1]).catch(() => {});
  }
  return json(
    { ok: true, data: { loggedOut: true } },
    200,
    {
      'Set-Cookie': 'mdnote_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'
    }
  );
}