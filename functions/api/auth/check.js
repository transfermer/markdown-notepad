// GET /api/auth/check  ->  whether the admin is currently logged in
import { json } from '../_lib.js';

export async function onRequest(context) {
  const cookie = context.request.headers.get('Cookie') || '';
  const m = cookie.match(/mdnote_session=([^;]+)/);
  let authed = false;
  if (m && context.env.CACHE) {
    const exists = await context.env.CACHE.get('session:' + m[1]);
    authed = !!exists;
  }
  return json({ ok: true, data: { authenticated: authed } });
}